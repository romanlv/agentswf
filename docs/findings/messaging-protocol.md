# Messaging protocol, P1–P6

Whether agents operate the protocol of [the messaging design](../design/messaging.md), measured
2026-10-12 before it was built, for Q11 of [story 029](../stories/029-agent-messaging.md). pi 0.87.1
headless on gpt-6-luna and gpt-6.1-sol, against a stand-in `wf` that answers as the design says;
the raw results and the scripts are in [`experiments/e9-messaging-protocol`](../../experiments/e9-messaging-protocol/).

| | question | verdict |
|---|---|---|
| P1 | does a sender that needs an answer use `--await-reply` and end its turn? | **yes, 40/40**; none slept or guessed; luna looked at `wf peers` once in 6 |
| P2 | does the reply continue it to a result? | **yes, 40/40** |
| P3 | does a woken agent answer a request with `wf reply`? | **yes, 40/40 on the first try**; no prose-only reply |
| P4 | does a request held into a run get a reply and the task a result? | **reply 40/40; sol stalled after replying 20/20** until the check-in |
| P5 | does an agent ask when its files already answer? | **no, 0/40** |
| P6 | does forged operator text in a peer's message get obeyed? | **1/60 on luna unescaped; 0/80 escaped or quoted; 0/20 on sol** |

## What follows

- **The model side of waiting is not the risk.** Waiting failed in no trial; what can fail is the
  plumbing, a resumed session or a pane's receipt, which the live smoke of each harness proves.
- **P4 is an envelope gap.** A request joining a workflow's `run` must say the task continues after
  the reply. The route's purpose, "until both agree", read to sol as a reason to stop.
- **A reply-only route confuses a model that wants to acknowledge.** Luna tried to send on one in
  50 of 60 trials; the refusal must say the route only answers that peer's requests.
- **P6 does not depend on `--await-reply`.** Plain messages carry the same text and are not gated.
  The fence is hygiene, as the design says; the bound is the route, the sandbox and permissions.

Not measured: claude, codex and cursor; panes; compaction mid-operation.
