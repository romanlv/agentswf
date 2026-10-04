---
title: A stopped headless turn leaves its commands running
type: story
status: todo
priority: P1
discovered_in: "the run-through-sleep measurement, 2026-10-02"
depends_on: []
---

# A stopped headless turn leaves its commands running

An unsandboxed headless turn stopped at its deadline or cancelled is killed alone; the commands its
agent started keep running after the run ends.

Why it matters: `runProcess` in `packages/harness/src/command.ts` starts an unsandboxed command as
a child of awf, not in a group of its own, and `kill` sends `SIGKILL` to that child alone. A
headless agent stopped at its deadline or cancelled therefore leaves whatever it was running, a
test suite or a build, alive after the run, still writing to the worktree. On fakes, a turn whose
`sleep` children outlived its stop left them running until killed by hand. A sandboxed command runs
in its own group, and the whole group is killed (story 004, X1).

Notes: starting the unsandboxed command with `detached` and killing the group, as the sandboxed
path does, would end its descendants too, and also take it out of the terminal's process group, so
a Ctrl-C no longer reaches the agent directly; awf's own handler stops it instead. Whether an agent
that exits on its own should keep its descendants, as today, is a separate choice.
