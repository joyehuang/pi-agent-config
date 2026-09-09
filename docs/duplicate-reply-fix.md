# Duplicate completion recovery and delivery fix

This is an implementation/offline-verification handoff. Production activation belongs to the main maintainer. Use the new installer below, not the historical delivery/watchdog installer: the current package already contains that patch and the subsequent long-cooldown changes.

## Evidence and cause

The narrowed incident records show a nonempty stopped assistant completion, an automatic retry user message immediately afterward, and an identical second completion. Both physical Telegram receipts share activity, request, target, profile and payload hash, with placements `intermediate` and `terminal-partial`.

Crucially, the retry user message's **creation timestamp is much earlier than its persistence timestamp**. Bounded metadata around creation shows an empty assistant error followed by resumed tool work. The old guard queues a synthetic follow-up at that error's `agent_end`, while Pi also runs its native retry. When native recovery eventually produces a good final, the already-queued follow-up is consumed and requests another final. Successful Telegram delivery occurs later, so consulting only the success ledger at the earlier `agent_end` cannot solve this incident.

This mechanism is reproduced using the current installed Agent/AgentSession event, persistence, retry and follow-up code, a fake model stream, the actual Telegram activity/binding/rendering/send-queue modules, and a fake API. Baseline: four fake stream calls, one synthetic injection, two physical sends. Guard fix: three fake stream calls, no injection, one physical send. Sender fix alone with the old guard: four fake stream calls and one injection, but one physical send.

The current core forwards provider content events as `message_update`, while provider `done` becomes `message_end`, not a forwarded `done` update. Consequently, the bridge buffers the first completion until the retry's `text_start` flushes it as intermediate; the last candidate flushes at settlement as terminal-partial. The test reproduces these exact placements. No model fault or stale-event hypothesis is needed. The persisted incident supports this mechanism strongly; the running process's cached source bytes were not observable from file hashes, so disk/source equivalence is not a claim of historical in-memory attestation.

No real completion text, session path, message identifiers, target identifiers, or private transcript is committed. Hash/metadata evidence remains in the task's private evidence directory.

## Implementation

`empty-reply-guard.ts` evaluates **agent_settled**, after native retries, compaction and queued continuations. It reads indexed active-branch entries appended since the previous turn, never all session history. Finalized persisted messages, including extension replacements, are authoritative. A completed text candidate survives later empty run evidence until actual new input or tool work invalidates it. Tool progress is not completion evidence. Session/tree changes invalidate local state, and an unrelated consumed user input starts a fresh retry budget. Queued input does not reset the running request prematurely. Each recovery uses an issued nonce; duplicate internal input cannot reset its one-retry budget. A stale `agent_end.messages` list never controls the decision.

Pi's extension context does not expose cancellation of native retry backoff after the low-level agent has stopped. A minimal current-baseline patch adds optional `aborted` to `agent_settled` and snapshots it for both extension and SDK listeners. Explicit `abort()` and `abortRetry()` set it; a new logical prompt resets it. This prevents empty-error compensation from undoing Escape during native backoff. The existing aborted-assistant and signal checks remain. No retry/model/default configuration changes.

Assistant-output binding supplies a SHA-256 intent of the complete source segment. The owner send queue reserves the tuple of bot/profile identity, owner epoch, target binding, activity/request/source, intent, part ordinal, method, and canonical complete API body **before** starting the request. In-flight callers join; confirmed callers reuse the original API result. Intermediate/final/terminal-partial placement is deliberately absent from this tuple. Canonicalization sorts object keys only; text, formatting, arrays, quote parameters and markup remain exact.

The bus allowlist carries only intent hash and part index in addition to existing correlation, so the leader owns reservations after existing follower authorization. A follower that loses its ACK can recover the leader's original result without another API call. There is no forged `delivery_id`, success ledger row, or fresh message id for logical reuse. A separate runtime diagnostic records reuse. The existing ledger hash remains SHA-256 of `JSON.stringify(body.text ?? body.rich_message ?? body.caption ?? "")`.

Definitive API rejection releases the reservation. Unknown/network/server outcomes retain a rejecting reservation; missing message ids remain unknown with a retained journal. Existing 429 retry/long-cooldown behavior stays inside the original reservation. No persistent ledger is loaded/replayed for deduplication. Queue finals/quotes, edits/drafts and media do not opt into this boundary. Multipart ordinal preserves identical chunks within one answer; a repeated answer reuses the corresponding original chunks. New activities/sessions/requests and distinct targets/intents remain deliverable.

## Verify and install

```sh
python3 scripts/verify_duplicate_reply_fix.py --evidence /absolute/task/artifacts/verification
python3 scripts/apply_duplicate_reply_fix.py
```

The verifier writes only isolated copies and fake receipts under the supplied task artifacts, uses local Unix sockets, and closes its servers/processes. No dependencies are installed, no Pi CLI/daemon is started, and no provider/API request is made. It covers the incident, genuine stop/error recovery, explicit stream/backoff cancellation, branch/session/queued-input/stale-event cases, simultaneous sends, known/unknown receipts, long 429 cooldown, real follower serialization, HTML/Rich multipart rendering, prior delivery/relay/end-to-end regressions, protocol/rework regressions, installer faults/rollback, and compiler diagnostic comparison.

The historical `verify_offline.py` / `test_deploy.py` target the earlier predeployment baseline. They are retained for audit, not relabeled as current-baseline tests. The new verifier runs their still-applicable delivery/protocol/relay/end-to-end coverage and adds a six-file current-baseline installer test. Standalone package typechecking has existing diagnostics; the gate is **no new diagnostics**, with both logs retained.

`patches/pi-duplicate-reply/manifest.json` records full before/after SHA-256 for the extension, two bridge sources and three Pi runtime/type files. It also guards 67 unchanged bridge source files and the relevant unchanged Pi session/agent-core implementations. `fix.patch` and `host.patch` are audit diffs. Package outputs are included for deterministic preparation; host edits are exact-count replacements checked against the full output hash. Version alone is insufficient. Mixed, drifted or unknown installations fail before replacement. Default dry-run performs no writes.

After independent acceptance of the exact commit, the maintainer can run:

```sh
python3 scripts/apply_duplicate_reply_fix.py --apply --backup-root /absolute/private/backups
```

All outputs are prepared before replacement, backups are private, and replacement failure attempts to restore only the files this transaction changed. The installer does not touch owner/config/settings/models/auth/wrappers, watchdog state, outboxes or receipts, and never starts or schedules a restart. Keep the printed backup directory.

## Safe activation by the main maintainer

A **process restart is required for the complete fix**, because the patch includes loaded Pi core JavaScript. Installed `extensions.md` documents `/reload` for discovered extensions, but it does not reload the already-imported AgentSession implementation. Do not activate during the orchestrator's current reply.

1. Finish the current response and reach idle, with host and Telegram queue/delivery work drained. Record the actual main pane, wrapper PID, Pi child PID, current profile and target/thread from the existing owner/queue state. Preserve them.
2. Arrange supervision outside the Pi child that will exit. Use the existing `~/bin/restart-pi.sh` procedure with explicit `RESTART_PANE=<verified-main-pane>` and the unchanged `RUN_PI_TELEGRAM_PROFILE`. Do not invoke it from the active turn being completed. Do not target a process group or follower Pi.
3. The inspected procedure checks Herdr availability (non-destructive kickstart), locates the exact wrapper child, writes that wrapper's restart marker, sends SIGTERM, waits for the wrapper replacement and checks refreshed owner heartbeat/polling plus absence of new HTTP 409 during its observation period. It includes a force-kill fallback and existing operational notifications; the main maintainer must supervise those existing behaviors. Do not restart Herdr, kill followers, alter wrapper/defaults, or create a replacement workspace.
4. Verify replacement loaded the accepted hashes, owner/profile/target continuity, polling health and relay owner port. Inspect pending/unknown deliveries without replay. Live acceptance belongs to the main maintainer; offline completion does not claim production deployment.

Rollback plan and application:

```sh
python3 scripts/apply_duplicate_reply_fix.py --rollback /absolute/private/backups/duplicate-reply-ID
python3 scripts/apply_duplicate_reply_fix.py --rollback /absolute/private/backups/duplicate-reply-ID --apply
```

Rollback verifies both backups and current hashes, supports a partially applied transaction, preserves all receipt/state data and is idempotent. Supervise another main-child restart after rollback. Never replay old success/unknown journal entries to test rollback.

## Limits

The reservation index is process-local and capped at 16,384 entries; it fails visibly at capacity rather than evict evidence and allow duplicates. It is not cross-restart exactly-once delivery. After restart, uncertain old sends require the existing manual reconciliation workflow. Native session retry counts remain independent of the guard's one synthetic recovery. Reload intentionally does not resurrect abandoned requests; a discontinuous/unbounded branch delta fails closed. New real requests may repeat identical text. Historical process cache identity and production runtime activation still require main-maintainer assessment.
