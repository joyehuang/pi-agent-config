#!/usr/bin/env python3
"""
pi-search — 本地会话全文检索（SQLite FTS5 + LLM 查询扩展）

索引 ~/.pi/agent/sessions/*.jsonl，支持增量更新与关键词搜索。
可选 --expand 用 qwen-flash 把模糊提问扩展成多关键词再检索。

用法:
  pi-search index                      # 增量重建索引（跳过未变文件）
  pi-search search <关键词>            # 搜索（默认最近 30 条）
  pi-search search <kw> --expand       # LLM 扩展后搜索（模糊提问用这个）
  pi-search search <kw> --limit 10
  pi-search stats                      # 索引统计
  pi-search open <session_id>          # 打印会话文件路径
"""
import argparse
import json
import math
import os
import re
import sqlite3
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

SESSIONS_DIR = Path.home() / ".pi" / "agent" / "sessions"
INDEX_DIR = Path.home() / ".local" / "share" / "pi-search"
INDEX_DB = INDEX_DIR / "index.db"
EXPAND_CONFIG = Path.home() / ".config" / "pi-search" / "llm.env"

MAX_TEXT = 20000          # 单块最大索引字符
MAX_RESULT = 400          # toolResult 输出截断
EXPAND_MODEL = "qwen-flash"

# 泛词表：出现面太广的词不参与稀有度排序（中文 + 英文常见泛词）
STOPWORDS_ALL = {
    "工具", "系统", "软件", "那个", "链接", "报告", "发布", "怎么", "什么", "一个", "了解", "然后", "可以", "看看", "项目", "东西", "问题", "一下", "这个", "需要", "时候",
    "top", "link", "report", "monitor", "check", "system", "tool", "model", "use", "open", "make", "show", "run", "start", "new", "time", "data", "code", "api", "work", "file", "test", "config", "setup", "install", "build", "search", "result",
    "first", "chat", "feed", "paper", "script", "auto", "daily", "track", "class", "plan", "connection", "management", "storage", "存储",
}

# ── LLM 查询扩展 ──────────────────────────────────────────────

def load_dashscope():
    """读取检索专用 key/base（0600）；不依赖已卸载的多模态插件。"""
    key = os.environ.get("DASHSCOPE_API_KEY")
    base = os.environ.get("DASHSCOPE_BASE_URL")
    if EXPAND_CONFIG.exists():
        for line in EXPAND_CONFIG.read_text().splitlines():
            m = re.match(r"\s*([A-Z_]+)=(.*)$", line)
            if not m:
                continue
            if m.group(1) == "DASHSCOPE_API_KEY" and not key:
                key = m.group(2).strip()
            elif m.group(1) == "DASHSCOPE_BASE_URL" and not base:
                base = m.group(2).strip()
    return key, base

def expand_query(q: str, db) -> list:
    """用 qwen-flash 把模糊提问扩展成检索关键词列表，带 sqlite 缓存。"""
    row = db.execute("SELECT keywords FROM expansions WHERE query=?", (q,)).fetchone()
    if row:
        return json.loads(row[0])
    key, base = load_dashscope()
    if not key or not base:
        return []
    prompt = (
        "你是会话检索助手。用户的历史对话检索提问可能很模糊、口语化、缺词。"
        "请把它改写成一组检索关键词，要求：\n"
        "1. 每个词 2-12 个字符，是独立检索词（中文词/专名/文件名/工具名）\n"
        "2. 优先用提问里出现过的实词，再补充可能出现在原文里的同义说法\n"
        "3. 中文提问必须同时给出对应的英文术语/专名（如 监控→monitor、报告→report、链接→link）\n"
        "4. 只输出 3-10 个词，不要输出完整句子、不要英文长短语、不要泛化词汇（如 annual report/white paper）\n"
        "只输出 JSON 字符串数组，不要任何其他文字。\n提问: " + q
    )
    body = json.dumps({
        "model": EXPAND_MODEL,
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": 300,
        "temperature": 0.2,
    }).encode()
    req = urllib.request.Request(
        base.rstrip("/") + "/chat/completions",
        data=body,
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            data = json.loads(r.read().decode())
        content = data["choices"][0]["message"]["content"].strip()
        # 提取 JSON 数组（容忍 ```json 包裹）
        m = re.search(r"\[.*\]", content, re.S)
        kws = json.loads(m.group(0)) if m else []
        kws = [k.strip() for k in kws if k and k.strip()]
        db.execute("INSERT OR REPLACE INTO expansions(query, keywords, created) VALUES(?,?,?)",
                   (q, json.dumps(kws), datetime.now(timezone.utc).isoformat()))
        db.commit()
        return kws
    except Exception as e:
        print(f"[pi-search] LLM 扩展失败，退回原词: {e}", file=sys.stderr)
        return []

# ── 索引 ──────────────────────────────────────────────────────

def connect():
    INDEX_DIR.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(INDEX_DB)
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("""CREATE TABLE IF NOT EXISTS sessions(
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        title TEXT,
        cwd TEXT,
        started TEXT,
        updated TEXT,
        mtime REAL NOT NULL,
        size INTEGER NOT NULL,
        preview TEXT,
        transcript TEXT
    )""")
    db.execute("""CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(
        id UNINDEXED, role, kind, text, session_id UNINDEXED, ts
    )""")
    db.execute("""CREATE TABLE IF NOT EXISTS expansions(
        query TEXT PRIMARY KEY, keywords TEXT, created TEXT
    )""")
    return db

def session_meta(path: Path):
    """从 jsonl 提取会话元信息 + 完整可检索文本。"""
    session_id = None
    cwd = None
    started = None
    parts = []  # (role, kind, text)
    with open(path, encoding="utf-8", errors="replace") as f:
        for line in f:
            try:
                d = json.loads(line)
            except Exception:
                continue
            t = d.get("type")
            if t == "session":
                session_id = d.get("id")
                cwd = d.get("cwd")
                started = d.get("timestamp")
            elif t == "message":
                m = d.get("message", {})
                role = m.get("role", "?")
                ts = m.get("timestamp") or d.get("timestamp")
                content = m.get("content")
                if isinstance(content, str):
                    parts.append((role, "text", content, ts))
                elif isinstance(content, list):
                    for b in content:
                        if not isinstance(b, dict):
                            continue
                        bt = b.get("type", "?")
                        if bt == "text":
                            parts.append((role, "text", b.get("text", ""), ts))
                        elif bt == "thinking":
                            parts.append((role, "thinking", b.get("text", ""), ts))
                        elif bt == "toolCall":
                            name = b.get("name", "")
                            args = b.get("arguments") or b.get("input") or {}
                            if isinstance(args, dict):
                                cmd = args.get("command") or args.get("path") or args.get("url") or ""
                                brief = f"{name} {cmd}"[:500]
                            else:
                                brief = f"{name} {args}"[:500]
                            parts.append((role, "toolCall", brief, ts))
                        elif bt == "toolResult":
                            raw = b.get("content") or b.get("output") or b.get("text") or ""
                            if isinstance(raw, list):
                                raw = " ".join(str(x.get("text", "")) for x in raw if isinstance(x, dict))
                            parts.append((role, "toolResult", str(raw)[:MAX_RESULT], ts))
            elif t == "model_change":
                pass
    return session_id, cwd, started, parts

def index_one(db, path: Path):
    """索引单个会话文件，返回 (id, changed)。"""
    session_id, cwd, started, parts = session_meta(path)
    if not session_id:
        return None, False
    st = path.stat()
    row = db.execute("SELECT mtime, size FROM sessions WHERE id=?", (session_id,)).fetchone()
    if row and abs(row[0] - st.st_mtime) < 1e-6 and row[1] == st.st_size:
        return session_id, False
    transcript = "\n".join(t for _, _, t, _ in parts if t)
    preview = transcript[:400].replace("\n", " ")
    db.execute("""INSERT INTO sessions(id, path, cwd, started, updated, mtime, size, preview, transcript)
                  VALUES(?,?,?,?,?,?,?,?,?)
                  ON CONFLICT(id) DO UPDATE SET path=excluded.path, cwd=excluded.cwd,
                    started=excluded.started, updated=excluded.updated, mtime=excluded.mtime,
                    size=excluded.size, preview=excluded.preview, transcript=excluded.transcript""",
               (session_id, str(path), cwd, started,
                datetime.now(timezone.utc).isoformat(), st.st_mtime, st.st_size, preview, transcript))
    db.execute("DELETE FROM fts WHERE session_id=?", (session_id,))
    db.executemany("INSERT INTO fts(id, role, kind, text, session_id, ts) VALUES(?,?,?,?,?,?)",
                   [(f"{session_id}:{i}", r, k, t[:MAX_TEXT], session_id, ts) for i, (r, k, t, ts) in enumerate(parts)])
    return session_id, True

def cmd_index(args):
    db = connect()
    files = sorted(SESSIONS_DIR.glob("*/**/*.jsonl"))
    if not files:
        files = sorted(SESSIONS_DIR.glob("**/*.jsonl"))
    indexed, changed = 0, 0
    for p in files:
        sid, ch = index_one(db, p)
        if sid:
            indexed += 1
            changed += ch
    db.execute("DELETE FROM sessions WHERE path NOT IN ({})".format(
        ",".join("?" * len(files))), [str(p) for p in files])
    db.execute("DELETE FROM fts WHERE session_id NOT IN (SELECT id FROM sessions)")
    db.commit()
    print(f"indexed {indexed} sessions ({changed} changed), db: {INDEX_DB}")

# ── 检索 ──────────────────────────────────────────────────────

def match_keyword(db, kw, limit):
    """单个关键词检索：FTS5 MATCH（引号短语）优先，失败 LIKE 兜底。"""
    quoted = '"' + kw.replace('"', '""') + '"'
    try:
        return db.execute("""
            SELECT f.session_id, s.started, s.cwd, f.role, f.kind, f.text
            FROM fts f JOIN sessions s ON s.id = f.session_id
            WHERE fts MATCH ?
            ORDER BY f.rowid DESC LIMIT ?
        """, (quoted, limit)).fetchall()
    except sqlite3.OperationalError:
        return db.execute("""
            SELECT f.session_id, s.started, s.cwd, f.role, f.kind, f.text
            FROM fts f JOIN sessions s ON s.id = f.session_id
            WHERE f.text LIKE ?
            ORDER BY f.rowid DESC LIMIT ?
        """, (f"%{kw}%", limit)).fetchall()

def show_results(rows, q, limit, tokens=None, orig_tokens=None):
    """按会话聚合输出。真 IDF 排序：稀有词主导，原词优先，扩展词降权。"""
    if not rows:
        print("无结果")
        return
    # 总会话数（用于 IDF 分母）
    n_sessions = 0
    try:
        from sqlite3 import connect as _c
    except Exception:
        pass
    # tokens: 全部检索词；orig_tokens: 原提问中的词（非扩展）
    tokens = tokens or [q]
    orig_tokens = orig_tokens or tokens
    # 统计每个 token 的出现会话数（稀有度）
    tok_sessions = {}
    for sid, started, cwd, role, kind, text in rows:
        for tok in tokens:
            if tok.lower() in text.lower():
                tok_sessions.setdefault(tok, set()).add(sid)
    # 泛词表：出现面太广的词权重压到 1（中文 + 英文常见泛词）
    stopwords = STOPWORDS_ALL
    # 权重策略：
    # - 原词命中：IDF × 3.0（决定性，先按它排序）
    # - 扩展词命中：不独立计分，只对已命中原词的会话 +0.3 boost（召回补充）
    # - 泛词（stopword）：只给 0.05 避免霸榜
    def tok_weight(tok, is_orig):
        tl = tok.lower()
        if tl in stopwords:
            return 0.05
        df = len(tok_sessions.get(tok, set()))
        if df <= 0:
            df = 1
        n_est = max(n_sessions, df + 5)
        idf = math.log(1 + n_est / df)
        return idf * 3.0 if is_orig else 0.3
    agg = {}  # session_id -> {started, cwd, kws: {tok: weight}, score, orig_score, snip}
    for sid, started, cwd, role, kind, text in rows:
        a = agg.setdefault(sid, {"started": started, "cwd": cwd, "kws": {}, "score": 0.0, "orig_score": 0.0, "snip": None})
        for tok in tokens:
            if tok.lower() in text.lower():
                w = tok_weight(tok, tok in orig_tokens)
                a["kws"][tok] = max(a["kws"].get(tok, 0), w)
                if tok in orig_tokens:
                    a["orig_score"] += w
                else:
                    a["score"] += w  # 扩展词 boost 单独累计
        if a["snip"] is None:
            a["snip"] = (role, kind, text)
    # 排序：先按原词 IDF 总分（决定性），再按扩展词 boost，再同分时间新
    def score(kv):
        sid, a = kv
        return (a["orig_score"], a["score"], len(a["kws"]), len(a["started"] or ""))
    ordered = sorted(agg.items(), key=score, reverse=True)
    for sid, a in ordered[:limit]:
        role, kind, text = a["snip"]
        # 找最稀有的命中 token 做上下文锚点（原词优先）
        anchor = min(a["kws"], key=lambda t: tok_weight(t, t in orig_tokens))
        idx = text.lower().find(anchor.lower())
        ctx = text[max(0, idx - 100):idx + 200] if idx >= 0 else text[:200]
        ctx = ctx.replace("\n", " ")
        t = (a["started"] or "")[:16].replace("T", " ")
        print(f"── {sid}  [{t}]  cwd={a['cwd'] or '?'}  hits={sorted(a['kws'])}")
        print(f"   [{role}/{kind}] …{ctx}…")

def cmd_search(args):
    db = connect()
    if db.execute("SELECT count(*) FROM fts").fetchone()[0] == 0:
        print("索引为空，先运行: pi-search index", file=sys.stderr)
        sys.exit(1)
    q = args.query.strip()
    keywords = [q]
    expanded = []
    if args.expand:
        ext = expand_query(q, db)
        if ext:
            keywords = [q] + [k for k in ext if k and k != q]
            expanded = [k for k in ext if k and k != q]
            print(f"[pi-search] 扩展: {q} → {keywords}", file=sys.stderr)
    per_kw = 200  # 每个词多召回，交给聚合排序
    all_rows = []
    # 拆 token：英文按空白/标点拆，中文整词保留（不逐字拆）
    def split_tokens(kw):
        toks = []
        # 英文/数字串拆开，中文整段保留
        for part in re.split(r"([A-Za-z0-9_\-]+)", kw):
            if re.fullmatch(r"[A-Za-z0-9_\-]+", part):
                # 英文按常见分隔拆
                for t in re.split(r"[\s_\-]+", part):
                    if t: toks.append(t)
            else:
                if part.strip():
                    toks.append(part.strip())
        return toks
    orig_tokens = []
    for tok in split_tokens(q):
        if tok and tok not in orig_tokens:
            orig_tokens.append(tok)
    tokens = list(orig_tokens)
    # 扩展词过滤：去掉泛词（不参与召回，避免污染）
    for kw in expanded:
        for tok in split_tokens(kw):
            if tok and tok not in tokens and tok.lower() not in STOPWORDS_ALL:
                tokens.append(tok)
    for tok in tokens:
        all_rows.extend(match_keyword(db, tok, per_kw))
    show_results(all_rows, q, args.limit, tokens, orig_tokens)

def cmd_stats(args):
    db = connect()
    n_s = db.execute("SELECT count(*) FROM sessions").fetchone()[0]
    n_f = db.execute("SELECT count(*) FROM fts").fetchone()[0]
    n_e = db.execute("SELECT count(*) FROM expansions").fetchone()[0]
    size = INDEX_DB.stat().st_size if INDEX_DB.exists() else 0
    print(f"sessions: {n_s}, fts rows: {n_f}, expansions: {n_e}, db size: {size/1024:.0f} KB")

def cmd_open(args):
    db = connect()
    row = db.execute("SELECT path FROM sessions WHERE id=?", (args.id,)).fetchone()
    print(row[0] if row else "not found")

def main():
    ap = argparse.ArgumentParser(description="pi 会话全文检索（FTS5 + LLM 扩展）")
    sub = ap.add_subparsers(dest="cmd")
    sub.add_parser("index")
    p = sub.add_parser("search")
    p.add_argument("query")
    p.add_argument("--limit", type=int, default=30)
    p.add_argument("--expand", action="store_true", help="用 LLM 扩展模糊提问后再检索")
    sub.add_parser("stats")
    p = sub.add_parser("open")
    p.add_argument("id")
    args = ap.parse_args()
    if args.cmd == "index": cmd_index(args)
    elif args.cmd == "search": cmd_search(args)
    elif args.cmd == "stats": cmd_stats(args)
    elif args.cmd == "open": cmd_open(args)
    else: ap.print_help()

if __name__ == "__main__":
    main()
