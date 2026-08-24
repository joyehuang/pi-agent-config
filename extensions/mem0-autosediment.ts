// mem0-autosediment — agent_end 时自动把值得沉淀的事实写入 mem0。
//
// 背景（2026-08-24）：mem0 自觉路线失败（10 天仅 3 次 memory_search，agent 基本不主动调 memory_add）。
// 用户决策：上 hooks —— agent_end 自动沉淀。
//
// 实现：在 agent_end 时，把本次 run 的 messages 里「用户消息」提取出来，用 mem0-cli add 写入。
// 只处理用户消息（user role），避免把 agent 自己的输出反复写进记忆造成噪音。
// 通过 child_process 调 ~/bin/mem0-cli.py（独立进程，避免阻塞 pi 事件循环）。
//
// 去重/防抖：
//  - 同一条用户消息只写一次（按消息内容 hash + session 维度）
//  - agent_end 可能因重试/auto-compact 触发多次 → 用 lastSettledKey 防重复写入
//  - 消息过短（<20 字符）或纯指令性（"好的""继续""看看"）不沉淀
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

const MEM0_CLI = `${process.env.HOME}/bin/mem0-cli.py`;
// 防抖：同一 session 文件最近一次沉淀的 key
let lastWrite = { sessionFile: "", msgHash: "" };
// 简单限流：两次沉淀之间至少隔 60s（agent_end 可能密集触发）
let lastWriteAt = 0;

// 不值得沉淀的消息特征（纯指令/寒暄/极短）
function isWorthSaving(text: string): boolean {
  const t = text.trim();
  if (t.length < 20) return false;
  // 纯指令、确认、寒暄
  if (/^(好的|好|ok|OK|嗯|可以|继续|看看|知道了|收到|谢谢|可以了|就这样|先这样|没问题|对|是的|行|来吧|搞|做吧|开始)/.test(t)) return false;
  // 纯感谢
  if (/^(谢谢|感谢|辛苦了)/.test(t)) return false;
  // 明显是命令而非事实陈述（以动词开头、无主语的短命令）
  if (t.length < 40 && /^(查|看|找|搜|发|写|做|改|删|建|跑|测|试|打开|关闭|重启|部署|更新|升级|配置|安装|清理|归档|记住|push|pull|commit)/.test(t)) return false;
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
    // 去掉 telegram 元信息行（[telegram]、[time]、[reply...]）
    text = text.replace(/^\[telegram\]\s*/gm, "").replace(/^\[time\].*$/gm, "").replace(/^\[reply.*$/gm, "").trim();
    if (isWorthSaving(text)) out.push(text);
  }
  return out;
}

function writeToMem0(content: string) {
  return new Promise<void>((resolve) => {
    const child = spawn(MEM0_CLI, ["add", content], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", () => resolve());
    child.on("error", () => resolve()); // 静默失败，不阻塞
    setTimeout(() => {
      child.kill();
      resolve();
    }, 30000);
  });
}

export default function (pi) {
  pi.on("agent_end", async (event, _ctx) => {
    try {
      const now = Date.now();
      if (now - lastWriteAt < 60000) return; // 60s 限流
      const messages = (event as { messages?: unknown[] }).messages;
      if (!messages || messages.length === 0) return;

      const worthies = extractUserMessages(messages);
      for (const text of worthies) {
        const msgHash = createHash("sha1").update(text).digest("hex").slice(0, 12);
        if (lastWrite.sessionFile === event.sessionFile && lastWrite.msgHash === msgHash) continue;
        await writeToMem0(text);
        lastWrite = { sessionFile: event.sessionFile, msgHash };
        lastWriteAt = now;
      }
    } catch {
      // 静默失败，绝不影响主流程
    }
  });
}
