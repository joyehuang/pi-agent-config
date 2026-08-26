#!/Users/joye/.mem0/venv/bin/python
"""mem0 CLI：add / search / list 统一入口（供 pi 扩展 child_process 调用）

用法:
  mem0-cli.py add "内容"
  mem0-cli.py search "查询" [N]
  mem0-cli.py list
"""
import json
import sys
from pathlib import Path

CONFIG_PATH = Path.home() / ".mem0" / "config" / "config.json"
DEFAULT_USER = "joye"

def get_memory():
    from mem0 import Memory
    cfg = json.loads(CONFIG_PATH.read_text())
    return Memory.from_config(config_dict=cfg)

def main():
    cmd = sys.argv[1]
    if cmd == "add":
        content = sys.argv[2]
        m = get_memory()
        res = m.add(content, user_id=DEFAULT_USER)
        ids = [r.get("id", "")[:8] for r in res.get("results", [])]
        print(f"OK {ids}")
    elif cmd == "search":
        query = sys.argv[2]
        limit = int(sys.argv[3]) if len(sys.argv) > 3 else 5
        m = get_memory()
        res = m.search(query, filters={"user_id": DEFAULT_USER}, limit=limit)
        items = res.get("results", [])
        if not items:
            print("（无相关记忆）")
            return
        for it in items:
            ts = it.get("created_at") or ""
            if ts:
                # ISO 时间戳 → 本地日期（YYYY-MM-DD），召回时展示新旧
                ts = str(ts)[:10]
            print(f"[{it.get('id','')[:8]}] (score={it.get('score',0):.2f}, date={ts}) {it.get('memory','')}")
    elif cmd == "list":
        m = get_memory()
        res = m.get_all(filters={"user_id": DEFAULT_USER}, top_k=100)
        items = res.get("results", [])
        if not items:
            print("（无记忆）")
            return
        for it in items:
            print(f"[{it.get('id','')[:8]}] {it.get('memory','')}")
    else:
        print("unknown command", file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    main()
