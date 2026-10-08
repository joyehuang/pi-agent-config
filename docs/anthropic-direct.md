# Official Anthropic Sonnet 5.5 in Pi

Verified 2026-10-08 with Pi 0.84.1. This route uses the official Anthropic Messages API, not OpenRouter or Claude subscription OAuth. The provider ID is deliberately `anthropic-direct`, distinct from the QQ bot's `anthropic-official`, so a shared model catalog cannot shadow the bot's dedicated adapter.

## Private configuration

Add a provider in the real `~/.pi/agent/models.json`. Keep credentials in private files under `~/.config/` with mode `0600`; never commit actual values. The file paths below are examples—point them to the existing authorized credential files rather than creating fake values.

```json
{
  "providers": {
    "anthropic-direct": {
      "baseUrl": "https://api.anthropic.com",
      "api": "anthropic-messages",
      "apiKey": "!cat ~/.config/anthropic/key",
      "headers": {
        "anthropic-workspace-id": "!cat ~/.config/anthropic/workspace-id"
      },
      "models": [{
        "id": "claude-sonnet-5-5",
        "name": "Claude Sonnet 5.5 (Anthropic Direct)",
        "reasoning": true,
        "input": ["text", "image"],
        "contextWindow": 1000000,
        "maxTokens": 128000,
        "thinkingLevelMap": {
          "off": null,
          "minimal": "low",
          "low": "low",
          "medium": "medium",
          "high": "high",
          "xhigh": "xhigh",
          "max": "max"
        },
        "compat": { "forceAdaptiveThinking": true },
        "cost": { "input": 2, "output": 10, "cacheRead": 0.1, "cacheWrite": 2.5 }
      }]
    }
  }
}
```

The workspace header is required for a cross-workspace personal key. Resolve a real workspace through the Console or the authorized List Workspaces API; do not invent an ID. For a workspace-scoped key, this extra header may be omitted.

`forceAdaptiveThinking` is required for this model's supported thinking mode. It does not support legacy `enabled` / `budget_tokens`, and thinking cannot be disabled. Costs are USD per million tokens; cache-write pricing above is for five-minute cache writes.

Set `defaultProvider` to `anthropic-direct`, `defaultModel` to `claude-sonnet-5-5`, and add `anthropic-direct/claude-sonnet-5-5` to `enabledModels`. Preserve the user's existing thinking preference unless separately requested. Editing defaults does not switch an already-running conversation; select the model with `/model`, or start/restart the session so it uses the updated default.

## Actual validation

- Pi model discovery listed the direct route with 1M context, 128K output, thinking and image input.
- A real, ephemeral Pi invocation used the private file-backed key and workspace header, with extensions, skills and context discovery disabled.
- At `high` thinking, it invoked the built-in read tool on a synthetic fixture and returned `DIRECT_SONNET55_TOOL_OK`.
- Both assistant turns recorded `anthropic-direct / claude-sonnet-5-5`; one actual tool result was observed. Exit status was zero.
- No production QQ model selections, MetaBot configuration, shared OAuth credentials or main-session transcript were changed. Image support was checked against official model metadata, not through an additional billed image test.

Local configuration backups and the small smoke result remain private under `~/.config/pi-model-switch/`. Live keys are not stored in this repository.
