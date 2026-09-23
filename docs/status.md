# Status

Where awf stands, as of 2026-09-23. [`foundation.md`](foundation.md) is the argument and changes
slowly; this page is the state and changes with every story. When the two disagree about what
exists, the code is right, then this page.

## What runs today

- `awf run <workflow.ts>` loads a trusted local workflow and runs it on one Herdr workspace, with a
  tab per agent. Agents are claude, codex and pi, on subscription logins.
- Each agent answers through `wf result`, over a socket the engine opened for that agent alone. At
  most one result is accepted per operation, validated against its schema, with one nudge when an
  agent goes quiet without answering.
- Every wait has a deadline. The run's default is thirty minutes.
- Two workflows have run live:
  - `examples/minimum-review/review-loop.ts`, two reviewers in parallel (story 001);
  - catalogue review, 21 codex agents over lenses with a verifier per finding, from an entry point
    outside this repository (see [`examples/README.md`](../examples/README.md)).
- `feature-delivery` is a typechecked design and has never run.

## Stages

The gates are defined in [`foundation.md`](foundation.md) §12.

| Stage | State |
| --- | --- |
| D — fix the author surface in place | done |
| 0 — skeleton and move | done |
| 1 — the harness stands alone | in progress: no standalone command is accepted yet |
| 2 — minimum engine and control plane | implemented; live acceptance waits on story 001's re-run |
| 3 — measure and run something real | in progress: catalogue review runs; story 002 is the accounting; E4 not run |
| 4 — messaging, composition, checkpoints, then the journal | not started |

## Stories

- [001 — minimum multi-agent review](stories/001-multi-agent-review.md): all tasks implemented. The
  live runs are stale since the return-channel redesign of 2026-09-22 and must be re-run before
  human review.
- [002 — cost and time accounting](stories/002-cost-and-time-accounting.md): Tasks 1 and 2 done.
  Task 3, reading usage when the run ends, is in the working tree. Tasks 4 (prices and the summary)
  and 5 (live check) remain.

The inbox of possible stories is [`stories/todo/`](stories/todo/).

## Next

1. Finish story 002. Every run then reports time, tokens and an estimated cost.
2. Re-run story 001's live acceptance on current code and close it.
3. The first autoresearch loop over catalogue-review variants, in this repository
   ([ADR 0002](adr/0002-autoresearch-lives-here.md)). It needs story 002's summary, and
   [`failed-run-accounting`](stories/todo/failed-run-accounting.md) so a failed variant is not free.

## Known gaps

- The runner prompts through `describe()`, the arm E5 measured at 0% first-attempt validity
  ([`schema-in-prompt`](stories/todo/schema-in-prompt.md)).
- A pane agent takes one operation. Multi-turn pane work waits on verified pane release
  ([`herdr-pane-settlement`](stories/todo/herdr-pane-settlement.md)).
- No OS sandbox. Agents run with the operator's authority ([`design/permissions.md`](design/permissions.md)).
- E4, concurrency, has never been measured.
