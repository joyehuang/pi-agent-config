/**
 * empty-reply-guard — 空回复保险
 *
 * 现象：provider 偶发在 turn 边界返回空 completion（无文字、无工具调用），
 * pi 把它当正常 turn 结束，导致整轮没有任何最终回复（Telegram 上表现为
 * 只有中间消息、没有 quote 回复）。session 日志显示 2026-08-11 起跨模型
 * （deepseek / glm）共发生 20+ 次。
 *
 * 修复：agent_end 时检查本轮最后一条 assistant 消息是否为空；为空则自动
 * 注入一条 follow-up 用户消息触发续答（每轮最多重试 1 次，防死循环）。
 * 真正的用户新输入会重置重试计数。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const RETRY_PROMPT =
	"(系统自动重试) 你上一条回复是空的，没有输出任何文字。请基于上面已完成的工作和工具结果，直接给出本轮的最终回复。";

interface TextPart {
	type: string
	text?: string
}

function isEmptyAssistantMessage(message: unknown): boolean {
	const m = message as { role?: string; content?: unknown; stopReason?: string } | undefined
	if (!m || m.role !== "assistant") return false
	// 用户主动中断导致的空消息不重试
	if (m.stopReason === "aborted") return false
	const content = m.content
	if (content == null) return true
	if (typeof content === "string") return content.trim() === ""
	if (Array.isArray(content)) {
		if (content.length === 0) return true
		const parts = content as TextPart[]
		const hasToolCall = parts.some((p) => p.type === "toolCall" || p.type === "tool_use")
		if (hasToolCall) return false
		const text = parts
			.filter((p) => p.type === "text")
			.map((p) => p.text ?? "")
			.join("")
			.trim()
		return text === ""
	}
	return false
}

export default function (pi: ExtensionAPI) {
	let retriesThisPrompt = 0
	const MAX_RETRIES = 1

	// 真正的用户输入（非本扩展注入的重试消息）重置计数
	pi.on("before_agent_start", async (event) => {
		if (event.prompt !== RETRY_PROMPT) {
			retriesThisPrompt = 0
		}
	})

	pi.on("agent_end", async (event, ctx) => {
		const messages = (event as { messages?: unknown[] }).messages ?? []
		let lastAssistant: unknown
		for (let i = messages.length - 1; i >= 0; i--) {
			const m = messages[i] as { role?: string }
			if (m?.role === "assistant") {
				lastAssistant = m
				break
			}
		}
		if (!isEmptyAssistantMessage(lastAssistant)) return

		if (retriesThisPrompt >= MAX_RETRIES) {
			ctx.ui.notify?.("回复为空且自动重试已用尽", "error")
			return
		}

		retriesThisPrompt++
		// agent 已结束（非 streaming），sendUserMessage 会立即触发新 turn
		pi.sendUserMessage(RETRY_PROMPT, { deliverAs: "followUp", triggerTurn: true })
	})
}
