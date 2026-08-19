// session-recap — 每轮回复末尾追加一行状态总结（📌 状态 | 下一步），
// 并在 agent_end 时把 recap 行落盘到 ~/.pi/agent/recaps/YYYY-MM-DD.md 形成可检索索引。
// 与 mem0 / memory.md 隔离：recap 只写增量状态行。
import { homedir } from "node:os";
import { join } from "node:path";
import { appendFileSync, mkdirSync } from "node:fs";

const RECAP_INSTRUCTION = `
[Session Recap]
每轮回复的**最末尾**追加一行（用纯文本，不加 markdown 代码块）：
📌 状态: <本轮完成了什么，10-20 字> | 下一步: <下一步动作，10-20 字>
规则：
- 只写**本轮增量**，不重复之前的内容，不写"我们讨论了 X"这类复述
- 一句话，保持一行；实在放不下拆两行
- 回复本来就极短（如纯确认）时可省略
- 这行是给用户的方向感提示，不是报告，不要展开
- 注意：这一行会被扩展自动落盘到 ~/.pi/agent/recaps/ 索引文件，所以保持单行、自包含（能脱离上下文看懂）
`;

const RECAPS_DIR = join(homedir(), ".pi", "agent", "recaps");

// 去重：同一 session 文件 + 同一 recap 行只落盘一次（agent_end 可能因重试触发多次）
let lastWrittenKey = "";

function extractRecapLine(messages: unknown[]): string | undefined {
  // 从本次 run 的消息里找最后一条 assistant 文本，取末尾的 📌 行
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as { role?: string; content?: unknown };
    if (msg?.role !== "assistant") continue;
    const content = msg.content;
    if (typeof content === "string") {
      const line = findRecap(content);
      if (line) return line;
    } else if (Array.isArray(content)) {
      // 倒序拼文本块，找最后一个包含 recap 的块
      const texts: string[] = [];
      for (const block of content) {
        if (block && typeof block === "object" && "text" in (block as object)) {
          texts.push((block as { text: string }).text);
        }
      }
      const full = texts.join("\n");
      const line = findRecap(full);
      if (line) return line;
    }
  }
  return undefined;
}

function findRecap(text: string): string | undefined {
  // 取最后一个以 📌 状态: 开头的完整行（不跨行，保证单行可检索）
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line.startsWith("📌 状态:")) return line;
  }
  return undefined;
}

function appendRecap(sessionFile: string | undefined, recap: string) {
  try {
    mkdirSync(RECAPS_DIR, { recursive: true });
    const now = new Date();
    const dayFile = join(RECAPS_DIR, `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}.md`);
    const time = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    const session = sessionFile ? sessionFile.split("/").pop() : "(unknown)";
    const key = `${session}|${recap}`;
    if (key === lastWrittenKey) return;
    lastWrittenKey = key;
    appendFileSync(dayFile, `- ${time} \`${session}\` ${recap}\n`, "utf8");
  } catch {
    // 落盘失败不影响主流程
  }
}

export default function (pi: {
  on(event: string, handler: (event: any, ctx: any) => unknown): void;
}) {
  pi.on("before_agent_start", (event: { systemPrompt?: string }) => {
    const existing = event.systemPrompt ?? "";
    if (existing.includes("[Session Recap]")) return undefined; // 幂等
    return {
      systemPrompt: `${existing}\n${RECAP_INSTRUCTION}`,
    };
  });

  pi.on("agent_end", (event: { messages?: unknown[] }, ctx: { sessionManager?: { getSessionFile?: () => string | undefined } }) => {
    const messages = event.messages;
    if (!Array.isArray(messages) || messages.length === 0) return;
    const recap = extractRecapLine(messages);
    if (!recap) return;
    const sessionFile = ctx.sessionManager?.getSessionFile?.();
    appendRecap(sessionFile, recap);
  });
}
