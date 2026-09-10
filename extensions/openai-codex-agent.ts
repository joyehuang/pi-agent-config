import { readFileSync, statSync } from "node:fs";
import { createProvider, openAICodexResponsesApi, getModels } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const AUTH_PATH = "/Users/joye/.config/codex-agent/auth.json";
const ID = "openai-codex-agent";
const SOURCE = "external Codex OAuth file (read-only)";

// No refresh, credential copy, login, fallback, or writes. The existing credential
// owner must renew this file; every request reads the current access token.
export function readAccessToken(path = AUTH_PATH): string {
  try {
    const st = statSync(path);
    if (!st.isFile() || (st.mode & 0o077) !== 0) throw new Error();
    const doc = JSON.parse(readFileSync(path, "utf8"));
    const access = doc.tokens?.access_token;
    if (doc.auth_mode !== "chatgpt" || typeof access !== "string") throw new Error();
    const payload = JSON.parse(Buffer.from(access.split(".")[1], "base64url").toString("utf8"));
    if (!Number.isFinite(payload.exp) || payload.exp * 1000 <= Date.now() + 300_000) throw new Error();
    const account = payload["https://api.openai.com/auth"]?.chatgpt_account_id;
    if (!account || account !== doc.tokens.account_id) throw new Error();
    return access;
  } catch {
    throw new Error("AGENT_AUTH_UNAVAILABLE: external credential missing, invalid, insecure, or expiring; no refresh or fallback performed");
  }
}

// Snapshot of the existing custom model metadata, without credentials or headers.
const astra = {
  id: "gpt-6-astra", name: "GPT-6 Astra", api: "openai-codex-responses",
  provider: ID, baseUrl: "https://chatgpt.com/backend-api", reasoning: true,
  input: ["text", "image"], cost: { input: 10, output: 50, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1050000, maxTokens: 128000,
  thinkingLevelMap: { xhigh: "xhigh", max: "max", minimal: "low" },
  compat: { supportsOpenAIGrammarTools: true, supportsToolSearch: true },
};

export default function (pi: ExtensionAPI) {
  const catalog = new Map(getModels("openai-codex").map(m => [m.id, { ...m, provider: ID }]));
  catalog.set(astra.id, astra as any);
  const nativeApi = openAICodexResponsesApi();
  // Only authentication is overridden. Preserve native reasoning, service tier,
  // retries, transport, and onPayload behavior selected by the caller.
  const optionsFor = (options: any) => ({
    ...options, apiKey: readAccessToken(),
  });
  pi.registerProvider(createProvider({
    id: ID, name: "OpenAI Codex Agent (external OAuth)", baseUrl: astra.baseUrl,
    auth: { apiKey: {
      name: SOURCE,
      async login() { throw new Error("Use the external credential owner; pi login is disabled for this provider"); },
      async check() {
        try { readAccessToken(); return { type: "api_key" as const, source: SOURCE }; }
        catch { return undefined; }
      },
      async resolve() { return { auth: { apiKey: readAccessToken() }, source: SOURCE }; },
    } },
    models: Array.from(catalog.values()),
    api: {
      ...nativeApi,
      stream: (m: any, c: any, o: any) => nativeApi.stream(m, c, optionsFor(o)),
      streamSimple: (m: any, c: any, o: any) => nativeApi.streamSimple(m, c, optionsFor(o)),
    },
  }));
}
