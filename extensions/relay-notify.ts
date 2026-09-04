/**
 * relay-notify — 后台任务完成通知注入
 *
 * 背景：relay 模式（后台脚本等 herdr agent 的 DONE 标记）此前只通过
 * notify-telegram 通知用户，pi agent 本身不知道任务完成了，只能靠用户转述
 * 或主动轮询（轮询会占用回合、拖慢对用户消息的响应——2026-09-04 教训）。
 *
 * 机制：后台脚本用 ~/bin/notify-agent.py 把通知写成 spool 文件
 * （~/.pi/agent/notifications/*.json），本扩展在 pi 进程内监听该目录，
 * agent 空闲时把通知作为用户消息注入并触发回合（agent 由此知晓并可跟进，
 * 回复会经 Telegram 桥自然送达用户）。
 *
 * 优先级保证：agent 忙（用户回合进行中）时通知只入队不打断；agent_end
 * 后才 flush。用户消息永远第一优先级。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const SPOOL_DIR = path.join(os.homedir(), ".pi/agent/notifications");
const SCAN_INTERVAL_MS = 4000;

interface Notice {
	text: string
	source?: string
	ts?: number
	file: string
}

export default function (pi: ExtensionAPI) {
	let busy = false
	const pending: Notice[] = []

	fs.mkdirSync(SPOOL_DIR, { recursive: true })

	function scan(): Notice[] {
		const found: Notice[] = []
		let files: string[] = []
		try {
			files = fs.readdirSync(SPOOL_DIR).filter((f) => f.endsWith(".json")).sort()
		} catch {
			return found
		}
		for (const file of files) {
			const full = path.join(SPOOL_DIR, file)
			try {
				const data = JSON.parse(fs.readFileSync(full, "utf8")) as Notice
				// 先改名占住（原子 claim），读失败也不重复消费
				fs.renameSync(full, full + ".done")
				found.push({ ...data, file })
			} catch (e) {
				// 半写文件（脚本还在写）——跳过，下次扫描再收
				continue
			}
		}
		return found
	}

	function flush() {
		const notices = pending.splice(0, pending.length)
		if (notices.length === 0) return
		const lines = notices.map((n) => {
			const src = n.source ? `（来源：${n.source}）` : ""
			return `- ${n.text}${src}`
		})
		const text = `【后台任务通知】以下后台任务有更新，请简短确认或按需跟进，不要展开长篇报告：\n${lines.join("\n")}`
		try {
			pi.sendUserMessage(text, { deliverAs: "followUp", triggerTurn: true })
		} catch {
			// 注入失败则放回队首，下个扫描周期重试
			pending.unshift(...notices)
		}
	}

	function collect() {
		const notices = scan()
		if (notices.length === 0) return
		if (busy) {
			pending.push(...notices)
			return
		}
		pending.push(...notices)
		flush()
	}

	pi.on("before_agent_start", () => {
		busy = true
	})

	pi.on("agent_end", () => {
		busy = false
		// 回合结束后把积压的通知注进去；若本回合就是通知触发的且又忙起来，
		// 下次 agent_end 再处理
		if (!busy) setTimeout(collect, 500)
	})

	// 启动时处理 pi 离线期间积压的通知；fs.watch 兜底轮询双保险
	setTimeout(collect, 3000)
	setInterval(collect, SCAN_INTERVAL_MS)
	try {
		fs.watch(SPOOL_DIR, () => setTimeout(collect, 300))
	} catch {
		// fs.watch 不可用就纯靠轮询
	}
}
