// mem0-autosediment — agent_end 时自动把值得沉淀的事实写入 mem0。
//
// 背景（2026-08-24）：mem0 自觉路线失败（10 天仅 3 次 memory_search，agent 基本不主动调 memory_add）。
// 用户决策：上 hooks —— agent_end 自动沉淀。
//
// v2（2026-08-26）：写入侧升级，落实 8-26 讨论共识：
//   1. **删除 60s 限流** —— 每轮 agent_end 都尝试沉淀，去重只靠「同一 session + 同一消息 hash」。
//      （用户 8-26 明确拍板："60 秒限流可以删掉，确实需要在每轮 Agent end 都尝试去沉淀记忆"）
//   2. **quote 引用提取** —— 用户消息里的 `[reply|from:...]` 标记是 Telegram 引用回复的元信息，
//      被引用的完整文本是用户真正想记的内容（例：用户 quote 一条 PersonaMem-v3 结论说"记一下"，
//      值得记的是被引用的结论而不是"记一下"三个字）。提取后拼进写入内容，且放在用户原话之前。
//   3. 保留消息内容 hash 去重（防 agent_end 因重试/auto-compact 重复触发写入同一消息）。
//   4. 过滤放宽：<20 字符不再一刀切，只滤纯指令/寒暄/感谢。
//   5. **「已记忆」独立反馈（v2.1）** —— 写入成功后立即通过 ~/bin/notify-telegram.py 发一条
//      独立 Telegram 消息确认（不依赖下一轮回复；会话不连续时也能即时看到）。
//      用户 8-26 明确要求："不要在下一轮回复，可以单独一条类似 system message 一样的"。
//
// 实现：在 agent_end 时，把本次 run 的 messages 里「用户消息」提取出来，用 mem0-cli add 写入。
// 通过 child_process 调 ~/bin/mem0-cli.py（独立进程，避免阻塞 pi 事件循环）。
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

const MEM0_CLI = `${process.env.HOME}/bin/mem0-cli.py`;
const NOTIFY = `${process.env.HOME}/bin/notify-telegram.py`;
const AUTOSED_LOG = `/tmp/autosediment.log`;
// 防抖：同一 session 文件最近一次沉淀的 key（消息内容 hash）
let lastWrite = { sessionFile: "", msgHash: "" };

// autosediment 自身日志（每次 agent_end 写入判定都留痕，便于查"该发没发"）
function autosedLog(msg: string) {
  try {
    const { appendFileSync } = require("node:fs");
    appendFileSync(AUTOSED_LOG, `[${new Date().toISOString()}] ${msg}\n`);
  } catch {
    // 静默
  }
}

// 写入成功 → 独立 Telegram 消息确认（system-message 风格，不占下一轮回复）
// v2.2（2026-08-26）：不再硬截 60 字符——用户 quote 的引用内容常被截得看不懂。
// 改为完整内容（Telegram 单条上限 4096），仅当极端超长（>900）才截断并带明确提示。
//
// v2.3（2026-08-26）：LLM 过滤层 —— 用户拍板"交给 LLM 过滤一遍"（因 8-26 误沉淀了
// 一次性问答"agent_end hook是算作兜底处理吗？"，污染召回）。
// 每轮候选消息先发给 Command Code 的 Qwen/Qwen3.7-Plus 判定：
//   1. 是否值得沉淀（区分稳定事实 vs 一次性问答/过程讨论/寒暄）
//   2. 若值得，顺手提炼成第三人称陈述句（memory），写入时用提炼版而非原文
// 失败降级：LLM 不可用/超时/解析失败 → 跳过不存（宁可少记不漏记，避免过程性内容污染召回），
// 日志留痕。成本：每轮一次 ~200 token 小调用（Qwen3.7-Plus 极便宜）。
const CC_BASE = "https://api.commandcode.ai/provider/v1";
const CC_MODEL = "Qwen/Qwen3.7-Plus";

function loadCcKey(): string {
  try {
    const { readFileSync } = require("node:fs");
    return readFileSync(`${process.env.HOME}/.config/cmd-code/key`, "utf8").trim();
  } catch {
    return "";
  }
}

const FILTER_SYSTEM = `你是长期记忆筛选器。用户在跟 AI agent 的对话中说了下面这句话，请判断它是否值得存入长期记忆。

值得记（should_save=true）：
- 用户身份/背景/喜好等稳定事实（生日、爱好、追的队伍、居住地、工作经历）
- 用户偏好与沟通风格（排版、格式、语气要求）
- 技术决策与理由（"以后X都用Y""改为Z因为W"）
- 踩坑经验/技术结论（具体路径、命令、报错、教训）
- 用户明确要求记住的内容（"记住X""记一下"）

不值得记（should_save=false）：
- 一次性问答/概念澄清（"X是什么？""X是不是Y？"）
- 寒暄/确认/纯指令（"好的""继续""看看"）
- 过程性讨论/临时状态（"我在想""待定""下一步做X"）
- 对刚才回复的普通回应，不包含新的稳定事实

只输出 JSON（不要输出其他文字）：{"should_save": true或false, "memory": "提炼后的陈述句（第三人称、含主语与日期；若 should_save=false 则为空串）", "reason": "一句话理由"}`;

function filterWithLLM(text: string): Promise<{ save: boolean; memory: string; reason: string }> {
  const key = loadCcKey();
  if (!key) return Promise.resolve({ save: false, memory: "", reason: "无 CC key，降级不写入" });
  const body = {
    model: CC_MODEL,
    messages: [
      { role: "system", content: FILTER_SYSTEM },
      { role: "user", content: text },
    ],
    temperature: 0,
    max_tokens: 300,
  };
  return fetch(`${CC_BASE}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  })
    .then((r) => r.json())
    .then((j) => {
      const raw = j?.choices?.[0]?.message?.content ?? "";
      const m = raw.match(/\{[\s\S]*\}/);
      if (!m) throw new Error("no JSON in response");
      const parsed = JSON.parse(m[0]);
      const save = !!parsed.should_save;
      const memory = typeof parsed.memory === "string" && parsed.memory.trim() ? parsed.memory.trim() : text;
      const reason = typeof parsed.reason === "string" ? parsed.reason : "";
      return { save, memory, reason };
    })
    .catch((e) => {
      autosedLog(`LLM 过滤失败，降级不写入: ${String(e).slice(0, 120)}`);
      return { save: false, memory: "", reason: "LLM 失败降级，宁可少记不漏记" };
    });
}
function notifyMemorized(content: string) {
  try {
    const oneLine = content.replace(/\n+/g, " ").trim();
    const full = oneLine.length > 900 ? oneLine.slice(0, 900) + "…（内容过长已截断）" : oneLine;
    const msg = `🧠 已记忆：${full}`;
    const child = spawn(NOTIFY, [msg], { stdio: ["ignore", "ignore", "ignore"] });
    // 10s 超时兜底，不阻塞主流程
    const timer = setTimeout(() => child.kill(), 10000);
    child.on("close", () => clearTimeout(timer));
    child.on("error", () => clearTimeout(timer));
  } catch {
    // 静默失败
  }
}

// Telegram 引用回复标记：[reply|from:名字] 被引用的完整文本
// 提取被引用内容并拼进写入文本（被引用的是用户真正想记的）
function extractQuote(text: string): string | null {
  const m = text.match(/\[reply\|from:[^\]]*\]\s*([\s\S]+)/);
  if (!m) return null;
  const quoted = m[1].trim();
  return quoted.length > 0 ? quoted : null;
}

// 不值得沉淀的消息特征（纯指令/寒暄/极短）
function isWorthSaving(text: string): boolean {
  const t = text.trim();
  if (t.length === 0) return false;
  // 纯指令、确认、寒暄（即使带 quote 也被上面的提取逻辑拆开了）
  if (/^(好的|好|ok|OK|嗯|可以|继续|看看|知道了|收到|谢谢|感谢|辛苦了|可以了|就这样|先这样|没问题|对|是的|行|来吧|搞|做吧|开始|等一下|稍等)/.test(t)) return false;
  return true;
}

function extractUserMessages(messages: unknown[]): string[] {
  const out: string[] = [];
  for (const msg of messages || []) {
    const m = msg as { role?: string; content?: unknown };
    if (m?.role !== "user") continue;
    const content = m.content;
    let text = "";
    if (typeof content === "string") text = content;
    else if (Array.isArray(content)) {
      text = content
        .filter((b) => b && typeof b === "object" && "text" in (b as object))
        .map((b) => (b as { text: string }).text)
        .join("\n");
    }
    // 去掉 telegram 元信息行（[telegram]、[time]）
    text = text.replace(/^\[telegram\]\s*/gm, "").replace(/^\[time\].*$/gm, "").trim();
    if (!text) continue;

    // quote 提取：被引用的回复内容优先，放在用户原话之前
    const quoted = extractQuote(text);
    const own = text.replace(/\[reply\|from:[^\]]*\]\s*[\s\S]*/, "").trim();
    let finalText: string;
    if (quoted) {
      finalText = own ? `[用户引用] ${quoted}\n[用户原话] ${own}` : `[用户引用] ${quoted}`;
    } else {
      finalText = text;
    }
    if (isWorthSaving(finalText)) out.push(finalText);
  }
  return out;
}

function writeToMem0(content: string) {
  return new Promise<{ ok: boolean; ids: string[] }>((resolve) => {
    const child = spawn(MEM0_CLI, ["add", content], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    // ⚠️ 修复（2026-08-26）：只收 stdout，不拼 stderr！
    // mem0-cli 每次跑都会向 stderr 打 [PostHog] 警告，且先于 stdout 的 OK 到达；
    // 之前把 stderr 也拼进 out，导致 out 以 [PostHog] 开头，/^OK/ 误判失败 → notify 永不触发。
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", () => {}); // 丢弃 stderr（PostHog 噪音）
    child.on("close", () => {
      const trimmed = out.trim();
      // 严格判定：^OK 且后面跟了 id 列表（OK [xxx]），OK [] 表示没产生新条目
      const m = trimmed.match(/^OK \[([^\]]*)\]/);
      const ok = !!m;
      const ids = m && m[1] ? m[1].split(",").filter(Boolean) : [];
      autosedLog(`add 判定: ok=${ok} ids=${ids.length} out=${JSON.stringify(trimmed.slice(0, 80))}`);
      resolve({ ok, ids });
    });
    child.on("error", () => resolve({ ok: false, ids: [] })); // 静默失败，不阻塞
    setTimeout(() => {
      child.kill();
      resolve({ ok: false, ids: [] });
    }, 30000);
  });
}

// 「已记忆」反馈：写入成功后发独立 Telegram 消息（用户要求：不依赖下一轮回复）
function markMemorized(content: string) {
  notifyMemorized(content);
}

export default function (pi) {
  pi.on("agent_end", async (event, _ctx) => {
    try {
      const messages = (event as { messages?: unknown[] }).messages;
      if (!messages || messages.length === 0) return;

      const worthies = extractUserMessages(messages);
      for (const text of worthies) {
        const msgHash = createHash("sha1").update(text).digest("hex").slice(0, 12);
        if (lastWrite.sessionFile === event.sessionFile && lastWrite.msgHash === msgHash) continue;
        autosedLog(`准备沉淀: ${JSON.stringify(text.slice(0, 60))}`);
        // v2.3：LLM 过滤 + 提炼。无论判定结果都更新防抖，避免同一消息反复问 LLM。
        const verdict = await filterWithLLM(text);
        lastWrite = { sessionFile: event.sessionFile, msgHash };
        if (!verdict.save) {
          autosedLog(`LLM 判定不值得沉淀: ${JSON.stringify(verdict.reason.slice(0, 80))}`);
          continue;
        }
        autosedLog(`LLM 判定值得沉淀: ${JSON.stringify(verdict.reason.slice(0, 80))}`);
        const r = await writeToMem0(verdict.memory);
        // 只有真正产生新条目（OK [id]）才发通知；OK []（被合并/无新条目）也记录但不打扰
        if (r.ok && r.ids.length > 0) {
          autosedLog(`写入成功 ${r.ids.join(",")} → 发通知`);
          markMemorized(verdict.memory);
        } else {
          autosedLog(`未发通知: ok=${r.ok} ids=${r.ids.length} (OK [] 可能被合并或无新条目)`);
        }
      }
    } catch {
      // 静默失败，绝不影响主流程
    }
  });
}
