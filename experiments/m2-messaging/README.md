# M2 — do agents use `--await-reply` as the gate needs, on the built engine?

Run 2026-10-12 for task 9 of [story 029](../../docs/stories/029-agent-messaging.md), judged by its
M2 gate. The verdicts are in [`docs/findings/messaging-m2.md`](../../docs/findings/messaging-m2.md).

## Setup

- `workflow.ts` is a real workflow: per trial, a planner must plan retries for `charge()`, and
  whether they live in the client or the queue is its architect's call; it has a route to ask. The
  architect's instructions hold the answer, `queue`. Nothing tells the planner how to wait: what it
  does comes from the engine's prompt and the model. Both agents of a pair run one runtime.
- Each result keeps the run's delivery states; the first rounds' were read back from their run
  folders while those still existed.
- `run.ts` runs it through `awf run` with `--await-reply` on for what it measures, then reads each
  trial from the run's event log, each operation's liveness file, and the planner's own session
  through `awf logs --json`.
- `score.ts` counts each runtime against the gate: in 18 of 20 trials the planner asks, ends its
  turn with no `sleep` or `wf waiting`, and finishes with the architect's answer.

```sh
bun run.ts codex 10 2                 # 10 pairs per run, 2 runs; RESULTS={subdir}, main by default
RESULTS=main bun score.ts codex
```

Runtimes: claude `claude-sonnet-5-5` headless and in a pane, codex `gpt-6-luna`, pi
`openai-codex/gpt-5.6-terra` and cursor `composer-2.5-fast`, headless.

## Results

- `results/before`: the first round, on the route lesson that said "send with
  `wf send <peer>` … add `--await-reply`". Every agent on claude, codex and pi first typed the flag
  after the peer, which `wf` refused, then sent again correctly: 20/20 each.
- `results/main`: after the lesson showed `wf send --await-reply <peer>` and `wf` took a flag
  after the peer: 20 trials each of claude headless, codex, pi and claude in a pane.
- `results/pane-load`: three claude-pane runs of 5 pairs each, run beside the headless rounds. A
  claude pane's first prompt went unconfirmed past the 30 s delivery window, in workflow turns as
  much as message operations: one run failed on an architect's, one lost all five planners', one
  lost one. Two pairs at a time, alone, ran clean.
- cursor: on `composer-2.5` every trial failed before the protocol, `cursor-agent` answering
  `[unavailable]` (in `results/before`), as a bare `cursor-agent -p` did. On `composer-2.5-fast`, 20
  trials in `results/main`, 4 pairs at a time; `results/cursor-login` holds two runs refused before
  any agent started, `cursor-agent status` reading as logged out.
