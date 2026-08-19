/**
 * pi-plugin-probe — 验证 pi 扩展插件加载链路的探针插件。
 *
 * 功能：
 *  - 注册自定义工具 `probe_ping`：返回当前 pi 进程 PID、启动时间、插件版本
 *  - 注册命令 `/probe`：在 TUI 里显示同样的信息
 *  - session_start 事件：向 ~/.pi/agent/tmp/pi-plugin-probe.log 追加一行加载记录
 *
 * 验证方式（重启后）：
 *  - 调用工具 probe_ping，看 PID 是否是重启后的新进程
 *  - 或查看 ~/.pi/agent/tmp/pi-plugin-probe.log 里最新的加载记录
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const VERSION = "0.1.0";
const LOG_DIR = join(homedir(), ".pi", "agent", "tmp");
const LOG_FILE = join(LOG_DIR, "pi-plugin-probe.log");

function logLoaded(reason: string, cwd?: string) {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(
      LOG_FILE,
      `${new Date().toISOString()} pid=${process.pid} reason=${reason} cwd=${cwd ?? "?"} version=${VERSION}\n`,
    );
  } catch {
    /* 日志失败不影响插件加载 */
  }
}

export default function (pi: ExtensionAPI) {
  // 1) 自定义工具：probe_ping
  pi.registerTool({
    name: "probe_ping",
    label: "Probe Ping",
    description:
      "验证 pi-plugin-probe 插件已加载。返回当前 pi 进程 PID、插件版本与时间。",
    parameters: Type.Object({}),
    async execute() {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                plugin: "pi-plugin-probe",
                version: VERSION,
                pid: process.pid,
                startedAt: new Date().toISOString(),
                ok: true,
              },
              null,
              2,
            ),
          },
        ],
        details: {},
      };
    },
  });

  // 2) 命令：/probe
  pi.registerCommand("probe", {
    description: "显示 pi-plugin-probe 插件状态",
    handler: async (_args, ctx) => {
      ctx.ui.notify(
        `pi-plugin-probe v${VERSION} loaded — pid=${process.pid}`,
        "info",
      );
    },
  });

  // 3) 事件：每次 session 启动记录加载
  pi.on("session_start", async (event, ctx) => {
    logLoaded(event.reason, ctx.cwd);
  });

  // 4) 事件：tool_call 拦截演示（看到 bash 里含 kill 时提示）
  pi.on("tool_call", async (event) => {
    if (event.toolName === "bash" && typeof event.input.command === "string" && event.input.command.includes("kill")) {
      logLoaded("tool_call-intercept-kill");
    }
  });
}
