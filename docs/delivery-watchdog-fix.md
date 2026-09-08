# Delivery / watchdog handoff

Implementation only; production has not changed. The owner must independently review the commit and run the offline verifier before installation. This change does not alter model defaults or notification channel defaults.

## Offline verification

```sh
python3 scripts/verify_offline.py
python3 scripts/deploy_fix.py
```

The verifier copies the installed public pi-telegram package into a temporary directory, checks all patched file SHA-256 baselines, applies the patch, and uses fake senders. It supplies the installed Pi 0.84.1 peer modules and the same legacy TypeBox mapping as Pi's loader. It also runs Python runner, concurrency, crash, receipt, and isolated deployment tests. It does not load private configuration into a model, launch Pi/herdr agents, or send network notifications.

The installation baseline has TypeScript diagnostics under the standalone compiler invocation. Baseline and patched output are retained separately; the verifier fails on newly introduced diagnostics. This is not a claim that the entire upstream installation typechecks cleanly.

## Ownership and delivery

The patch is specific to pi-telegram 0.27.12 with the current operator's existing send-queue/footer patches. A version match alone is insufficient: every changed file must match its recorded complete checksum. Applying to an upstream clean npm copy or a different local patch set fails closed.

New queue-turn identity or a changed target rotates activity ownership before output classification. Retries of the same queue object retain identity. A settled callback captures the activity before awaiting queue lifecycle work and may release it only when the host is idle and the identity still matches. Telegram final segments stay with queue; autonomous final and legal intermediate output remain available. No global text deduplication is added.

The existing send queue now appends a private hash-only `delivery-ledger.jsonl` beside its existing private recovery journal. It records request/activity, route/source/profile, target/thread/reply-to, hash, send/edit, message id and success/failure/unknown. A write-ahead unknown row remains if a process exits while awaiting the API. It never logs message text or tokens. Follower API envelopes carry only allowlisted correlation fields through the existing authenticated bus; the leader restores that context after generation/target authorization. A real local-socket test loses the bus ACK after a confirmed Telegram stub send without repeating the API call. Existing recovery journals containing text are private and must not be published. Unknown API acknowledgements must be reconciled manually, never blindly resent.

The bridge provides a local read-only owner port, evaluated from its actual lock ownership, current context and queue state. Relay accepts only the current main `run-pi.sh` child, in TUI mode, on the requested profile/session/target, with both host and Telegram queues idle. It does not use guessed main-owner environment variables or shared snapshots as authority. If the main instance is disconnected, a follower, or absent, notices remain pending. A future deliberate move of the main role to a follower requires an explicit role-handoff policy; no test Pi may claim the role merely by being idle.

## Task/run protocol

Private state lives under `~/.config/agent-tasks`: registry, inbox, sender receipts and immutable `runs/<task>/<run>/result.json`. Files written by the protocol are 0600. Every writer uses flock plus atomic replacement; watchdog probes outside the lock and compares the exact probed task before merging into the latest document. Locks do not protect against old external writers ignoring the lock.

Create a private spec file with instruction, acceptance, artifacts, done_marker, type and route. Herdr specs additionally use unambiguous agent_name/workspace_id/pane_id. Route defaults to the existing `personal` profile. Optional session_id and target bind work to a specific session/thread; omit session_id to follow the main instance's current session.

```sh
python3 ~/bin/task_protocol.py register task-id --spec /private/task-spec.json
python3 ~/bin/task_protocol.py start-run task-id --run-id run-001
python3 ~/bin/task_protocol.py run task-id run-001 -- /absolute/path/to/worker arg
python3 ~/bin/task_protocol.py result task-id run-001
```

The runner owns the child process and its wait exit code. It exports its own documented worker protocol variables `TASK_ID`, `TASK_RUN_ID`, `TASK_RESULT_PATH`. The worker writes a fresh business JSON at that exact path, with matching task_id/run_id and reason/error. Use reason `goal_complete` only when the authorized execution objective has been reached, `batch_finished` for a completed batch, and an explicit boundary/error such as read_error, http_error, page_budget or time_budget otherwise. Print the completion marker as a standalone stdout output line after work. Do not run the terminal transcript or a prompt file through this stdout channel as a substitute for actual worker output.

A run result contains process birth identity, start/end, runner exit code, marker observation, artifact size/mtime/hash/freshness, reason/error and output hashes. Existing, empty, absent or unchanged artifacts are conservative failures to establish readiness; an empty list is never positive evidence. Arbitrary ps/herdr status never supplies an exit code. Herdr is resolved by absolute path and its failures retain unknown evidence. Working/blocked/done/unknown are parsed from the real nested CLI schema as described below; terminal `done` or a marker inside prompt echo never supplies readiness. Adopt the runner contract for new herdr supervisors. Existing unwrapped herdr agents require manual reconciliation, not invented success.

Result creation uses an immutable atomic link; duplicate identical producers converge and conflicting results fail. Registry transition and stable task/run/phase outbox event commit together. `batch_finished`, `ready_for_review`, `verified`, and `reported` remain separate.

## Notification receipts and review

`notify-agent.py TEXT [SOURCE]` and `notify-telegram.py TEXT` remain valid. Structured agent flags are `--task-id`, `--run-id`, `--event-id`, `--result-path`, and `--route`. Alternatively supply `--phase` with task/run to derive the same stable event id as watchdog. Only the display body is truncated to 500 characters; identity and result reference are separate.

Watchdog keeps both existing targets enabled. Before sending an unsent event, it rechecks the current task/run: notices for replaced runs or closed/reported tasks, and readiness notices already overtaken by verification/rework, become `superseded` instead of arriving late as misleading status. In-flight and unknown receipts retain their uncertainty; superseding is not a success ACK. The direct user notification labels readiness as **待验收**. Each target has its own receipt and bounded exponential backoff. Agent success means durable inbox admission, not model handling or goal verification. Network timeout, missing message id, malformed response and server uncertainty are unknown, and unknown Telegram sends are held. Missing config returns nonzero. Scripts never print credential-bearing exception URLs.

Relay uses pending → claimed (lease) → enqueued → handled. It does not consume old files into `.done` or keep the only copy in memory. Injection is at least once across crashes; event id and persisted session input support reconciliation. `sendUserMessage()` is void and cannot prove acceptance: an enqueued receipt records only the injection attempt. Within the original handling deadline, current-branch persisted input suppresses duplicate injection. Expired unhandled input follows the bounded recovery path below; an inactive-branch input never suppresses the current branch. A session replacement may repeat a previously accepted notice, so the orchestrator must check task/run/event before repeating business side effects. Telegram sends remain separately non-replayable on unknown ACK.

```sh
python3 ~/bin/task_protocol.py verify task-id run-001 --evidence /private/review.txt
# Reject instead: --reject. Two reworks are allowed; further rejection is blocked.
python3 ~/bin/task_protocol.py prepare-report task-id run-001 --text-file /private/final-text.txt --target '{"chatId":123,"threadId":456}'
# Send the prepared final through the existing authorized delivery path, then:
python3 ~/bin/task_protocol.py report task-id run-001 --receipt /private/final-receipt.json
python3 ~/bin/task_protocol.py inspect
# inspect exposes the current claim id/lease and per-target receipts without inbox bodies.
python3 ~/bin/task_protocol.py ack EVENT CLAIM handled --evidence /private/handling-evidence
```

A report receipt must identify success, target, message_id and either event_id from the standalone sender ledger or delivery_id from the bridge ledger. Before delivery, prepare-report binds the expected outgoing body hash and target to this run's verification. The protocol cross-checks the actual stored receipt, the expected hash/target, and a timestamp after that intent. For bridge-rendered rich payloads, use --hash with SHA-256 of the exact JSON.stringify(body.text / body.rich_message / body.caption) representation instead of --text-file. Multi-message reports require an explicitly prepared final summary message. An unrelated successful message or a self-authored receipt JSON does not establish reported. The review file's validity against acceptance is the independent main agent's responsibility.

Done/readiness, blocked, rework, batch boundaries, verification awaiting delivery, and reconciliation states remain inspected. An overdue phase creates one stable reminder event and persistent attention_required metadata. It does not repeatedly announce completion. Handling a notification or saying “received” does not satisfy verification/report gates. Automatic execution of review work still belongs to the main agent, not watchdog or the relay.

## Migration and cutover

Before cutover, enumerate old registry writers and migrate them to register/start-run/run/verify/report or the CAS metadata `update --delta FILE --expected-hash HASH` command. The expected hash is SHA-256 of the sorted JSON task object as implemented by `task_protocol.digest`. The update command rejects direct status/result mutations.

Legacy entries, including orphan run_id values without valid runs metadata, retain fields and a private legacy snapshot. No historical run or exit code is fabricated, and historic notifications are not replayed in bulk. `migrate` annotates legacy tasks without notifications. Reconciliation may mark unproven active/done/blocked legacy work needs_reconciliation; old reported records remain unchanged.

1. Main agent reviews this commit, runs the offline verifier and checks the read-only deployment plan. Record approval for the exact commit.
2. Keep Pi and its existing notification chain running while preparing. Pause only `com.joye.task-watchdog` scheduling and wait for any old watchdog invocation to exit before code installation; otherwise an old unlocked writer may race new state. Do not change the plist or model configuration.
3. Run `python3 scripts/deploy_fix.py --apply --accepted-commit COMMIT --watchdog-paused`. This installs code with private backups. It does not restart Pi, alter registry/spool, or claim runtime activation. New notices can accumulate durably until the new relay loads; direct user fallback remains enabled.
4. Main agent performs the supervised Pi handoff using the existing restart procedure and correct pane, after its current Telegram turn finishes. Required order: confirm herdr available → gracefully restart the main Pi wrapper child → verify replacement owner heartbeat and polling/no-409 → confirm relay owner port and pending inbox. Do not restart herdr or other Pi instances.
5. After the old relay has stopped, import only pending old `.json` files with `python3 ~/bin/task_protocol.py migrate-spool ~/.pi/agent/notifications`. It leaves originals intact and is idempotent. Old `.done` files are ambiguous and require manual evidence review; they are never automatically replayed. Do not restore the old relay against unarchived imported files without reviewing duplicates.
6. Inspect legacy registry migration and adopt all producers. Resume the unchanged watchdog LaunchAgent only after the new scripts, owner routing and private state permissions pass independent acceptance. No production test message is required by the installer. Live model/client smoke remains an owner-controlled acceptance step.

## Rollback

Run `python3 scripts/deploy_fix.py --rollback BACKUP_DIR` to review, then add `--apply --watchdog-paused` while watchdog is paused. It verifies backups and current installed checksums, restores code, and preserves all new registry/inbox/result/receipt data. Supervise a main Pi restart afterwards; changed source files do not alter an already running Pi.

Keep the old watchdog paused until new-format active tasks have been manually reconciled or migrated. Restoring the old unsafe completion logic against new runs would reintroduce false completion. Pending new inbox entries also need a reviewed handoff; do not bulk replay enqueued, handled, success, or unknown receipts into the old spool. Manual/direct legacy notifications continue to work after rollback, but automatic task monitoring is deliberately held until reconciliation.

## Rework 1: live herdr state, legacy adoption and active branch recovery

The first implementation commit is `697b6a3c00bef77ce521f10b0f58bf97a10cbc8c`. Independent review passed its offline suite and then found the three missing cases below; that review does not authorize deployment of the old commit. Review and accept the new rework commit. `deploy_fix.py --accepted-commit` must equal the clean current HEAD; passing the first commit after this rework fails. The production baseline remains the pre-install version, since neither implementation has been deployed. Original result/evidence remain in the parent artifact directory; the verifier now defaults to `~/artifacts/2026-09-08/pi-delivery-watchdog-fix/rework-1`.

Installed Herdr's official `api schema --json` and a sanitized read-only `agent get` response establish `result.type=agent_info` and `result.agent.{agent_status,workspace_id,pane_id}`. The documented statuses are idle/working/blocked/done/unknown; running is supported as a defensive alias, not claimed as an observed enum. Correct-identity working keeps the task running. Blocked is recorded separately and can recover to running. Done/idle without a structured result still require reconciliation. CLI errors, not-found, unknown schema/status or identity mismatch retain an unknown observation, not immediate failure/readiness; persistent uncertainty has one stable overdue event. Runner-owned live PID birth identity is checked before the CLI and prevents a still-running supervisor from being classified as unverified. Actual immutable exit results take priority over both.

Legacy means missing valid run metadata, not merely missing run_id. An orphan run_id with absent/partial runs is annotated without fabricating results or replaying old notifications. `start-run` refuses it with an explicit adoption requirement instead of KeyError. `migrate` preserves a private legacy_snapshot and old evidence fields. For an existing task, inspect it and create a private inspection JSON with `task_id`, `task_hash`, `decision` (adopt or close), nonempty `findings`, and `references` (nonempty existing evidence file paths). Compute task_hash with task_protocol.digest on the freshly inspected task object; any concurrent change forces reinspection.

```sh
python3 ~/bin/task_protocol.py inspect
python3 ~/bin/task_protocol.py migrate
# After inspecting, choose one explicitly:
python3 ~/bin/task_protocol.py adopt-legacy TASK --run-id NEW_RUN --evidence PRIVATE_INSPECTION_JSON --expected-hash TASK_HASH
python3 ~/bin/task_protocol.py close-legacy TASK --evidence PRIVATE_INSPECTION_JSON --expected-hash TASK_HASH
```

Adoption starts a new run at the current time, retaining the old snapshot and inspection; it never relabels historical files as runner results. Use the normal runner for the new execution. Explicit closure records closed_legacy with inspection/reference hashes, emits no completion notification, and does not pretend verified/reported or invent Telegram receipts. Inspection quality remains the main agent's responsibility. Both transitions are locked and CAS guarded. This is the migration path for the existing implementation-1 task if its registry shape lacks a runs map.

Relay now uses `getBranch()` and `getLeafId()`, as documented by the installed Pi SessionManager, and fences asynchronous claims on `session_tree`. An event only on an inactive sibling does not suppress delivery on the current branch. A durable handled receipt is separate global business evidence and suppresses repeating already-handled work across branches. Merely finding a persistent input only grants the remaining time until its original 30-minute handling deadline; it does not renew that deadline forever.

At expiry, an unhandled event gets a stable `[task-recovery:EVENT]` prompt asking the main agent to reconcile existing work and resume only unfinished steps. Crash before that prompt persists allows retry of the same recovery marker after lease expiry; crash after it persists suppresses duplicate recovery. When a persistent recovery still lacks handled proof, inbox state becomes needs_attention with handling_unconfirmed, visible in inspect. It does not claim handled. Same-branch polling backs off one hour without adding messages; a new active branch can be evaluated immediately after the user quiet window. Normal watchdog review/blocked deadlines remain independent. This is bounded recovery, not a guarantee that a model will correctly complete work or an exactly-once promise.

Local caller inspection found a strict stdout consumer in QQ handoff. Bare `notify-agent.py TEXT [SOURCE]` therefore retains `queued DIGITS-DIGITS.json`; this is a durable admission token recorded as legacy_receipt in the private inbox, not a new old-format spool file. QQ uses it as a receipt id and does not open that path. Structured calls, or explicit `--json`, return JSON receipts. Other inspected callers use exit status/logs: mail-watch, mem-add/mem0, restart, daily/weekly QQ reports, friend-link, daily-intel, and the model/credit watchers. Both executable and python/-u invocation forms are covered. No caller source outside this repository was edited.

Existing legacy caller limitations remain: some ignore notifier errors or mark source items seen even on failure; mem0 has a 10-second child timeout while the notifier's pre-existing HTTP timeout is 15 seconds. Neither can be retroactively turned into reliable business retries merely by preserving CLI syntax. Reinvoking bare legacy CLI is a new event; producers that need retry identity must migrate to stable event ids. Do not replay uncertain historical notifications during deployment. The full private caller inventory records search scope/exclusions and these observations; no notification bodies or credentials are copied into it.
