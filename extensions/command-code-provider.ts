/**
 * command-code-provider — 把 Command Code GOAT plan 接入 pi（OpenAI 兼容 Provider API）
 *
 * 前置：
 *   1. 在 https://commandcode.ai/settings/keys 创建 API key
 *   2. 存入 ~/.config/cmd-code/key（0600）
 *   3. /reload 后切换模型：--model cmd-code/cc/deepseek-v4-flash
 *
 * 端点：走本地代理 http://127.0.0.1:17322/v1（~/bin/cmd-code-proxy.js，launchd 常驻）
 * 代理逻辑：默认 → Command Code Provider API；额度用尽（402/429/额度类错误）
 *   且模型为 deepseek/* → 自动 fallback DeepSeek 官方 API
 * GOAT 用量限制：$14/5h、$35/7d、$70/月（$10 买 $70 credits，7x）
 * 价格：deepseek-v4-flash off-peak $0.22/$0.66 per M，cache read $0.007（peak $0.44/$1.32）
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerProvider("cmd-code", {
    name: "Command Code (GOAT)",
    baseUrl: "http://127.0.0.1:17322/v1",
    apiKey: "!cat $HOME/.config/cmd-code/key",
    api: "openai-completions",
    models: [
      {
        id: "cc/deepseek-v4-flash",
        name: "cc/deepseek-v4-flash",
        reasoning: true,
        input: ["text"],
        cost: { input: 0.22, output: 0.66, cacheRead: 0.007, cacheWrite: 0 },
        contextWindow: 1000000,
        maxTokens: 384000,
        compat: {
          supportsStore: false,
          supportsDeveloperRole: false,
          maxTokensField: "max_tokens",
          requiresReasoningContentOnAssistantMessages: true,
          thinkingFormat: "deepseek",
        },
        thinkingLevelMap: {
          minimal: null,
          low: "low",
          medium: null,
          high: "high",
          max: "max",
        },
      },
      {
        id: "cc/deepseek-v4-pro",
        name: "cc/deepseek-v4-pro",
        reasoning: true,
        input: ["text"],
        cost: { input: 0.66, output: 1.98, cacheRead: 0.021, cacheWrite: 0 },
        contextWindow: 1000000,
        maxTokens: 384000,
        compat: {
          supportsStore: false,
          supportsDeveloperRole: false,
          maxTokensField: "max_tokens",
          requiresReasoningContentOnAssistantMessages: true,
          thinkingFormat: "deepseek",
        },
        thinkingLevelMap: {
          minimal: null,
          low: null,
          medium: null,
          high: "high",
          max: "max",
        },
      },
    ],
  });
}
