# Native multimodal policy

Effective 2026-09-09, Qwen-MM-Plugins is retired from the personal Pi setup. Use the current model's native image capability, including local screenshot review. Do not silently switch models or call an external vision service for screenshot QA.

## Screenshot delivery

1. Capture with ego-browser and retain the image in the dated local artifacts directory.
2. Read the image directly with the current multimodal model; check loading, errors, clipping and sensitive information.
3. Deliver only after review. Retry incorrect captures at most three times; otherwise stop and explain the failure.

## Removed configuration

- Both `qwen-mm-plugins-api` and `qwen-mm-plugins-core` server registrations, including their entries in the existing MCP backup.
- Their Pi metadata-cache entries, local skills and plugin-specific config directory.
- The remaining plugin process, package cache and 20 plugin-specific uv cached virtual environments.

The MCP adapter, mem0, Exa and Parallel remain installed. General-purpose uv, Python and ffmpeg were not removed. No model defaults, Telegram configuration or service credentials shared with other applications were revoked.

## Shared dependency boundary

The text-only `pi-search` query expander previously read its API key/base from the plugin config. It now reads `~/.config/pi-search/llm.env` (0600), with the same environment-variable precedence, endpoint and model. This is a text-search configuration, not a retained multimodal plugin. Source is mirrored in `scripts/pi-search.py`; installed CLI is `~/bin/pi-search`.

QQ bot uses native image input with its current multimodal model. Its optional direct-API image tool is not an MCP plugin and already falls back to `~/.config/cmd-code/key`; the existing fallback was checked to match the removed config's key, base and model. Its code and model were left unchanged. References in historical records are retained for audit, not active installation instructions.

## Runtime boundary

Removing files does not mutate an already loaded Pi extension's tool inventory. The old cached names in an existing turn disappear after Pi's normal `/reload` or restart. No main-Pi restart was performed during the removal turn, and no model/API calls or live group test messages were used to validate removal.
