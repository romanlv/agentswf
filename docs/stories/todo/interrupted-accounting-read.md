---
title: Keep the spend when Ctrl-C lands during the end-of-run read
type: story
status: todo
priority: P1
epic: observability
discovered_in: "story 003, live verification"
depends_on: ["003"]
---

# Keep the spend when Ctrl-C lands during the end-of-run read

A first Ctrl-C after the work is done cuts the usage read, so the attempt ends with its spend
unknown.

Why it matters: in a live `quick-check`, a SIGINT sent after the agent had answered landed while the
run was reading session files. The run succeeded, but its result said `usage known 0/1`. An
operator who presses Ctrl-C because the run looks finished loses exactly the number they waited for.

Built by [[041-run-record-layout|041]], the record's part: a cut read writes no operation's
`spend.json`, and the next attempt reads those operations' sessions as it starts and writes it, so
the spend is no longer lost for good. Left: the attempt that was cut still shows its spend unknown,
in `out.json` and its closing line, and a run never continued never reads it.

Notes: this is story 002's design — "a stop while spend is read keeps the records as they settled" —
and story 003 kept it, so a second stop can still end a slow read. The read is bounded by
`ACCOUNTING_GRACE_MILLISECONDS` (20 s). Options: let only a second stop cut the read, as story 003
already does for the stop that ended the body; or cut it but keep what the reads so far found,
rather than nothing. `packages/engine/src/workflow-runner.ts` (the `reading` controller),
`run-usage.ts` (`settle`) and `spend.ts` (`keepSpend`).
