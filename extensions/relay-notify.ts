/** Durable main-owner relay. Requires the matching pi-telegram local patch.
 * Reading, enqueueing and handling are separate receipts. Injection is at least
 * once across a crash; event_id lets the orchestrator reconcile before acting.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

type Owner = { pid: number; profile: string; session_id: string; generation: string;
  epoch: string | number; target: {chatId:number;threadId?:number}; idle:boolean; main?:boolean; leaf_id?:string|null };
type Notice = {event_id:string;claim_id:string;text:string;source?:string;task_id?:string;run_id?:string;result_path?:string};
const ownerKey = Symbol.for("joye.pi-telegram.relay-owner.v1");

export function isMainWrapper(ppid = process.ppid): boolean {
  try {
    // Actual run-pi.sh parent identity; no invented PI_MAIN_* variable.
    const command = execFileSync("/bin/ps", ["-p", String(ppid), "-o", "command="], {encoding:"utf8",timeout:2000});
    return /(?:^|\s)(?:\S*\/)?run-pi\.sh(?:\s|$)/.test(command);
  } catch { return false; }
}

export function createRelay(pi: ExtensionAPI, options: {isMain?: () => boolean; script?: string; root?: string} = {}) {
  let ctx: ExtensionContext | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let stopped = true;
  let collecting = false;
  let version = 0;
  let lastUserInput = 0;
  const script = options.script ?? path.join(os.homedir(), "bin/task_protocol.py");
  const owner = (): Owner | undefined => {
    const port = (globalThis as any)[ownerKey];
    const current = typeof port === "function" ? port() as Owner | undefined : undefined;
    if (!current || current.pid !== process.pid || !ctx || current.session_id !== ctx.sessionManager.getSessionId()) return;
    return {...current, leaf_id:ctx.sessionManager.getLeafId(), main:(options.isMain ?? isMainWrapper)()};
  };
  async function call(args: string[]) {
    const result = await pi.exec("/usr/bin/python3", [script, ...(options.root ? ["--root", options.root] : []), ...args], {timeout:10000});
    if (result.code !== 0) throw new Error("Task protocol operation failed");
    return JSON.parse(result.stdout);
  }
  async function collect() {
    const epoch = version;
    const current = owner();
    if (stopped || collecting || !current?.main || !current.idle || !ctx?.isIdle() || ctx.hasPendingMessages() || Date.now()-lastUserInput<1500) return;
    collecting = true;
    try {
      const notice: Notice | null = await call(["claim", "--owner", JSON.stringify(current)]);
      if (!notice) return;
      const live = owner();
      if (stopped || epoch!==version || !live?.idle || Date.now()-lastUserInput<1500 || JSON.stringify(live)!==JSON.stringify(current) || ctx?.hasPendingMessages()) {
        await call(["ack",notice.event_id,notice.claim_id,"pending"]);return;
      }
      const marker = `[task-event:${notice.event_id}]`;
      const recoveryMarker = `[task-recovery:${notice.event_id}]`;
      // getEntries spans inactive siblings; getBranch walks only the live leaf.
      const branch = ctx!.sessionManager.getBranch();
      const findInput = (tag:string) => branch.find((entry:any) =>
        entry.type === "message" && entry.message?.role === "user" && JSON.stringify(entry.message.content).includes(tag));
      const existing = findInput(marker);
      let recovering = false;
      if (existing) {
        const recovery = findInput(recoveryMarker);
        const args = ["observe-input",notice.event_id,notice.claim_id,"--entry-id",existing.id,"--session-id",current.session_id];
        if (recovery) args.push("--recovery-entry-id",recovery.id);
        const at = Date.parse(existing.timestamp)/1000;
        if (Number.isFinite(at)) args.push("--entry-at",String(at));
        const decision = await call(args);
        if (decision.action !== "recover") return;
        recovering = true;
        const after = owner();
        if (stopped || epoch!==version || JSON.stringify(after)!==JSON.stringify(current) || !after?.idle || Date.now()-lastUserInput<1500 || ctx?.hasPendingMessages()) {
          await call(["ack",notice.event_id,notice.claim_id,"pending"]);return;
        }
      }
      {
        // Claim remains durable if injection throws or the process dies here.
        const instructions = notice.task_id && notice.run_id
          ? `【后台任务状态事件，须核对当前状态】${notice.text}\n`+
            `task_id=${notice.task_id} run_id=${notice.run_id}\nresult_path=${notice.result_path ?? "未提供"}\n`+
            `请核对本 run 的结构化证据并按 acceptance 独立验收；不能只回复收到。通过后继续已授权步骤，记录 verify/prepare-report/report 及真实签收；`+
            `失败按协议最多返工两次。重复事件先对账再执行。`
          : `【后台通知｜${notice.source || "legacy"}】${notice.text}\n这是兼容旧 CLI 的通知，没有 task/run 登记；按原通知意图处理，不编造验收或完成状态。`;
        pi.sendUserMessage(`${recovering ? recoveryMarker : marker}\n`+
          (recovering ? `此前事件 ${notice.event_id} 的输入已持久化，但没有 handled 证据。请先核对已做步骤与签收，仅恢复未完成工作，不重复副作用。\n` : "")+`${instructions}\n`+
          `处理证据确认后使用 python3 ~/bin/task_protocol.py ack ${notice.event_id} ${notice.claim_id} handled --evidence PRIVATE_FILE；`+
          `若 claim 已变化先 inspect 对账。`, {deliverAs:"followUp"});
        // sendUserMessage is void: only a persisted user message proves admission.
        // An optimistic appendEntry here would hide asynchronous injection loss.
      }
      await call(["ack",notice.event_id,notice.claim_id,"enqueued","--evidence",current.session_id]);
    } catch {
      // Lease recovery retries persisted work. No bodies/config/error URLs logged.
    } finally { collecting=false; }
  }
  pi.on("input", (event) => { if (event.source !== "extension") lastUserInput=Date.now(); });
  pi.on("session_start", (_event, context) => {
    if (timer) clearInterval(timer);
    ctx=context;stopped=false;version++;
    timer=setInterval(()=>void collect(),4000);timer.unref?.();
  });
  pi.on("agent_settled", () => { /* Poll checks live idle and both queues after hooks settle. */ });
  pi.on("session_tree", (_event, context) => {
    ctx=context;version++;lastUserInput=Date.now();
  });
  pi.on("session_shutdown", () => {
    stopped=true;version++;if(timer) clearInterval(timer);timer=undefined;ctx=undefined;
  });
  return {collect};
}

export default function (pi: ExtensionAPI) { createRelay(pi); }
