# Messaging live, R1–R7

Whether agents use `wf send --await-reply` as [story 029](../stories/029-agent-messaging.md)'s M2
gate needs, on the built engine, measured 2026-10-12. Each trial is a real `awf run`: a planner
must plan retries whose home is its architect's call, with a route to ask it, and nothing in the
task says how to wait. Both agents of a pair run one runtime. The scripts and raw results are in
[`experiments/m2-messaging`](../../experiments/m2-messaging/).

| | question | verdict |
|---|---|---|
| R1 | does the asker send with `--await-reply`, then go on with no `sleep` or poll? | **yes, 80/80**: claude headless and in a pane, codex, pi, 20 each; 77 ended their turn before the answer came, and 3 (codex 2, pi 1) were still reading files when it did |
| R2 | does the answer resume its call, and does it finish with it? | **yes, 80/80**; no check-in needed |
| R3 | does the woken peer answer with `wf reply`, first time? | **yes, 80/80**; none reminded, none answered by a plain send |
| R4 | is each delivery confirmed? | **yes, 160/160 `observed`**: the session's own record headless, the receipt in a claude pane |
| R5 | where do agents type `--await-reply`? | **after the peer, 60/60,** while the prompt said "add `--await-reply`"; **0/80** once it showed `wf send --await-reply <peer>` |
| R6 | do ten claude panes start at once? | **not reliably**: of three runs of 5 pairs beside the headless rounds, one failed when a message operation's first prompt went unconfirmed in 30 s, one lost all five planners' first prompts, and one lost one; 2 pairs at a time, alone, ran clean |
| R7 | does cursor pass? | **no, 11/20** on `composer-2.5-fast`: 9 planners ran past their 6-minute deadline, 4 before asking; every one that asked waited, and every answer it got it used. `composer-2.5` would not answer at all that day |

Models: claude `claude-sonnet-5-5`, codex `gpt-6-luna`, pi `openai-codex/gpt-5.6-terra`, cursor
`composer-2.5-fast`. About
$4.1 for claude headless, $4.5 for claude panes, $0.80 for pi and $0.08 for codex, at list prices.

## What follows

- **The gate passes on claude, headless and in a pane that confirms delivery, and on headless
  codex and pi**, which the engine's list now allows. As the story decided, the list is by harness
  and placement: a model M2 did not measure may use them.
- **No asker polled.** None checked `wf peers` more than twice after asking; most never did.
- **cursor stays off (R7).** Its failures were time, not protocol: a batch of four timed out before
  sending anything, and the clean runs took 2½ to 4½ minutes for a short plan. `composer-2.5`
  answered `[unavailable]` throughout, outside awf too, and `cursor-agent status` read as logged out
  twice, refusing two runs before any agent started (`results/cursor-login`). Its deliveries stay
  `unconfirmed`, 30/30: awf cannot read cursor's store. Measure again when its service is steady.
- **The wording was the only failure, and it was ours.** "add `--await-reply`" put the flag after
  the peer every time. The lesson now shows the flag in place, and `wf` takes one typed after the
  peer anyway: one after the message is still refused, since it would be sent as text.
- **A key the task names loosely is guessed.** One codex planner sent to `architect`, was refused
  `no-route`, read `wf peers` and sent to `architect:10`. Keys in a prompt should be the real ones.
- **R6 is not messaging's:** a workflow turn's first prompt in a pane failed the same way. It bounds
  how many claude panes a run should start at once on one machine.

The scorer reads the tool calls `awf logs` summarises, cut near 125 characters, so a wait typed
after a long heredoc would not show; the engine's own record of each turn ending before the answer,
R1's 77, does not depend on it.

Not measured: compaction mid-wait in a pane; a woken agent continued by a request while it waits;
`wf result` sent on a message operation; forged operator text, which E9 measured before the build
([`messaging-protocol.md`](messaging-protocol.md)).
