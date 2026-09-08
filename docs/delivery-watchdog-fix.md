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

A run result contains process birth identity, start/end, runner exit code, marker observation, artifact size/mtime/hash/freshness, reason/error and output hashes. Existing, empty, absent or unchanged artifacts are conservative failures to establish readiness; an empty list is never positive evidence. Arbitrary ps/herdr status never supplies an exit code. Herdr is resolved by absolute path and its failures retain unknown evidence. Terminal `done` or a marker inside prompt echo never supplies readiness; adopt the runner contract for new herdr supervisors. Existing unwrapped herdr agents require manual reconciliation, not invented success.

Result creation uses an immutable atomic link; duplicate identical producers converge and conflicting results fail. Registry transition and stable task/run/phase outbox event commit together. `batch_finished`, `ready_for_review`, `verified`, and `reported` remain separate.

## Notification receipts and review

`notify-agent.py TEXT [SOURCE]` and `notify-telegram.py TEXT` remain valid. Structured agent flags are `--task-id`, `--run-id`, `--event-id`, `--result-path`, and `--route`. Alternatively supply `--phase` with task/run to derive the same stable event id as watchdog. Only the display body is truncated to 500 characters; identity and result reference are separate.

Watchdog keeps both existing targets enabled. The direct user notification labels readiness as **待验收**. Each target has its own receipt and bounded exponential backoff. Agent success means durable inbox admission, not model handling or goal verification. Network timeout, missing message id, malformed response and server uncertainty are unknown, and unknown Telegram sends are held. Missing config returns nonzero. Scripts never print credential-bearing exception URLs.

Relay uses pending → claimed (lease) → enqueued → handled. It does not consume old files into `.done` or keep the only copy in memory. Injection is at least once across crashes; event id and persisted session input support reconciliation. `sendUserMessage()` is void and cannot prove acceptance: an enqueued receipt records only the injection attempt. When its lease expires, persisted input suppresses duplicate injection; otherwise it can be attempted again. A session replacement may repeat a previously accepted notice, so the orchestrator must check task/run/event before repeating business side effects. Telegram sends remain separately non-replayable on unknown ACK.

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

Legacy entries retain fields and legacy_status. No run or exit code is fabricated, and historic notifications are not replayed in bulk. `migrate` annotates legacy tasks without notifications. Reconciliation may mark unproven active/done/blocked legacy work needs_reconciliation; old reported records remain unchanged.

1. Main agent reviews this commit, runs the offline verifier and checks the read-only deployment plan. Record approval for the exact commit.
2. Keep Pi and its existing notification chain running while preparing. Pause only `com.joye.task-watchdog` scheduling and wait for any old watchdog invocation to exit before code installation; otherwise an old unlocked writer may race new state. Do not change the plist or model configuration.
3. Run `python3 scripts/deploy_fix.py --apply --accepted-commit COMMIT --watchdog-paused`. This installs code with private backups. It does not restart Pi, alter registry/spool, or claim runtime activation. New notices can accumulate durably until the new relay loads; direct user fallback remains enabled.
4. Main agent performs the supervised Pi handoff using the existing restart procedure and correct pane, after its current Telegram turn finishes. Required order: confirm herdr available → gracefully restart the main Pi wrapper child → verify replacement owner heartbeat and polling/no-409 → confirm relay owner port and pending inbox. Do not restart herdr or other Pi instances.
5. After the old relay has stopped, import only pending old `.json` files with `python3 ~/bin/task_protocol.py migrate-spool ~/.pi/agent/notifications`. It leaves originals intact and is idempotent. Old `.done` files are ambiguous and require manual evidence review; they are never automatically replayed. Do not restore the old relay against unarchived imported files without reviewing duplicates.
6. Inspect legacy registry migration and adopt all producers. Resume the unchanged watchdog LaunchAgent only after the new scripts, owner routing and private state permissions pass independent acceptance. No production test message is required by the installer. Live model/client smoke remains an owner-controlled acceptance step.

## Rollback

Run `python3 scripts/deploy_fix.py --rollback BACKUP_DIR` to review, then add `--apply --watchdog-paused` while watchdog is paused. It verifies backups and current installed checksums, restores code, and preserves all new registry/inbox/result/receipt data. Supervise a main Pi restart afterwards; changed source files do not alter an already running Pi.

Keep the old watchdog paused until new-format active tasks have been manually reconciled or migrated. Restoring the old unsafe completion logic against new runs would reintroduce false completion. Pending new inbox entries also need a reviewed handoff; do not bulk replay enqueued, handled, success, or unknown receipts into the old spool. Manual/direct legacy notifications continue to work after rollback, but automatic task monitoring is deliberately held until reconciliation.
