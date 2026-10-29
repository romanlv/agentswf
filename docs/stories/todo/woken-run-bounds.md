---
title: Bound a woken run, and reap one that outlives its attempt
type: story
status: todo
priority: P1
epic: long-runs
discovered_in: "cleanup audit, 2026-10-29"
depends_on: []
---

# Bound a woken run, and reap one that outlives its attempt

A run an event wakes ends by a deadline even when none was given, and `awf tick` ends the process
of an attempt that has ended but is still alive.

Why it matters: a woken run is detached and unreferenced (`engine/src/wake.ts`); it has a deadline
only if `--timeout` was recorded, and the harness's 7-day bound covers turns, not the workflow's
own code. A body wedged in JS, or spinning, is answered `nudgeLive: false` by `awf tick` and never
reaped. `awf run` now exits 2 s after its command returns, which ends a body that left a timer or a
pending call, but not one that blocks the event loop.

Notes: a default timeout for woken attempts changes what a run without `--timeout` means, so it is
the operator's choice of value and of whether it applies to runs started by hand. The reap needs
an attempt's end and its pid plus process start read together, as `previousGone` does. Also here:
liveness read when `ps` cannot answer is "gone" in `runs.ts` (`sameProcess`) and "alive" in
`run-lock.ts`; where `ps` is refused, a live run reads interrupted, `wake` continues it, and
`previousGone` does not wait. One reading, likely three-valued, should serve both.
