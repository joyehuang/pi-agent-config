/**
 * Rate-limited outbound Telegram transport and private recovery journal.
 * Zones: telegram transport, filesystem, delivery lifecycle
 * Does not own polling, rendering, pairing, or permission to replay old messages.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveTelegramTempDir } from "./paths.ts";

interface SendContext {
  priority: "final" | "background";
  isActive: () => boolean;
  originalText?: string;
  requestId?: string;
  activityId?: string;
  route?: string;
  placement?: string;
  source?: string;
  target?: {chatId: number; threadId?: number};
  replyTo?: number;
  replyIntent?: string;
  replyPart?: number;
  nextReplyPart?: number;
}
const context = new AsyncLocalStorage<SendContext>();
export function withTelegramSendContext<T>(value: SendContext, work: () => T): T {
  return context.run(value, work);
}

export interface TelegramSendCorrelation {
  requestId?: string; activityId?: string; route?: string; source?: string; placement?: string; replyTo?: number; replyIntent?: string; replyPart?: number;
}
export function parseTelegramSendCorrelation(value: unknown): TelegramSendCorrelation {
  const out: TelegramSendCorrelation = {};
  if (!value || typeof value !== "object") return out;
  const data = value as Record<string, unknown>;
  for (const key of ["requestId", "activityId", "route", "source", "placement"] as const) {
    if (typeof data[key] === "string" && data[key].length <= 256) out[key] = data[key];
  }
  if (typeof data.replyTo === "number" && Number.isSafeInteger(data.replyTo)) out.replyTo = data.replyTo;
  if (typeof data.replyIntent === "string" && /^[a-f0-9]{64}$/.test(data.replyIntent)) out.replyIntent = data.replyIntent;
  if (Number.isSafeInteger(data.replyPart) && Number(data.replyPart) >= 0) out.replyPart = Number(data.replyPart);
  return out;
}
export function getTelegramSendCorrelation(): TelegramSendCorrelation {
  const captured = context.getStore();
  const correlation = parseTelegramSendCorrelation(captured);
  if (captured?.replyIntent && correlation.replyPart === undefined) {
    correlation.replyPart = captured.nextReplyPart ?? 0;
    captured.nextReplyPart = (captured.nextReplyPart ?? 0) + 1;
  }
  return correlation;
}

export interface SendScope {
  profile: string;
  token: string;
  ownerEpoch: string | number | undefined;
  pairedUserId: number | undefined;
}
export interface SendQueueOptions {
  directory: string;
  getScope: () => SendScope;
  canRetryTarget?: (body: Record<string, unknown>) => boolean;
  getTargetIdentity?: (body: Record<string, unknown>) => string;
  record: (category: string, error: unknown, details?: Record<string, unknown>) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  intervalMs?: number;
  maxRetryMs?: number;
}
export interface TelegramSendQueue {
  run: <T>(method: string, body: Record<string, unknown>, request: () => Promise<T>, signal?: AbortSignal) => Promise<T>;
  getError: () => string | undefined;
}
interface Job {
  priority: number;
  readyAt: number;
  active: () => boolean;
  attempt: () => Promise<void>;
}
const transient = new Set(["sendChatAction", "sendMessageDraft", "sendRichMessageDraft"]);
const journaled = new Set(["sendMessage", "sendRichMessage"]);
function identity(scope: SendScope): string {
  return createHash("sha256").update(JSON.stringify([scope.profile, scope.token, scope.pairedUserId])).digest("hex").slice(0, 24);
}

export function createTelegramProfileSendQueue(ports: {
  getProfileName: () => string | undefined;
  getBotToken: () => string | undefined;
  getOwnerEpoch: () => string | number | undefined;
  getPairedUserId: () => number | undefined;
  listTargets: () => Array<{ target: { chatId: number; threadId?: number }; status: string; instanceId?: string; owner?: unknown }>;
  record: SendQueueOptions["record"];
}): TelegramSendQueue {
  const findTarget = (body: Record<string, unknown>) => ports.listTargets().find((record) =>
    String(record.target.chatId) === String(body.chat_id) && String(record.target.threadId) === String(body.message_thread_id));
  return createTelegramSendQueue({
    directory: join(resolveTelegramTempDir(), "outbox"),
    getScope: () => ({ profile: ports.getProfileName() ?? "default", token: ports.getBotToken() ?? "",
      ownerEpoch: ports.getOwnerEpoch(), pairedUserId: ports.getPairedUserId() }),
    canRetryTarget: (body) => body.message_thread_id === undefined || findTarget(body)?.status === "active",
    getTargetIdentity: (body) => {
      if (body.message_thread_id === undefined) return "classic";
      const record = findTarget(body);
      return JSON.stringify([record?.owner, record?.instanceId, record?.status]);
    },
    record: ports.record,
  });
}

export function createTelegramSendQueue(options: SendQueueOptions): TelegramSendQueue {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  }));
  const jobs: Job[] = [];
  const states = new Map<string, { cooldown: number; nextSend: number; files: Set<string>; failures: Set<string> }>();
  let pumping = false;
  let currentJob = false;
  const stateFor = (key: string) => {
    let state = states.get(key);
    if (!state) {
      let files: string[] = [];
      try { files = readdirSync(options.directory).filter((name) => name.startsWith(`${key}-`) && name.endsWith(".json")); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      // Recover only the cooldown, never authority to replay an old message.
      const cooldown = files.reduce((until, file) => {
        const record = JSON.parse(readFileSync(join(options.directory, file), "utf8"));
        return Number.isFinite(record.retryAt) ? Math.max(until, record.retryAt) : until;
      }, 0);
      state = { cooldown, nextSend: 0, files: new Set(files), failures: new Set(files) };
      states.set(key, state);
    }
    try {
      const notifications = JSON.parse(readFileSync(join(options.directory, "..", "notification-cooldowns.json"), "utf8"));
      if (Number.isFinite(notifications[key])) state.cooldown = Math.max(state.cooldown, notifications[key] * 1_000);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return state;
  };
  async function pump() {
    if (pumping) return;
    pumping = true;
    try {
      while (jobs.length) {
        // Re-select after every short wait: a new final must not sit behind a
        // background retry, and lost transport authority must cancel promptly.
        const ready = jobs.filter((job) => !job.active() || job.readyAt <= now());
        ready.sort((a, b) => a.priority - b.priority);
        const job = ready[0];
        if (!job) { await sleep(Math.min(250, Math.max(1, Math.min(...jobs.map((item) => item.readyAt)) - now()))); continue; }
        jobs.splice(jobs.indexOf(job), 1);
        currentJob = true;
        try { await job.attempt(); } finally { currentJob = false; }
      }
    } finally { pumping = false; }
  }
  const queue: TelegramSendQueue = {
    getError() {
      try {
        const state = stateFor(identity(options.getScope()));
        return state.failures.size ? `${state.failures.size} outbound message(s) pending or requiring delivery review` : undefined;
      } catch { return "Cannot read outbound recovery journal"; }
    },
    async run<T>(method: string, body: Record<string, unknown>, request: () => Promise<T>, signal?: AbortSignal): Promise<T> {
      // Long polling and control-plane queries must never occupy the send lane.
      if (!/^(send|editMessage|editRichMessage)/.test(method)) return request();
      const scope = options.getScope();
      const key = identity(scope);
      const state = stateFor(key);
      const captured = context.getStore();
      const targetIdentity = options.getTargetIdentity?.(body);
      const active = () => {
        const live = options.getScope();
        return scope.ownerEpoch !== undefined && !signal?.aborted && (captured?.isActive() ?? true)
          && targetIdentity === options.getTargetIdentity?.(body)
          && key === identity(live) && scope.ownerEpoch === live.ownerEpoch;
      };
      const ephemeral = transient.has(method);
      if (ephemeral && (jobs.length || currentJob || now() < Math.max(state.cooldown, state.nextSend))) return true as T;
      const filename = `${key}-${randomUUID()}.json`;
      const path = join(options.directory, filename);
      const durable = journaled.has(method);
      const started = now();
      const deliveryId = randomUUID();
      const ledger = (status: string, messageId?: unknown) => {
        if (ephemeral) return;
        try {
          mkdirSync(options.directory, { recursive: true, mode: 0o700 });
          appendFileSync(join(options.directory, "delivery-ledger.jsonl"), JSON.stringify({
            timestamp: now(), delivery_id: deliveryId, request_id: captured?.requestId ?? null,
            activity_id: captured?.activityId ?? null, route: captured?.route ?? "transport", placement: captured?.placement ?? null,
            source: captured?.source ?? "unknown", profile: scope.profile,
            target: body.chat_id ?? captured?.target?.chatId ?? null, thread: body.message_thread_id ?? captured?.target?.threadId ?? null,
            reply_to: (body.reply_parameters as { message_id?: number })?.message_id ?? captured?.replyTo ?? null,
            hash: createHash("sha256").update(JSON.stringify(body.text ?? body.rich_message ?? body.caption ?? "")).digest("hex"),
            operation: method.startsWith("edit") ? "edit" : "send", method,
            message_id: messageId ?? body.message_id ?? null, status,
          }) + "\n", { mode: 0o600 });
        } catch { options.record("outbound", "Delivery ledger unavailable", { method }); }
      };
      let knownNotCommitted = true;
      let retrying = false;
      let rateRejections = 0;
      let waitingSince: number | undefined;
      let waitedMs = 0;
      const persist = (status: string, details: Record<string, unknown> = {}) => {
        if (!durable) return;
        mkdirSync(options.directory, { recursive: true, mode: 0o700 });
        const temporary = `${path}.${randomUUID()}.tmp`;
        try {
          writeFileSync(temporary, JSON.stringify({ version: 1, profile: scope.profile, identity: key,
            method, body, originalText: captured?.originalText, status, createdAt: started,
            updatedAt: now(), ...details }), { mode: 0o600, flag: "wx" });
          renameSync(temporary, path);
        } finally {
          try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        }
        state.files.add(filename);
        if (status === "rate-limited" || status.startsWith("held-")) state.failures.add(filename);
      };
      persist("queued");
      return new Promise<T>((resolve, reject) => {
        const job: Job = {
          priority: captured?.priority === "final" ? 0 : ephemeral ? 3 : captured?.priority === "background" ? 2 : 1,
          readyAt: 0,
          active,
          async attempt() {
            try {
              stateFor(key);
              if (waitingSince !== undefined) {
                waitedMs += Math.max(0, now() - waitingSince);
                waitingSince = undefined;
              }
              if (!active() || (retrying && options.canRetryTarget && !options.canRetryTarget(body))) {
                // Unsent commentary cancelled at settlement is intentionally
                // dropped. An already attempted final stays recoverable.
                if (durable && knownNotCommitted && captured?.priority === "background") {
                  unlinkSync(path);
                  state.files.delete(filename);
                  state.failures.delete(filename);
                } else if (durable) persist("held-stale-authority");
                throw new Error("Telegram outbound request cancelled: delivery authority changed");
              }
              if (now() - started - (captured ? waitedMs : 0) >= (options.maxRetryMs ?? 10 * 60_000) || rateRejections >= 10) {
                persist("held-retry-deadline", { retryAt: state.cooldown });
                throw new Error("Telegram rate-limit recovery deadline exceeded; reply retained in outbox");
              }
              const readyAt = Math.max(state.cooldown, state.nextSend);
              if (readyAt > now()) {
                if (ephemeral) { resolve(true as T); return; }
                waitingSince = now();
                job.readyAt = readyAt;
                jobs.push(job);
                return;
              }
              // Write before network IO. A crash here is ambiguous, never an
              // instruction to replay automatically in another Pi session.
              persist("in-flight");
              knownNotCommitted = false;
              ledger("unknown");
              try {
                const result = await request();
                if (durable && captured?.replyIntent && typeof (result as { message_id?: number })?.message_id !== "number") {
                  throw Object.assign(new Error("Telegram reply receipt is unknown"), { name: "TelegramApiCommitUnknownError" });
                }
                ledger(typeof (result as { message_id?: number })?.message_id === "number" || method.startsWith("edit") ? "success" : "unknown", (result as { message_id?: number })?.message_id);
                if (durable) {
                  try {
                    persist("confirmed", { receipt: result });
                    unlinkSync(path);
                    state.files.delete(filename);
                    state.failures.delete(filename);
                  } catch (error) {
                    // A filesystem cleanup failure does not undo Telegram's
                    // acknowledgement. Never turn it into a resend/fallback.
                    state.failures.add(filename);
                    options.record("outbound", error, { method, phase: "confirmed-journal-cleanup", confirmed: true });
                  }
                }
                options.record("outbound", "Telegram outbound delivery confirmed", { method, pending: state.files.size });
                resolve(result);
              } catch (error) {
                const response = error as { status?: number; retryAfterSeconds?: number; name?: string };
                ledger(response.name === "TelegramApiCommitUnknownError" || !response.status || response.status >= 500 ? "unknown" : "failure");
                if (response.status === 429) {
                  knownNotCommitted = true;
                  retrying = true;
                  rateRejections++;
                  const delay = Math.max(1_000, (response.retryAfterSeconds ?? 1) * 1_000);
                  state.cooldown = Math.max(state.cooldown, now() + delay);
                  if (ephemeral) { resolve(true as T); return; }
                  persist("rate-limited", { retryAt: state.cooldown });
                  options.record("outbound", "Telegram rate limited; reply retained for retry", { method, retryAfterMs: delay });
                  job.readyAt = state.cooldown;
                  waitingSince = now();
                  jobs.push(job);
                  return;
                }
                persist(response.name === "TelegramApiCommitUnknownError" ? "held-commit-unknown" : "held-failed");
                throw error;
              } finally {
                state.nextSend = now() + (options.intervalMs ?? 1_100);
              }
            } catch (error) {
              options.record("outbound", error, { method, pending: state.files.size });
              reject(error);
            }
          },
        };
        jobs.push(job);
        void pump().catch((error) => {
          options.record("outbound", error, { phase: "send-queue" });
          reject(error);
        });
      });
    },
  };

  // A physical send reservation lives at the owner transport, including follower
  // calls. Only assistant-output explicitly supplies this logical reply intent.
  // Queue finals/quotes, edits, drafts, and media never participate.
  const replies = new Map<string, Promise<unknown>>();
  const canonical = (value: unknown): unknown => Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]))
      : value;
  return {
    getError: queue.getError,
    async run<T>(method: string, body: Record<string, unknown>, send: () => Promise<T>, signal?: AbortSignal): Promise<T> {
      const captured = context.getStore();
      if (!journaled.has(method) || captured?.route !== "assistant-output" ||
          !captured.activityId || !captured.replyIntent) return queue.run(method, body, send, signal);
      const scope = options.getScope();
      if (scope.ownerEpoch === undefined || signal?.aborted || !captured.isActive()) {
        throw new Error("Telegram outbound request cancelled: delivery authority changed");
      }
      const part = captured.replyPart ?? captured.nextReplyPart ?? 0;
      if (captured.replyPart === undefined) captured.nextReplyPart = part + 1;
      const replyKey = createHash("sha256").update(JSON.stringify([
        identity(scope), scope.ownerEpoch, options.getTargetIdentity?.(body),
        captured.activityId, captured.requestId, captured.source, captured.replyIntent,
        part, method, canonical(body),
      ])).digest("hex");
      const existing = replies.get(replyKey);
      if (existing) {
        // Return the original result/unknown rejection, never mint another
        // delivery_id or success row. This is logical reuse, not another send.
        options.record("outbound", "Logical reply delivery reused", { method, replyKey });
        return existing as Promise<T>;
      }
      // Never evict in-flight/unknown/success evidence and quietly allow a
      // duplicate. A bounded process-local index fails visibly at capacity.
      if (replies.size >= 16384) throw new Error("Logical reply index full; delivery review/reload required");
      let resolve!: (value: T) => void;
      let reject!: (error: unknown) => void;
      const reservation = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
      replies.set(replyKey, reservation);
      void queue.run(method, body, send, signal).then(result => {
        if (typeof (result as { message_id?: number })?.message_id !== "number") {
          reject(Object.assign(new Error("Telegram reply receipt is unknown"), { name: "TelegramApiCommitUnknownError" }));
        } else resolve(result);
      }, error => {
        const response = error as { status?: number; name?: string };
        // Only a definitive API rejection permits a new physical attempt.
        // Unknown ACK (including bus loss) retains the rejecting reservation.
        if (response.name !== "TelegramApiCommitUnknownError" && response.status && response.status >= 400 && response.status < 500) replies.delete(replyKey);
        reject(error);
      });
      return reservation;
    },
  };
}
