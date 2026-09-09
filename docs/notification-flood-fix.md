# Task notification visibility and consumption fix

This commit implements and verifies the fix offline. It does **not** install production code or activate a running Pi. The main maintainer owns independent acceptance, deployment and supervised activation after the current response. No model defaults, credentials, Telegram profiles, wrapper, owner topology, QQ code or memory files change.

## Evidence and acceptance unit

The private incident audit establishes one final business delivery, eight direct Telegram phase notices, and four obsolete inbox inputs consumed after the final delivery. Each of those four caused another assistant acknowledgement. Transport deduplication was functioning: the problem was thirteen user-visible messages for one task, not thirteen copies of one payload.

The sanitized replay retains eight durable control events across three implementation/review rounds, with backlogged events continuing to be consumed after `report`. It asserts one final business delivery, zero direct phase notices, zero obsolete model inputs and zero obsolete acknowledgement replies. Separate real Agent/AgentSession/bridge tests force the assistant to emit an acknowledgement during an internal turn: it remains private. A real fake-stream user turn with a queued control event subsequently marked reported produces exactly one physical fake Telegram send, for the user's final business delivery.

The 17:15 event precedes the 18:04:26 final. Later consumption checks correspond to 18:06, 18:08, 18:09 and 18:10. Only time offsets, synthetic statuses and aliases are used in tests. The private audit and real receipts are not repository fixtures.

## Protocol changes

`emit` defaults task phases to agent delivery plus an explicit `internal` Telegram disposition. Ready, verified, rework, temporary blocked and overdue control work still reaches the main agent when current. Internal does not mean success or handled. Final business output still requires independent `verify`, immutable `prepare-report` intent and a matching actual sender ledger for `report`; these gates are unchanged.

`request-user TASK RUN --evidence FILE --text-file FILE` creates one explicit question for that run, with evidence and actual question text. It does not interpret a worker's blocked flag as a human question. A persistent unresolved phase/observation creates one `human_fallback` event per task/run after at least 30 minutes (or the longer configured review timeout). Exhausting the two permitted reworks also qualifies. Neither a transient blocked state nor a pending receipt immediately creates a direct message. The fallback reports the recorded reason, not an invented process failure. It is based on lack of registered phase progress; it does not claim to know whether a model is thinking. Human questions are deliberately limited to one unresolved recorded request per run; further questions require operator reconciliation or a new run/task.

Before claim, relay injection and actual core consumption, freshness checks compare task/run, terminal state, phase, phase reentry time and recorded actor/route binding. Retried claims retain event identity. Reentered phases and changed bindings get a distinct event when re-emitted, rather than reusing stale success. Claimed/enqueued old control records become `superseded`, with an internal disposition containing reason, prior state, registry revision, task hash and result reference. Old receipts and bodies remain. Missing registry or unknown phase is held as `needs_attention`, not labelled handled or silently claimed as business completion.

FIFO uses event creation/admission time, with admission order for equal timestamps. Retry age advances on claim, so an repeatedly retried record cannot starve fresh mail. Ready/current work remains eligible; obsolete events are removed from eligibility first. Legacy mail and private handoff without task/run remain valid and cannot gain control authority from task-event text. Corrupt registry JSON also does not break those legacy inbox records. Existing legacy stdout receipts retain `queued DIGITS-DIGITS.json`.

`start-run` now records `starting`. The registered-to-runner interval gets a 120-second grace; runner entry before PID acquisition retains its existing 30-second window. A real runner-owned PID/birth identity transitions to running. Expiry or a lost real child remains reconciliation work. No exit code is inferred from a missing PID, grace expiry or Herdr status.

## Locks, races and crash semantics

All cooperating cross-file operations lock registry then inbox. Consumers use a locked read-only registry view and write only the latest inbox under its lock. Receipt-only operations lock inbox and never acquire registry afterward. Migration writes inbox before registry; a crash between them leaves a safe prefix that an idempotent rerun completes. There is no network or subprocess sender inside these locks. Watchdog probes retain the prior snapshot/CAS merge.

Physical outbox `sending`, `unknown` and `success` records are preserved. An expired Telegram sending lease becomes unknown through the existing path. New policy never turns an uncertain physical send into unsent or repeats it to test deduplication. Late inbox ACKs cannot resurrect a superseded record. No disposal emits another event or sends an “old reminder handled” response.

There are multiple admission boundaries:

1. Claim under registry/inbox locks filters current business state.
2. Relay rechecks current owner/session/branch and `validate-notice` after its asynchronous claim/observation work.
3. The patched core checks the exact issued capability after AgentSession's asynchronous prompt preflight and again when dequeuing.
4. The agent loop checks after awaited agent-start/turn-start hooks, immediately before admitting inputs. A stale queue head is discarded while valid tail messages continue. A rejected initial control preserves pending next-turn custom context.

The final check is a local admission linearization point, not a distributed transaction with future task updates. A task can advance after consumption; that already admitted turn remains internal and must recheck current evidence before business side effects. No network lock is held around model execution. This does not promise exactly-once model processing across crashes or erased session history.

Owner changes, user activity, navigation or failed validation defer delivery with the durable lease/backoff. No unrelated queue is cleared. Existing already-running old code cannot be retroactively patched: activation requires the supervised process replacement described below. Durable old inbox records are eligible for migration; already-persisted model conversation remains evidence and is not rewritten.

## Trusted internal turns and Pi APIs

The installed Pi 0.84.1 README, complete `extensions.md`, `sdk.md`, `sessions.md` and `session-format.md`, their relevant input/structured-output examples, and the installed runtime sources were read before choosing the mechanism. Bridge README, Activity and Delivery API documents were also read. Relevant source cross-references are AgentSession `prompt`, `sendUserMessage`, queueing and event forwarding; agent-core PendingMessageQueue, agent loop and terminating tool results; SessionManager append/branch APIs; bridge lifecycle/output bindings.

The public `input` event can return `handled` before model processing, but it is fired before queueing. Queued messages do not re-fire it. `before_agent_start` does not expose a cancellation return value. `sendUserMessage` is void in the extension API. A text-prefix input hook alone therefore cannot establish consumption-time freshness.

This patch adds an explicitly local core contract, not an asserted upstream API. Relay issues an exact content-array object in a WeakMap; patched `sendUserMessage` takes its capability and carries it on a non-JSON Symbol. Task markers, mail content, quotes and fake JSON do not mint that capability. The matched core publishes an activation handshake, so a newly loaded relay with an old cached core refuses structured injection. Plain legacy input is unaffected.

At consumption the relay tracks the issued token and actual message objects. The bridge skips automatic text/preview/tool projections for that internal turn; it still runs lifecycle settlement and filters internal messages out of queued final extraction. Independent real user and custom extension prompts reset the scope. Ordinary user tool progress, formatting, quotes, attachments, chunking, threads, profiles and follower routing retain their original delivery paths. Explicit final delivery uses the existing Telegram tool/API and real ledger, so links/files remain possible. Model instructions describe when to use final delivery and explicit questions; the patch does not prevent an already-authorized local tool from making an explicit external send.

`task_event_finish` checks there is a current trusted control turn, records handling evidence, and returns the documented tool-result `terminate: true`. It does not mark the task verified or reported. Empty internal stop/error turns do not invoke `empty-reply-guard`; genuine user empty stop/error recovery, cancellation, native retry and legal duplicate new requests retain their existing behavior. No output-word regex is used. A custom session entry records which persisted input actually came from the issued capability; text-only historic markers are not trusted as capability evidence. Recovery remains bounded by the original deadline and current active branch.

## Offline verification

Run from this checkout:

```sh
python3 scripts/verify_notification_flood_fix.py --evidence /absolute/private/evidence
python3 scripts/apply_notification_flood_fix.py
```

The verifier copies actual installed public modules, including an isolated writable agent-core copy. It uses fake streams and API senders, no user configuration/provider discovery, no real notifications, no Pi process and no new dependencies. Unix socket regressions close their servers and temporary trees. The complete suite is recorded in `tests.json` with commands, log paths and exit codes. Standalone TypeScript retains existing installed-package diagnostics; the acceptance gate is no new diagnostics, with both full logs retained.

Coverage includes whole-task replay, current ready/failure/rework, explicit question, missing owner and persistent fallback, actor/route/session/branch changes, simultaneous claims, FIFO/retry fairness, corrupted registry and legacy handoff, lease/crash recovery, late receipts, migration evidence, real starting/PID lifecycle, real core queue gates including mutations in awaited hooks, next-turn context preservation, private text and terminating tool completion, real user recovery and independent custom prompts. Prior duplicate lifecycle, empty-stop/error, cancellation/backoff, delivery, transport/unknown ACK, rendering/multipart, follower lost ACK, long 429 cooldown, relay, end-to-end, protocol and rework tests are run.

Two historical installation fixtures are explicitly incompatible, not silently counted as passing: `test_deploy.py` expects the pre-delivery baseline and fails the current `lib/bindings.ts` hash guard; `test_duplicate_installer.py` treats the now-extended guard as the old duplicate-fix output and fails `empty-reply-guard.ts` output hash. Their actual failing logs are retained separately. Their applicable behavioral suites run above. `test_notification_installer.py` replaces deployment coverage with current full hashes, private backup permissions, dry-run, isolated apply/idempotence/rollback, partial replacement failure, drift refusal, partial-crash rollback and foreign-target rejection. Old test expectations for automatic phase Telegram messages and immediate running status were changed explicitly for the authorized policy; other assertions remain.

## Main-maintainer installation and activation plan

`patches/pi-notification-flood/manifest.json` pins Pi 0.84.1 and bridge 0.27.12, all nine modified file before/after hashes, and 74 untouched source guards. Changed files are three Python scripts, two extensions, AgentSession JavaScript, agent-core queue JavaScript, agent-loop JavaScript and bridge bindings. Runtime edits are exact-count operations with full output hash validation; `runtime.patch` is the audit diff. The unchanged duplicate send reservation, ownership and long-cooldown sources are guarded. This installer does not apply either historical deployment manifest. It only reuses their low-level private atomic file replacement helper.

1. Independently inspect the exact clean commit and test logs. Preserve actual main wrapper/child, owner, profile, target/thread and follower state. Do not interrupt the main maintainer's current reply or the outer supervised task runner.
2. Arrange external supervision for the existing main child. Quiesce watchdog scheduling and allow already-running watchdog writers to finish. Keep current state/receipts private. Installation code does not stop anything or alter a LaunchAgent.
3. While preparing the supervised replacement, review the default read-only installation plan. Apply only the accepted commit:

```sh
python3 scripts/apply_notification_flood_fix.py --apply \
  --accepted-commit ACCEPTED_COMMIT --watchdog-paused \
  --backup-root /absolute/private/backups
```

All outputs are staged before replacement. The backup directory is 0700 and backup files 0600. Mixed, unknown, symlinked or drifted targets fail closed. Exceptions restore only files changed by this transaction whose current hash still equals its output. A hard process crash requires the recorded rollback manifest; no installer can make nine separate path renames one filesystem transaction.

4. A **main Pi child process restart is required** because AgentSession and agent-core JavaScript are already imported. `/reload` alone only reloads discovered extensions; it cannot activate this whole patch. Finish the maintainer's current response before using the already-established supervised wrapper-child restart procedure. Preserve the existing wrapper and profile/target, and do not kill followers, create another workspace, change topology or invoke an old deployment script. The installer neither restarts nor schedules a restart.
5. With the new core and matching extensions active, inspect old notifications using the new protocol. Default migration is read-only:

```sh
python3 ~/bin/task_protocol.py migrate-notifications
# Only after reviewing the exact private state and the new main owner's activation:
python3 ~/bin/task_protocol.py migrate-notifications --apply
```

Migration preserves bodies, history and all physical receipts. It marks only provably obsolete task control inputs superseded and unsent internal phase Telegram targets internal. It does not touch legacy mail/private handoff payloads, declare done as reported, synthesize review evidence or replay success/unknown sends. Fields absent from historical evidence cannot be reconstructed; retain uncertainty and inspect it. In-memory events from the old process lose their ephemeral queue on process replacement and reconcile from durable inbox/session evidence; do not manually replay old prompts.

6. Check accepted hashes, matched core activation, current main owner identity, routing continuity, polling health and pending/internal/superseded/unknown evidence before resuming the unchanged watchdog schedule. Do not send production test notifications merely to prove installation. Live functional acceptance remains the main maintainer's responsibility.

## Rollback plan

```sh
python3 scripts/apply_notification_flood_fix.py --rollback PRIVATE_BACKUP_DIR
python3 scripts/apply_notification_flood_fix.py --rollback PRIVATE_BACKUP_DIR \
  --apply --watchdog-paused
```

Rollback is hash checked, restricted to the nine accepted targets and idempotent. It restores the immediately preceding production baseline, which already contains duplicate completion, ownership and long-cooldown fixes. It preserves registry, inbox, outbox, run evidence and receipts. Supervise another main-child restart to activate restored core modules.

Keep watchdog scheduling paused until the maintainer reconciles new `starting`, `internal` and `superseded` states with the old consumer. The old consumer does not understand superseded inbox records and must not resume blind consumption. Rollback does not translate those dispositions back to pending or resend old Telegram output. Review the durable backlog explicitly before re-enabling the previous behavior.

## Remaining limits

There have been zero real model calls, zero real messages and no production code/state changes during implementation. Offline passing does not prove live runtime activation. Processing is at least once across crashes; trusted capability state is process-local and reconstructed by re-claiming current durable events, not by trusting conversation text. Long-running internal work must still honor current task acceptance and explicit send/report gates. The synchronous final validation can block the event loop for up to its bounded 10-second local subprocess timeout under disk/lock failure; it fails closed and the durable lease remains. Other local extensions are trusted code with full process access and are not a sandbox boundary.

The suggested workflow notification convention below is documentation only. No runtime skill or memory file was edited.
