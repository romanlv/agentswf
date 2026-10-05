---
title: Turn liveness and limits
type: story
status: todo
priority: P0
epic: long-runs
discovered_in: "implement-ticket flow.ts live run, AIRS-1515, 2026-10-02"
depends_on: []
---

# Turn liveness and limits

Tell a finished turn from one whose agent is still waiting on work it started, expose that in the
turn and agent state for every harness, and bound turns by progress and cost rather than wall-clock
guesses.

Why it matters: a turn ends when the harness's own turn ends, and an agent that waits ends its turn
while it waits. In the first live run of the braintrust implement-ticket workflow, the worker pushed
a lint fix, started the MR deploy wait as a Claude Code background command plus a Monitor, and ended
its turn: "a monitor will re-invoke me when the deploy finishes". Herdr showed the pane idle, awf
read that as `completed`, nudged once, got "still waiting", and settled the operation `unanswered`.
The run stopped after an hour and ~$18 of work, one step from the end, and closing the run killed
both tasks. Had the Monitor re-invoked the agent, its `wf result` would have been refused:
the slot was already `closed-operation`. Any agent that waits on a deploy, CI or a long test
does this, so it is a common case, not an edge.

The other half is the limits. Today they are wall-clock only: a turn's `timeoutMs` (that workflow
guesses `3h` for implement and QA) and the run's deadline (`--timeout 10h`). A guess either cuts off
a slow turn that is making progress or waits hours on one that hung. The nudge covers an agent
that went idle without answering, not one that is busy but stuck, or idle but waiting.

## What awf does today

- Settlement rests on one signal, Herdr's `agent_status`.
  - `herdr agent prompt --wait` returns on idle or done.
  - `settledState`/`settledOutcome` (`packages/harness/src/adapters/herdr-protocol.ts:51-62,124-138`)
    make that `completed`.
- The engine then nudges once:
  - `executeOperation` in `packages/engine/src/workflow-runner.ts:1324`;
  - text at `:1333`;
  - one nudge enforced in `packages/harness/src/session-core.ts:250-254`.
- It then closes the slot (`result-slots.ts:203-217`), and `reconcile` (`workflow-runner.ts:1834`)
  returns `unanswered: agent settled without an accepted result`.
- Nothing in `packages/` or `docs/` knows about background work.
  - foundation.md:724-727 states the rule this story revisits: an ambiguous `idle` decides nothing;
    it reads as `unanswered` and arms the one measured nudge.

## The shape to decide

1. **Pending work as harness-reported state.** A harness reports, beside settled or working, whether its
   agent has work outstanding that will re-invoke it. That means background commands, Monitors and
   scheduled wake-ups. The engine keeps the operation open while work is pending, rather than
   nudging and closing it. Where should it show?
   - In `TurnOutcome` or `OperationRecord`, so a workflow and its tests see "settled with N tasks
     still pending" or "timed out waiting on bbxx8fio7".
   - In the agent state the progress view and `awf logs` show: `worker · waiting on 1 background
     task`.
   - Decide which of these is contract (published types) and which is snapshot only.
2. **Per-harness signals**, measured before they are trusted:
   - **Claude Code:** the session JSONL awf already reads for usage
     (`packages/harness/src/usage/claude.ts`). A background Bash or Monitor start carries
     `toolUseResult.backgroundTaskId`. Its end is a `queue-operation` enqueue of
     `<task-notification>` with `<task-id>` and `<status>` (completed, killed, …), which is also what
     re-invokes the agent. Pending = started − notified.
     Background subagents (the Agent tool, run async) are pending work too, and they carry no
     `backgroundTaskId`. In the AIRS-1515 rerun, e2e-testing's evidence-page review ran as one, and
     only its `<task-notification>` (`a677bed0…`, "Agent … finished") shows in the log. So the start
     signal has to cover every kind of task, not just Bash and Monitor.
     The screen shows it too: Claude Code's status line reads `1 shell · 1 agent` while background work
     runs, which Herdr's screen-based classification could report.
     The AIRS-1515 rerun hit the pattern again: the deploy wait ran as background Bash, and a nudge
     came a minute into the turn. It also ended `blocked` while the worker was mid-tool-call, with no
     screen kept to check it (see `docs/design/tofix.md`). So the screen classification needs
     measuring here as well. The format is undocumented, and this would
     make awf's control flow depend on it, not just its accounting. The native OTel export may be
     the steadier source.
   - **Codex:** unknown. Check whether `codex exec` or app-server has background processes or
     wake-ups that outlive a turn. A headless `exec` turn ends with its process, so its work can't
     outlive it, but see `headless-orphans`.
   - **Pi, Cursor:** unknown.
   - A harness that can't report pending work keeps today's behaviour.
3. **Limits.**
   - **A no-progress limit per turn:** no activity (output, tool calls, session-log writes) for N
     minutes stops or nudges the turn, so a turn that keeps working runs on.
     - Pending work counts as progress only while the task itself shows activity, or up to its
       own bound, since a Monitor caps at 30–60 min.
     - A `tail -f` with no end must not hold a turn forever.
   - **An overall limit by cost** for a run or a stage, in place of a wall-clock guess. It needs live
     usage during a turn, not only at run end.
   - Settle how these sit beside `timeoutMs` and the scope deadline. Probably the deadline stays as the
     hard backstop and the others become the normal bounds.
4. **The open turn is shared.** Keeping an operation's slot open past the harness's own turn end,
   and accepting a late `wf result`, is the same mechanism `stopped-run-recovery`'s debug mode needs
   for an answer given by a person. Design it for both.
5. **The nudge.** When work is pending at a nudge, the nudge text should name it, or there should be
   no nudge until the work ends.

## Related

- `stopped-run-recovery`: the debug mode, which shares the open turn.
- `run-logs-and-telemetry`: activity and live usage, which the no-progress and cost limits read.
- [story 018](../018-workflow-stages.md): per-stage limits.
- `operator-run-observation`: progress state that a status command or `awf logs` would read.
- `herdr-pane-settlement`: what Herdr's idle does and doesn't prove.
- `headless-orphans`: a headless turn's commands outliving it.
- `run-through-sleep`: wall-clock bounds across a sleeping Mac.
- Story 002: cost accounting, and a cost limit's live counterpart.
- OTel: `docs/reading.md:24-29`, "we should standardise on OTel". The harness OTel exports may be the
  steadier source for both pending work and live usage.
- The braintrust run's notes, `~/dev/braintrust/agent/workflows/implement-ticket/run-notes.md`,
  hold the transcript evidence: session `5dbd8155-…`, tasks `bbxx8fio7` and `b3u5t19ze`.
