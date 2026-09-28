/**
 * OpenRouter provider — 把 OpenRouter 上的模型注册进 pi。
 *
 * 用法：注册后 settings.json 里 defaultProvider: "openrouter"，
 *       defaultModel: "z-ai/glm-5.3-flash" 之类。
 *       API key 读 ~/.config/openrouter/key（0600），不写进代码/聊天。
 */
export default function (pi) {
  pi.registerProvider("openrouter", {
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    apiKey: "!cat $HOME/.config/openrouter/key",
    api: "openai-completions",
    models: [
      {
        // OpenRouter catalog verified 2026-09-27; standard (not batch) route.
        id: "anthropic/claude-opus-5.5",
        name: "Claude Opus 5.5 (OpenRouter)",
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 1000000,
        maxTokens: 128000,
        cost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
        thinkingLevelMap: {
          off: null,
          minimal: null,
          low: "low",
          medium: "medium",
          high: "high",
          xhigh: "xhigh",
          max: "max",
        },
        compat: {
          thinkingFormat: "openrouter",
          supportsReasoningEffort: true,
          supportsDeveloperRole: false,
          maxTokensField: "max_tokens",
          cacheControlFormat: "anthropic",
        },
      },
      {
        // OpenRouter catalog verified 2026-09-29; standard route, $2/$10 per M, cache read 0.2 / write 2.5.
        id: "anthropic/claude-sonnet-5.5",
        name: "Claude Sonnet 5.5 (OpenRouter)",
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 1000000,
        maxTokens: 128000,
        cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
        thinkingLevelMap: {
          off: null,
          minimal: null,
          low: "low",
          medium: "medium",
          high: "high",
          xhigh: "xhigh",
          max: "max",
        },
        compat: {
          thinkingFormat: "openrouter",
          supportsReasoningEffort: true,
          supportsDeveloperRole: false,
          maxTokensField: "max_tokens",
          cacheControlFormat: "anthropic",
        },
      },
      {
        id: "z-ai/glm-5.3-flash",
        name: "GLM 5.3 Flash",
        reasoning: true,
        input: ["text", "image"],
        cost: {
          input: 0.075,      // $/1M（发布 5 折价）
          output: 0.25,
          cacheRead: 0.015,
          cacheWrite: 0.03,
        },
        contextWindow: 1048576,
        maxTokens: 131072,
        thinkingLevelMap: {
          off: null,
          minimal: null,
          low: "low",
          medium: "medium",
          high: "high",
          xhigh: "max",
          max: "max",
        },
        compat: {
          thinkingFormat: "openrouter",  // reasoning: { effort }
          supportsReasoningEffort: true,
        },
      },
      {
        id: "z-ai/glm-5.3",
        name: "GLM 5.3",
        reasoning: true,
        input: ["text"],
        cost: {
          input: 1.4,
          output: 4.4,
          cacheRead: 0.26,
          cacheWrite: 0,
        },
        contextWindow: 1048576,
        maxTokens: 131072,
        thinkingLevelMap: {
          off: null,
          minimal: null,
          low: "low",
          medium: "medium",
          high: "high",
          xhigh: "max",
          max: "max",
        },
        compat: {
          thinkingFormat: "openrouter",
          supportsReasoningEffort: true,
        },
      },
    ],
  });
}
