---
title: Going on from a stopped run
type: story
status: todo
priority: P1
epic: long-runs
discovered_in: "implement-ticket flow.ts live runs, AIRS-1515, 2026-10-02"
depends_on: [turn-liveness-and-limits, "018"]
---

# Going on from a stopped run

A run that stops says where and how to go on, and can keep its failed agent open so a person
finishes the step and the run continues.

Why it matters: the first live run of implement-ticket stopped after an hour, in the last turn of its
last stage. What awf left behind:

- The pane said `Stopped at qa: mr environment: agent settled without an accepted result`, and
  `report.md` held that one line.
- Neither named the turn, the worker's native session, or a way to go on.
- awf closed the worker's pane and killed its background tasks.

Going on took digging:

1. Find the run dir, then the call, then `output.json` for the session id.
2. `claude --resume 5dbd8155-…` to talk to the worker by hand. That route doesn't update the
   workflow's record, so the run never finishes.
3. Or rerun `--from qa`, which redoes the ~27m local half that had passed.

A stop is often recoverable by a person in minutes, and the run's state is worth keeping until
they do.

## What to build

1. **A stop says where and how to go on.** On any stop, failure or cancel, the operator output and
   `report.md` name:
   - the stage and turn (label), and why;
   - each agent with its native session and the command that reopens it (`claude --resume …`, the
     codex session id), and where its pane was;
   - the workflow's continue command, e.g. `--from-stage qa`.

   The engine knows the agents and sessions, and with stages the stage. The continue command is the
   workflow's to state, through its stopped result or a `present` hook.
2. **A debug mode.** With `awf run --keep-on-failure` (name open), a turn that ends unanswered, blocked
   or failed doesn't close its agent:
   - The pane stays open with the session live. A person can talk to the agent, finish the step, and
     have it submit the result with `wf result`, or answer it themselves.
   - The run waits on that open turn, and continues when an answer is accepted. It uses the same
     open-turn mechanism `turn-liveness-and-limits` needs for background work, here answered by a
     person.
   - Bounded by its own deadline, so a forgotten run ends and reports as in (1).
   - The progress view shows the run as waiting on a person, with the pane to go to.
3. **Continue from a stage**: [[018-workflow-stages|story 018]] builds the continue with fresh
   agents (`--continue {run} --from-stage {stage}`, [[runs-and-stages]]). What's left here:
   - reopening each agent's native session (`claude --resume`) on a restart, rather than opening
     fresh ones; this needs reopening measured per harness;
   - `--skip-stage` and stale-record checks (`fresh`), which 018 lists as later.
   Splitting a stage's turns finer (here `qa-local` and `qa-mr`) is the workflow's call.

## Open questions

- Is (2) a run-level mode, a per-turn option, or both? A workflow may want it only for its expensive
  turns.
- What happens to the run's other agents while it waits: kept, released, or per placement? A
  headless agent has no pane to open; it needs `--resume` in a new pane.
- How (2) relates to `--here` (ADR 0010), where the operator's own session is an agent and a
  stop already returns control to them.
- Checkpoints (foundation.md §7, §12 Stage 4) are a human admission barrier on purpose. A debug wait
  is a human barrier by accident. Should they share a mechanism?

## Related

- `turn-liveness-and-limits`: the open turn and late answers.
- [story 018](../018-workflow-stages.md): knowing which stage stopped; it leaves starting from a stage here.
- `operator-run-observation`: where a stopped run's state would be read.
- ADR 0010: the calling session as an agent.
- The run notes: `~/dev/braintrust/agent/workflows/implement-ticket/run-notes.md`.
