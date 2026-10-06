---
title: Fork the calling session
type: story
status: todo
priority: P2
epic: authoring
discovered_in: "agent/workflows/review, the fixer beside the run (2026-10-06)"
depends_on: []
---

# Fork the calling session

`caller.fork({ key, layout, keepPane })`, so a workflow started with `awf run --here` can open an
agent that starts knowing what the operator's session knows, without spending that session's context
on the work. The review workflow's fixer is the use: a fork of the main session fixes the findings
in its own pane, and the main session gets the run's summary in its last `[awf]` message.

Today it is refused on purpose: `workflow-runner.ts` throws "is the calling session, which a run
does not fork", because the caller has no `opening`, which a fork copies. Nothing else stands in the
way:

- **Session id**: `--here` runs in the caller's shell, which has the harness's `sessionEnv`
  (`CLAUDE_CODE_SESSION_ID`); Herdr also reports it (`agent_session`).
- **Point**: the caller is idle between the turns awf drives, as a parent's queue gives.
- **Working directory**: the caller's, `shellCwd`; claude finds a session by project directory.
- **Skills and home**: the operator's, so nothing is copied.
- **Command**: each harness's `forkSession`, unchanged.

To decide, as an amendment to ADR 0010:

- **Model.** The caller's is `""`. Read it from the session file, or require the fork to name one:
  claude's `--resume` takes the default model, not the session's.
- **Environment.** The fork runs where awf opens agents, with awf's launch flags, not the operator's
  session, sandbox, settings or MCP servers its context was built with. Accept and say so.
- **Spend.** The rows it copied stay the caller's (ADR 0009, F8); its own turns are the run's.
- **Scope.** The root scope only, as `caller` is.

Workaround until then: `agent/workflows/review/tab.ts --fork` starts `claude --resume {id}
--fork-session` in a tab itself and has it run `awf run --here`, so the fork starts the run rather
than the run opening the fork.

Related: [attended-agent](attended-agent.md), for an operator typing into the fork while it works,
and a layout target for the run's own progress pane, so the fork can sit beside it.
