/**
 * telegram-restart — Telegram 远程操控 pi（重启 / 状态 / 日志）
 *
 * 功能：
 *  - /restart   执行 ~/bin/restart-pi.sh（SIGTERM pi → run-pi.sh 3s 后拉起新实例）
 *               命令 handler 在 polling 线程执行，不依赖 LLM 队列，
 *               所以 pi 卡死（agent run 挂起）时依然能响应。
 *  - /pi_status 查看 pi 进程与 Telegram 心跳的快速状态
 *  - /pi_logs   查看最近重启/运行日志尾部
 *
 * 验证：Telegram 发 /restart，约 40-60 秒后 pi 恢复（重启期间消息排队）。
 *
 * 注意：import 用绝对路径指向 pi 安装的 pi-telegram 包（npm 重装后路径不变）。
 */
import { registerTelegramCommand } from "/Users/joye/.pi/agent/npm/node_modules/@llblab/pi-telegram/api/commands.ts";
import { spawn, execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const RESTART_SCRIPT = join(homedir(), "bin", "restart-pi.sh");

function runScript(script: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      script,
      args,
      { timeout: timeoutMs, env: process.env },
      (err, stdout, stderr) => {
        const text = `${stdout || ""}${stderr ? `\n${stderr}` : ""}`.trim();
        resolve(text || (err ? String(err.message).split("\n")[0] : "(空)"));
      },
    );
  });
}

function readOwnerHeartbeat(): { pid: number; ageSec: number } | null {
  try {
    const owners = JSON.parse(
      readFileSync(
        join(homedir(), ".pi", "agent", "tmp", "telegram", "owners.json"),
        "utf8",
      ),
    );
    const owner = owners.personal;
    if (!owner?.heartbeatMs) return null;
    const ageSec = Math.round((Date.now() - owner.heartbeatMs) / 1000);
    return { pid: owner.pid, ageSec };
  } catch {
    return null;
  }
}

function getSelfInfo(): Promise<{ pid: number; ppid: number; started: string } | null> {
  return new Promise((resolve) => {
    execFile(
      "ps",
      ["-o", "pid=,ppid=,lstart=", "-p", String(process.pid)],
      { timeout: 3000 },
      (err, stdout) => {
        if (err || !stdout) return resolve(null);
        const parts = stdout.trim().split(/\s+/);
        if (parts.length < 3) return resolve(null);
        resolve({
          pid: Number(parts[0]),
          ppid: Number(parts[1]),
          started: parts.slice(2).join(" "),
        });
      },
    );
  });
}

export default function () {
  registerTelegramCommand({
    name: "restart",
    description: "重启 Pi（restart-pi.sh，约 40-60s）",
    showInMenu: true,
    emoji: "🔄",
    handler: async (ctx) => {
      const before = await getSelfInfo();
      await ctx.reply(
        `🔄 正在重启 Pi…\n当前 pid=${before?.pid ?? "?"}，预计 40-60 秒后恢复（此期间消息会排队）`,
      );
      // 延时 spawn，确保 reply 已发出后再杀自己
      setTimeout(() => {
        spawn("bash", [RESTART_SCRIPT], {
          detached: true,
          stdio: "ignore",
          env: process.env,
        }).unref();
      }, 1500);
    },
  });

  registerTelegramCommand({
    name: "new",
    description: "开新会话（重启 pi，不带 --continue → 新 session，旧会话保留可查）",
    showInMenu: true,
    emoji: "🆕",
    handler: async (ctx) => {
      const before = await getSelfInfo();
      await ctx.reply(
        `🆕 正在开新会话…\n当前 pid=${before?.pid ?? "?"}，旧会话将归档（可 session_search 查），约 40-60 秒后新会话就绪`,
      );
      setTimeout(() => {
        spawn("bash", [RESTART_SCRIPT], {
          detached: true,
          stdio: "ignore",
          env: process.env,
        }).unref();
      }, 1500);
    },
  });

  registerTelegramCommand({
    name: "pi_status",
    description: "Pi 进程与 Telegram 心跳状态",
    showInMenu: true,
    emoji: "📡",
    handler: async (ctx) => {
      const self = await getSelfInfo();
      const owner = readOwnerHeartbeat();
      const lines = [
        `📡 **Pi 状态**`,
        `· 本进程: pid=${self?.pid ?? "?"} (ppid=${self?.ppid ?? "?"})`,
        `· 启动时间: ${self?.started ?? "?"}`,
      ];
      if (owner) {
        lines.push(
          `· Telegram owner: pid=${owner.pid}（心跳 ${owner.ageSec}s 前更新）`,
          owner.ageSec < 180
            ? "· 状态: ✅ 健康"
            : "· 状态: ⚠️ 心跳超时（发 /restart 重启）",
        );
      } else {
        lines.push(`· Telegram owner: 未找到 owners.json`);
      }
      await ctx.reply(lines.join("\n"));
    },
  });

  registerTelegramCommand({
    name: "pi_logs",
    description: "最近重启/运行日志尾部",
    showInMenu: false,
    handler: async (ctx) => {
      const text = await runScript("tail", ["-n", "25", "/tmp/restart-pi.log"], 5000);
      await ctx.reply(
        `📋 **restart-pi.log 尾部**\n\`\`\`\n${text.slice(0, 3000)}\n\`\`\``,
      );
    },
  });
}
