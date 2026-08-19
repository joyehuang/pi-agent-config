// memory-inject — inject ~/.memory.md and ~/.user.md into the system prompt at every agent start
// Both files are append-only (user-managed); this extension only reads them.
//
// v2 (2026-08-19): 行为规则与事实信息分离。
//   - 提取 memory.md「## 好习惯」区作为 <rules> 块，**置顶**注入 system prompt 并带强指令
//     （教训：注入 ≠ 遵守。以前整段 memory 垫在 prompt 末尾，规则被长文档淹没，用户 8-19 连续踩雷）。
//   - 完整 memory/user 内容仍注入末尾 <memory> 块，供按需检索。
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const FILES = [".memory.md", ".user.md"].map((f) => join(process.env.HOME || "", f));
let cache: { key: string; content: string; rules: string } | null = null;

function loadAll(): { key: string; content: string; rules: string } | null {
  const parts: string[] = [];
  let key = "";
  for (const f of FILES) {
    try {
      const st = statSync(f);
      key += `${f}:${st.mtimeMs};`;
      parts.push(readFileSync(f, "utf8"));
    } catch {
      // missing file → skip
    }
  }
  if (parts.length === 0) return null;
  return { key, content: parts.join("\n\n"), rules: extractRules(parts.join("\n\n")) };
}

// 提取「## 好习惯」小节（标题行可能是「## 好习惯（已确立，必须遵守）」等变体）。
// 行级解析：找到标题行后收集内容，直到下一个 `## ` 标题或文件尾。
function extractRules(md: string): string {
  const lines = md.split("\n");
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^## 好习惯/.test(lines[i])) {
      start = i + 1;
      break;
    }
  }
  if (start === -1) return "";
  const out: string[] = [];
  for (let i = start; i < lines.length; i++) {
    if (/^## /.test(lines[i])) break;
    if (lines[i].trim() !== "") out.push(lines[i]);
  }
  return out.join("\n").trim();
}

export default function (pi) {
  pi.on("before_agent_start", async (event, _ctx) => {
    const loaded = loadAll();
    if (!loaded) return undefined; // no memory files → nothing to inject
    if (!cache || cache.key !== loaded.key) cache = loaded;

    // 规则块：置顶 + 强指令。放在 system prompt 最前面，优先于其他背景信息。
    const rulesBlock = cache.rules
      ? `<rules>\n${cache.rules}\n</rules>\n\n每次回复前必须先核对上方 <rules>，违反其中任何一条都是事故，不得违反。`
      : "";

    return {
      systemPrompt:
        (rulesBlock ? `${rulesBlock}\n\n` : "") +
        `${event.systemPrompt ?? ""}\n\n<memory>\n${cache.content}\n</memory>`,
    };
  });
}
