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
// 防抖：同一 session 文件最近一次沉淀的 key（消息内容 hash）
let lastWrite = { sessionFile: "", msgHash: "" };

// 写入成功 → 独立 Telegram 消息确认（system-message 风格，不占下一轮回复）
function notifyMemorized(content: string) {
  try {
    const snippet = content.slice(0, 60).replace(/\n/g, " ");
    const msg = `🧠 已记忆：${snippet}…`;
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
  return new Promise<boolean>((resolve) => {
    const child = spawn(MEM0_CLI, ["add", content], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let ok = false;
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", () => {
      ok = /^OK/.test(out.trim());
      resolve(ok);
    });
    child.on("error", () => resolve(false)); // 静默失败，不阻塞
    setTimeout(() => {
      child.kill();
      resolve(false);
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
        const ok = await writeToMem0(text);
        lastWrite = { sessionFile: event.sessionFile, msgHash };
        if (ok) markMemorized(text);
      }
    } catch {
      // 静默失败，绝不影响主流程
    }
  });
}
