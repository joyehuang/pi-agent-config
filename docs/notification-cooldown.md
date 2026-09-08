# Emergency notification cooldown mitigation

Standalone Telegram notifications now respect the live bridge's text outbox and
yield while replies are queued/in flight/rate limited. Telegram HTTP 429
`retry_after` is persisted per bot identity, so a later watchdog invocation does
not immediately repeat a rejected request. A short shared reservation also spaces
independent notifier processes. Accepted and unknown deliveries retain existing
deduplication semantics; nothing is automatically replayed on ambiguous delivery.

This is a recovery mitigation, not a unified bridge/notifier send queue. The
companion `patches/pi-delivery/long-cooldown.patch` makes the bridge consume the
notifier's cooldown store, restore persisted cooldowns on reload, and exclude
scheduled waits from session-bound assistant retry budgets with a ten-rejection
cap. Unscoped commands retain their wall-clock budget. Existing held replies are preserved
for explicit review, not silently bulk-replayed.

Validation: 19 task-protocol/notifier tests pass, including a 476-second cooldown,
yielding to a pending bridge reply, and resuming after the gate clears. The full
Python suite reports 30 passes and one deployment-fixture error: that fixture
copies the live installed home but assumes a pre-deployment baseline.

The notifier hotfix can be loaded by new invocations without restarting Pi.

The bridge patch was validated with 17 send-queue tests, including two consecutive
476-second cooldowns, a persistent-rejection cap, reload without replay, and the
notifier cooldown. Full bridge regression has the same eight existing failures
as the earlier baseline (delivery/lifecycle/custom-footer fixtures and underscore
rendering). Full logs remain local under `/tmp/pi-long-cooldown-*.log`.
