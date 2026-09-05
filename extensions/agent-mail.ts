/**
 * agent-mail — 让 pi 直接读取 agent@joyehuang.dev 的收件箱。
 *
 * 数据源：~/dev/agent-mail/inbox/*.json（agent-mail server 落盘，每封一文件）。
 * 解决的问题：mail-watch 只推 Telegram 摘要给用户，agent 自己看不到正文；
 * 有了这个工具，用户说"看下最新邮件"或 agent 收到转发引用时可以主动查全文。
 *
 * 工具：
 *  - mail_list: 列最近 N 封（来自/主题/时间）
 *  - mail_read: 按序号或文件名读全文（自动清洗 HTML 邮件的空白填充符）
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const INBOX = join(import.meta.dirname, "..", "..", "..", "dev", "agent-mail", "inbox");

interface MailItem {
  file: string;
  from: string;
  subject: string;
  date: string;
}

function listInbox(): MailItem[] {
  try {
    return readdirSync(INBOX)
      .filter((f) => f.endsWith(".json"))
      .sort()
      .reverse()
      .map((file) => {
        try {
          const d = JSON.parse(readFileSync(join(INBOX, file), "utf8"));
          return { file, from: d.from ?? "?", subject: d.subject ?? "(无主题)", date: file.slice(0, 19) };
        } catch {
          return { file, from: "?", subject: "(解析失败)", date: file.slice(0, 19) };
        }
      });
  } catch {
    return [];
  }
}

/** 清洗邮件正文：去零宽填充符/连字符填充行/折叠 URL 前 250 字符 */
function cleanText(raw: string): string {
  return raw
    .replace(/[\u200a\u200b\u200c\u200d\ufeff\u00ad]/g, "")
    .replace(/ {3,}/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "mail_list",
    label: "列出收件箱",
    description:
      "列出 agent@joyehuang.dev 收件箱的最新邮件（来自/主题/时间/序号）。用户提到邮件、收到邮件、邮箱里有新邮件时，或需要检查 agent 邮箱有没有收到某封邮件（验证码、通知、回信）时用这个先看有什么。",
    parameters: Type.Object({
      limit: Type.Optional(Type.Number({ description: "返回条数，默认 10" })),
    }),
    async execute(_id, params) {
      const items = listInbox().slice(0, params.limit ?? 10);
      if (items.length === 0) {
        return { content: [{ type: "text", text: "（收件箱为空）" }], details: {} };
      }
      const text = items
        .map((m, i) => `${i + 1}. [${m.date}] 来自 ${m.from}\n   主题: ${m.subject}\n   文件: ${m.file}`)
        .join("\n");
      return { content: [{ type: "text", text: `收件箱共 ${items.length} 封（新的在前）：\n${text}` }], details: {} };
    },
  });

  pi.registerTool({
    name: "mail_read",
    label: "读邮件全文",
    description:
      "读取 agent@joyehuang.dev 收件箱里某封邮件的全文。先用 mail_list 拿到序号或文件名，再读正文。转发类邮件会包含转发者的留言 + 被转发的原信。",
    parameters: Type.Object({
      id: Type.String({ description: "邮件序号（mail_list 里的数字）或文件名" }),
      maxLength: Type.Optional(Type.Number({ description: "正文最大长度，默认 8000 字符" })),
    }),
    async execute(_id, params) {
      const items = listInbox();
      let target: MailItem | undefined;
      const idTrim = params.id.trim();
      if (/^\d+$/.test(idTrim)) {
        target = items[Number(idTrim) - 1];
      } else {
        target = items.find((m) => m.file.includes(idTrim));
      }
      if (!target) {
        return { content: [{ type: "text", text: `（找不到邮件 ${idTrim}，用 mail_list 先看列表）` }], details: {} };
      }
      const d = JSON.parse(readFileSync(join(INBOX, target.file), "utf8"));
      const max = params.maxLength ?? 8000;
      const body = cleanText(String(d.text ?? "")).slice(0, max);
      const truncated = (d.text ?? "").length > max ? `\n\n（正文已截断，全文 ${d.text.length} 字符）` : "";
      const html = d.html && !d.text ? cleanText(String(d.html).replace(/<[^>]+>/g, " ")).slice(0, max) : "";
      const bodyText = body || html || "（无文本正文）";
      return {
        content: [
          {
            type: "text",
            text: `【${target.subject}】\n来自: ${d.from ?? "?"}\n时间: ${target.date}\n文件: ${target.file}\n\n${bodyText}${truncated}`,
          },
        ],
        details: {},
      };
    },
  });
}
