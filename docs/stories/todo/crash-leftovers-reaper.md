---
title: Reap what a dead awf left running
type: story
status: todo
priority: P1
epic: long-runs
discovered_in: "cleanup audit, 2026-10-29: an orphaned bun test spun under PID 1 for 3.5 days"
depends_on: []
---

# Reap what a dead awf left running

An awf that dies without its cleanup — SIGKILL, an OOM kill, a crash — leaves agents, sandboxes and
control-plane directories that a later awf finds from durable records and ends.

Why it matters: cleanup today runs only in the dying process. Harness commands run in a session of
their own (`harness/src/command.ts`, `detached: true`) and are killed by a `process.on("exit")` hook
that SIGKILL skips, and that SIGTERM and SIGHUP skip in every caller without awf's signal handlers
(`bun test`, the lab, scripts). `stopCrashed` kills only the dead awf's own group, which the
harness's groups left, and runs only when an event run is continued.

What the audit reproduced or counted:

- After SIGKILL, SIGTERM or SIGHUP of the parent, a harness command's group survives under PID 1.
- After SIGKILL of awf, srt's `cli.js` and the agent under it survive; the pid files in
  `{sandboxes}/{uuid}/pids/` that name their groups stay, and nothing reads them. Calling
  `LaunchedGroups.killAll()` on them by hand ends both.
- `/tmp/awf-XXXXXX` control-plane directories are removed only by `close()`: 267 on one machine.
- A docker box lives until its deadline plus 10 minutes, its network until the next docker open.
- `awf test` kills only its `bun test` child; what the tests started survives it.

Notes: the shape is a record each owner writes as it launches — its pid and process start, the
groups it started, its control-plane directory, its sandboxes — and a sweep that ends what a gone
owner recorded, at awf start, on `--continue` of any run, and in `awf tick`. The record is a new
part of the attempt or sandbox format, so it is designed before it is built. Signal handlers in
the harness itself, for callers that install none, collide with awf's own graceful cancel and
belong to the same design. `LaunchedGroups` already checks a group's leader against pid reuse.
The sandbox conformance suite should then test a parent killed mid-turn; today its pgrep checks
use only a `sleep &` that stays in the group.
