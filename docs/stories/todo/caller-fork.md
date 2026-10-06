---
title: A run in the background, forking the session that started it, beside its own progress
type: story
status: todo
priority: P2
epic: authoring
discovered_in: "agent/workflows/review, the fixer beside the run (2026-10-06)"
depends_on: []
---

# A run in the background, forking the session that started it, beside its own progress

The review workflow's use: from the main session, `/wf:review` starts a run and the main session
keeps working. A tab opens in its workspace, the run's progress on the left, and on the right the
fixer, a fork of the main session, so it starts knowing what that session knows and the review's
work stays out of its context. When the run ends, the main session gets the summary.

```text
| awf review progress | fixer (fork of the main session) |
```

The main session runs `awf run` as a background task (claude's `run_in_background`), so it is never
taken over and hears when the process exits; the output ends with the workflow's presented result.
`--here` is not used. Three pieces are missing.

## 1. Fork the session `awf run` was started from

Something like `workflow.agents.origin()`: the harness session `awf run` is a child of, to fork,
never to drive; `null` when there is none. Refused today: the caller has no `opening`, which a fork
copies (`workflow-runner.ts`, "is the calling session, which a run does not fork"). Nothing else
stands in the way:

- **Session id**: a child of the session has the harness's `sessionEnv` (`CLAUDE_CODE_SESSION_ID`);
  Herdr also reports it (`agent_session`). The ancestry check `"origin"` makes already applies.
- **Working directory**: the shell's; claude finds a session by project directory.
- **Skills and home**: the operator's, so nothing is copied.
- **Command**: each harness's `forkSession`, unchanged.
- **Point**: whatever the session holds when the fork is asked for. The session is busy (its turn
  started the run), so the fork may lack that turn's end; a fork made later is still a copy.

To decide, as an amendment to ADR 0009 or 0010:

- **Model.** Read it from the session file, or require the fork to name one: claude's `--resume`
  takes the default model, not the session's.
- **Environment.** The fork runs where awf opens agents, with awf's launch flags, not the operator's
  session, sandbox, settings or MCP servers its context was built with. Accept and say so.
- **Spend.** The rows it copied stay the session's (ADR 0009, F8); its own turns are the run's.
- **Scope.** The root scope only, as `caller` is.

## 2. A progress tab of the run's own

In the background, `awf run`'s progress goes to the task's output file. The run opens a tab in
`"origin"` showing the same view, as it opens a watch tab for a sandbox. (S)

## 3. Beside the run's progress

A reserved `beside` target, e.g. `layout: { beside: "run" }`, splitting the progress tab's pane.
awf made that pane, so the rule that it splits only its own holds. With no progress tab it falls
back to a tab of its own, as any `beside` does. (S)

## Not needed

Talking to the fork while it works. An operator steps in only when it is stuck or stopped:
`keepPane: "on-failure"` keeps its pane, its harness running and its channel revoked, so it is an
ordinary session to type into; `"always"` keeps it after a clean run too.
[[attended-agent]] stays for an agent the operator talks to mid-turn.

## Today

`agent/workflows/review/tab.ts [--fork]` does it from outside: it opens the tab, starts claude
there (`--resume {id} --fork-session` with `--fork`), has it start the run with `awf run --here`,
and moves the run's tab pane beside it. The fork starts the run rather than the run opening the
fork, which is the wrong way round.
