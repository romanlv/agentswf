---
title: End a run at its deadline, not minutes after
summary: Two runs in story 008's trial passed their own deadline by 5 and 14 minutes before awf run returned; a scorer's time and budget assume the deadline holds.
type: story
status: todo
discovered_in: "story 008, the trial"
depends_on: ["008"]
---

# End a run at its deadline, not minutes after

Why it matters: `awf-lab` gives every variant and judge a timeout, and its records, time per phase
and budget all assume a run ends near it. Two did not, on 2026-09-27:

- The panel judge, `--timeout 20m`: started 07:47:31, deadline 08:07:31, `output.json` finished
  08:21:58. Its claude judge's second turn, a re-ask, was delivered at 08:05:17 and settled at the
  deadline; the run then took 14½ minutes more to end. Outcome `timed-out`, as it should be.
- The catalogue review, `--timeout 45m`: the run's wall time was 50 minutes.

Notes: the end-of-run accounting read is bounded (`run-usage.ts`, `settle`: a grace plus the
status timeout), so the time is spent elsewhere, most likely stopping a headless turn that did not
end with the deadline, or closing panes. `createHeadlessRunHostFactory` is given the whole run's
timeout as `turnTimeoutMs`, measured from each turn's start; a turn started late in the run would
then outlive the run by up to that much. Measure first: time each phase of a run's close on a fake
headless agent that ignores its abort, then decide the bound. The run directories are in the
project's autoresearch repository under `runs/`, not committed.
