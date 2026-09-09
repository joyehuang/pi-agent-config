/** Empty completion recovery, after Pi's native retry/compaction/follow-ups settle.
 * The active SessionManager branch is authoritative; agent_end is only a run.
 * No transport dependency: this also protects local TUI and RPC sessions.
 */
import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const RETRY_PROMPT =
  "(系统自动重试) 你上一条回复是空的，没有输出任何文字。请基于上面已完成的工作和工具结果，直接给出本轮的最终回复。";
const MARKER = "[empty-reply-recovery:";

type Message = { role: string; content?: unknown; stopReason?: string };
function text(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter(p => p?.type === "text").map(p => p.text ?? "").join("");
}
function empty(message: Message | undefined): boolean {
  if (message?.role !== "assistant" || !["stop", "length", "error"].includes(message.stopReason ?? "")) return false;
  if (Array.isArray(message.content) && message.content.some(p => p?.type === "toolCall" || p?.type === "tool_use")) return false;
  return !text(message.content).trim();
}

export default function (pi: ExtensionAPI) {
  let session: string | undefined;
  let cursor: string | null = null;
  let request: { id: string; retries: number; retryText?: string; admitted?: boolean } | undefined;
  let terminal: Message | undefined;
  let completed = false;

  function reset(ctx: ExtensionContext) {
    session = ctx.sessionManager.getSessionId();
    cursor = ctx.sessionManager.getLeafId();
    request = undefined;
    terminal = undefined;
    completed = false;
  }
  // Read only entries appended since the last turn. getEntry is indexed. Never
  // scan other branches or resurrect a previous autonomous task after reload.
  function sync(ctx: ExtensionContext): boolean {
    if (session !== ctx.sessionManager.getSessionId()) return false;
    const sm = ctx.sessionManager;
    const pending = [];
    let id = sm.getLeafId();
    while (id !== cursor) {
      if (!id || pending.length >= 2048) { reset(ctx); return false; }
      const entry = sm.getEntry(id);
      if (!entry) { reset(ctx); return false; }
      pending.push(entry);
      id = entry.parentId;
    }
    for (const entry of pending.reverse()) {
      if (entry.type !== "message") continue;
      const m = entry.message;
      if (m.role === "user") {
        if (!request?.admitted || text(m.content) !== request.retryText) {
          request = { id: entry.id, retries: 0 };
        }
        terminal = undefined;
        completed = false;
      } else if (m.role === "assistant") {
        terminal = m;
        const tools = Array.isArray(m.content) && m.content.some(p => p.type === "toolCall");
        if (tools) completed = false;
        else if (["stop", "length"].includes(m.stopReason) && text(m.content).trim()) completed = true;
      } else if (m.role === "toolResult") {
        // A progress/tool-calling message is not a terminal completion.
        terminal = undefined;
        completed = false;
      }
    }
    cursor = sm.getLeafId();
    return true;
  }

  pi.on("session_start", (_event, ctx) => reset(ctx));
  pi.on("session_tree", (_event, ctx) => reset(ctx));
  pi.on("session_shutdown", () => { session = undefined; request = undefined; terminal = undefined; });
  pi.on("before_agent_start", (_event, ctx) => {
    if (session === undefined) reset(ctx);
    else sync(ctx);
  });
  pi.on("turn_end", (_event, ctx) => { sync(ctx); });
  // A stale/mismatched event.messages list cannot override committed evidence.
  pi.on("agent_end", (_event, ctx) => { sync(ctx); });
  pi.on("input", (event, ctx) => {
    if (event.source !== "extension" || !event.text.startsWith(`${RETRY_PROMPT}\n${MARKER}`)) return;
    if (!sync(ctx) || !request || event.text !== request.retryText || request.admitted || completed || !empty(terminal)) {
      return { action: "handled" };
    }
    request.admitted = true;
  });
  pi.on("agent_settled", (event, ctx) => {
    if ((event as { aborted?: boolean }).aborted) return;
    if (!sync(ctx) || !ctx.isIdle() || ctx.hasPendingMessages() || ctx.signal?.aborted || !request || completed || !empty(terminal)) return;
    if (request.retries >= 1) {
      if (ctx.hasUI) ctx.ui.notify("回复为空且自动重试已用尽", "error");
      return;
    }
    // Reserve the budget before the void API can synchronously emit input.
    request.retries = 1;
    request.retryText = `${RETRY_PROMPT}\n${MARKER}${randomUUID()}]`;
    pi.sendUserMessage(request.retryText, { deliverAs: "followUp" });
  });
}
