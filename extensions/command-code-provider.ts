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
        // CC 端底层转发 OpenRouter（provider: Z.AI），模型 id 必须用全名 z-ai/glm-5.3-flash
        // 价格暂按 OpenRouter 价（$0.075/$0.25 per M）记账，CC 实际扣 credits 待观察
        id: "z-ai/glm-5.3-flash",
        name: "GLM 5.3 Flash (CC)",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0.075, output: 0.25, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1048576,
        maxTokens: 131072,
        compat: {
          supportsStore: false,
          supportsDeveloperRole: false,
          maxTokensField: "max_tokens",
          thinkingFormat: "openrouter",
        },
        thinkingLevelMap: {
          minimal: null,
          low: "low",
          medium: "medium",
          high: "high",
          max: null,
        },
      },
      {
        // Qwen3.8-Flash：CC 端模型 id 全名 Qwen/Qwen3.8-Flash，2026-08-28 实测 CC 上最快（中位 3s/40 tok/s）
        // 价格按 OpenRouter Qwen3 系 flash 档暂记，待核实
        id: "Qwen/Qwen3.8-Flash",
        name: "Qwen 3.8 Flash (CC)",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0.075, output: 0.3, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1048576,
        maxTokens: 131072,
        compat: {
          supportsStore: false,
          supportsDeveloperRole: false,
          maxTokensField: "max_tokens",
          thinkingFormat: "openrouter",
        },
        thinkingLevelMap: {
          minimal: null,
          low: "low",
          medium: "medium",
          high: "high",
          max: null,
        },
      },
      {
        // Kimi K3：CC 端模型 id 全名 moonshotai/Kimi-K3（2026-09-02 确认在 CC 模型列表）
        // 价格 CC 未公布，先占位记账待核实；context 按.K2 系 256k 暂定
        id: "moonshotai/Kimi-K3",
        name: "Kimi K3 (CC)",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 262144,
        maxTokens: 131072,
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
          max: null,
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
