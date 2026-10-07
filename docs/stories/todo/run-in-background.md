---
title: A run in the background, which the session that started it waits on later
type: story
status: todo
priority: P2
epic: authoring
discovered_in: "agent/workflows/review, the fixer beside the run (2026-10-06)"
depends_on: ["027"]
---

# A run in the background, which the session that started it waits on later

[[027-caller-fork|Story 027]] makes `awf run` from an agent's shell a call the session blocks on,
whose run can fork it. That works in every harness, but the session does nothing else until the run
ends. This is the non-blocking version, in awf, not in any harness: claude's `run_in_background`
and cursor's `is_background` tell the model when a command ends, codex's background terminals must
be polled, and pi has none (2026-10-06, from the installed bundles).

```text
$ awf run --bg review.ts      → prints the run's id, returns at once
  … the session keeps working …
$ awf wait {id}               → blocks, then prints what a blocking awf run would have
```

The review workflow's use: from the main session, `/wf:review` starts a run and the main session
keeps working. A tab opens in its workspace, the run's progress on the left and the fixer, a fork
of the main session, on the right:

```text
| awf review progress | fixer (fork of the main session) |
```

## 1. `--bg` and `awf wait`

- **Who starts it.** In a Herdr pane, Herdr starts it in a tab, as `--here` does: it outlives the
  session, runs outside the session's sandbox and can be watched. Elsewhere, a detached process,
  in the session's sandbox; codex kills its own processes as it exits. `--bg` says which.
- **`forkCaller`.** The detached run is not the session's child, so `--bg` passes the session's id
  on, as `--here` does (`AWF_CALLER_SESSIONS`, story 027). The session keeps working, so the copy is
  of the session as it is when the workflow asks, not as it was when the run started.
- **`awf wait {id}`** blocks until the run ends and prints its presented result, the closing block
  and the exit code a blocking run would have. A run already over prints at once.
- **Status and stop.** The run directory says a run is still going, which `awf wait` reads;
  `awf stop {id}` follows from it.

## 2. A progress tab of the run's own

Detached, `awf run`'s progress has no terminal. The run opens a tab in `"origin"` showing the same
view, as it opens a watch tab for a sandbox: a script that redraws a file the run rewrites, so
nothing grows. It closes with the run; a kept pane beside it stays. Without Herdr, `awf wait`
replays the progress from that file. (S)

## 3. Beside the run's progress

`layout: { beside: "run" }` splits the progress tab's pane. `run` becomes a reserved key: an agent
keyed `run` is refused. awf made that pane, so the rule that it splits only its own holds. With no
progress tab it falls back to a tab of its own, as any `beside` does. (S)

## 4. Told when it ends (optional)

Where the session has a Herdr pane, the run's end also sends the result into it, as `--here`'s
hand-back does; a busy session queues it (E8). Without a pane, `awf wait` is how it learns.

## Later

A pane a workflow writes to with no agent in it, `workflow.panes.open({ key, layout })` and
`write(text)`, placed and kept like an agent's. The progress pane would be awf's own first one.

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
