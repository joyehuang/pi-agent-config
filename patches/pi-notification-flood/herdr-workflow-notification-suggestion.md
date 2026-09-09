# Suggested main-agent workflow update (do not install automatically)

After accepting and activating the matching notification patch, the main agent may synchronize the following convention into its workflow skill:

- Worker ready, independent review, verification, permitted rework, receipt reconciliation and obsolete-reminder disposal are internal control work. Do not issue separate direct Telegram stage notices or “old notice handled” replies.
- On a trusted task-control turn, inspect current task/run and evidence first. Perform independent acceptance and already-authorized next steps. Use `task_event_finish` with a real private handling evidence file to finish silently.
- Final business delivery still uses verify → prepare-report → actual authorized sender → report with the matching ledger. It can contain normal links and attachments.
- Ask for user input only through the explicit evidence-backed request. Watchdog retains a bounded fallback for persistent unresolved work and exhausted rework limits; do not duplicate that fallback manually.
- User-visible acceptance counts all messages attributable to the task, including automatic assistant output and separate direct sends, not just hashes per paragraph.
- A worker's implemented/offline-verified result is not production completion. The supervising main agent owns independent acceptance, safe activation and any final user report.

This file does not grant deployment, notification or restart authority, and does not modify the installed skill.
