// pi-session-search — 跨会话检索工具（薄壳，调 ~/bin/pi-search）
// 注册一个 session_search 自定义工具：agent 对话中遇到"之前聊过的X"自动调用。
// 同时注册 /pi-search 命令供手动使用。
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const PISEARCH = join(homedir(), "bin", "pi-search");
const exec = promisify(execFile);

async function run(args: string[]): Promise<string> {
  const { stdout, stderr } = await exec("python3", [PISEARCH, ...args], {
    timeout: 30000,
  });
  if (stderr) console.error("[pi-search]", stderr);
  return stdout;
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "session_search",
    label: "Session Search",
    description:
      "跨会话全文检索 pi 的历史对话。当用户提到“之前聊过的X”“那篇/那个”“某次会话里做过的事”等需要回忆历史的内容时调用。返回匹配会话的 ID、时间、目录和上下文片段。",
    parameters: Type.Object({
      query: Type.String({ description: "搜索关键词（中文/英文均可，模糊口语化提问自动 LLM 扩展）" }),
      limit: Type.Optional(Type.Number({ description: "返回条数，默认 5" })),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const limit = params.limit ?? 5;
      // 默认启用 LLM 扩展（模糊提问友好）；纯精确词可直接命中不受影响
      const out = await run(["search", params.query, "--expand", "--limit", String(limit)]);
      return {
        content: [{ type: "text", text: out || "无结果" }],
        details: { query: params.query },
      };
    },
  });

  pi.registerCommand("pi-search", {
    description: "搜索历史会话: /pi-search <关键词> [条数]",
    handler: async (args, ctx) => {
      const [query, limit] = (args || "").trim().split(/\s+/, 2);
      if (!query) {
        ctx.ui.notify("用法: /pi-search <关键词> [条数]", "info");
        return;
      }
      const out = await run(["search", query, "--limit", limit || "10"]);
      ctx.ui.notify(out || "无结果", "info");
    },
  });
}
