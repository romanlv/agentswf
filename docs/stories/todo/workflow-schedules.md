---
title: A workflow that runs on a schedule
type: story
status: todo
priority: P2
epic: long-runs
discovered_in: "datadog-watcher's hourly tick, 2026-10-26; deferred by story 034"
depends_on: ["034"]
---

# A workflow that runs on a schedule

A workflow declares when it runs, such as every hour or `0 9 * * MON`, and `awf tick` starts or
wakes it when an occurrence is due, with that occurrence as its identity.

Why it matters: the Datadog watcher's triage tick must run every hour, never two at once. Without
a schedule it is a keyed event run, `dd-tick.main`, that parks with `until` an hour after its last
tick, and all three of its workarounds are the workflow's own:

- **Identity.** A wake by `until` returns no event, so nothing names the iteration a crash cut
  short. The tick keeps `dd-cases/tick.json`, `{at, done}`, out of git, to name its stages.
- **Growth.** One run gains a triage, write and commit stage, an agent and its session every hour,
  and nothing retires them.
- **Cron.** Something outside awf must run `awf tick`; nothing says how to install it.

A per-occurrence run would have none of the first two: its id is the occurrence, and it ends.
Overlap, the reason the tick became one run, is a rule only the engine can apply: whether the
previous occurrence's run is still live.

Prior art in this repo:

- [`workflow-styles.md`](../../research/workflow-styles.md) §5: `schedule: "0 9 * * MON"`, each
  occurrence a new run "so no run's record grows forever", and `workflow.timer(name, "2d")`, a
  wait recorded by its name. "Loops, the inbox and the core": every wake-up, timers and schedules
  included, is a message in the inbox.
- [[034-event-driven-runs|Story 034]] defers "schedules … and a scheduler, which can come later on
  top of `awf tick`", and compacting a run's mailbox.
- `docs/design/ideas.md`: "time intervals" and "scheduler".

Decided (2026-10-26): a schedule is declared in the workflow's code, not in a cron entry per
workflow. The one thing outside awf is what runs `awf tick` itself.

Notes, to settle when it is refined:

- **What an occurrence does:** start a new run of the workflow, with the occurrence as its id, or
  emit an event, with the occurrence as its id, to a keyed run. The second keeps one run and makes
  a clock wake an event like any other; the first ends each run. Possibly both, as two forms.
- **Overlap:** an occurrence due while the previous one's run is live is skipped, queued once, or
  started anyway.
- **Missed occurrences:** after a sleep or a reboot, run the latest once, or each one missed.
- **A wake by `until`** may be the same mechanism: a named wait whose wake arrives as an event
  with an id, so a loop can name its work by it. Whether this story or a smaller one does that.
- **What runs `awf tick`:** one launchd or cron entry per machine that `awf` installs, which
  would run `awf tick --all`, since a bare tick wakes only its own project's runs (034 task 12),
  or a long-running `awf` process; and how often, since that sets the latency of every schedule.
- **Unattended turns:** an occurrence at 03:00 may open panes (`workflow-styles.md` §5, point 5).
- **Testing:** a test that moves the clock past an occurrence needs
  [[workflow-test-virtual-time]], or a narrower clock for schedules only.
