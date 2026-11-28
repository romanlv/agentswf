---
title: A fork's timeout is its own, in code as well as in words
type: story
status: todo
priority: P1
epic: long-runs
discovered_in: "factory review in production, runs 2619, 2638 and 2639, 2026-11-27"
depends_on: []
---

# A fork's timeout is its own, in code as well as in words

An author can tell a fork that ran out of its own time from the run's deadline without comparing
dates, and the fork's limit holds up on a loaded machine.

Why it matters: on 2026-11-27, three factory review runs ended about 6 minutes into a 60-minute
attempt. A lens fork had passed its fixed 60 s and rejected with the run deadline's
`DeadlineExceededError`, whose message gave only a timestamp. The factory's `flow.ts` took it for
the run's deadline and ended the run. Its fix compares `error.deadline` with `wf.deadline`, so a
failed fork now costs only its lens. The message now names the fork:
`the fork of agent {parent} as {key} took longer than 60s (deadline exceeded at …)`. In code, that
date comparison is still the only way to tell the two apart.

## Design question: how an author tells a fork's timeout apart

This is part of the published author surface, so it is designed before it is built (ADR 0001,
story 039: one way to do each thing).

- **Today, with no new surface.** `error instanceof DeadlineExceededError && error.deadline.getTime()
  === wf.deadline?.getTime()` is the run's deadline. Any other date is an operation's bound. It
  works, but every author has to find it, and it misses the case where a stage's or a `parallel`
  scope's deadline is the earlier one, since that is not `wf.deadline`. Documenting it is the
  cheapest step.
- **A field on `DeadlineExceededError`**, for example `of: "run" | "scope" | "call" | "fork"`. One
  class and one `instanceof`, and the run's end reads as `error.of === "run"`. Every place that
  throws the error has to know whose deadline it is. The harness throws it from inside a fork with
  only a date, so the engine would relabel it, as it now relabels the message. Adding a value later
  widens a published union.
- **A subclass**, for example `ForkTimeoutError extends DeadlineExceededError`, carrying the agent's
  key. Code that catches `DeadlineExceededError` keeps working, and `instanceof ForkTimeoutError`
  is exact. But it is a second way to catch the same failure, and it means a class per bound if
  `call` and `scope` follow.
- **A fork's timeout is a fork failure, not a deadline.** A plain `Error` with the message, like
  the fork's other failures (`the agent did not settle before its fork`). The author's run-deadline
  check, `instanceof DeadlineExceededError`, then means only the run's, a scope's or the call's own
  `timeout`. This is the smallest surface and probably the most honest one: 60 s is the engine's
  limit, not one the author set. The cost is that code which retries on "any timeout" no longer
  sees this one as a timeout.

Leaning: the last option, with the date comparison documented for scopes. Decide before building.

## The limit under load

- Checked in code on 2026-11-28: the 60 s (`FORK_TIMEOUT_MS`, `packages/engine/src/workflow-runner.ts`)
  starts once the fork reaches the front of the parent's queue, not while it waits behind the
  parent's active turn (`#queueActive`). A test in `fork.test.ts` covers this. So a fork behind a
  long turn does not time out before it starts.
- What the 60 s does cover, in `packages/harness`. First, `afterFinishing` waiting out an answered
  turn that has not ended yet, for up to half the bound before it stops that turn
  (`session-core.ts`). For a Herdr pane, it also covers the agent settling and its session file
  being written (`forkPane` in `herdr.ts`). Last comes the harness's own fork process. Under a load
  average of 19–29 with TUI panes, these together took longer than 60 s. Measure which one before
  choosing a new limit.
- A copied fork, one whose child has its own home or sandbox, forks again as the child activates.
  That fork has its own minute (`FORK_ACTIVATION_MS`, `harness/src/adapters/fork.ts`) and still
  rejects with the bare `Deadline exceeded at …`. Naming it needs the harness to say which of
  activation's several bounds passed.
- Related: [[concurrent-agents]] (the load), [[woken-run-bounds]] (a woken run's deadline).
