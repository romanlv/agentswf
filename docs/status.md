# Status

Where awf stands, as of 2026-09-24. [`foundation.md`](foundation.md) is the argument and changes
slowly; this page is the state and changes with every story. When the two disagree about what
exists, the code is right, then this page.

## What runs today

- `awf run {workflow.ts}` loads a trusted local workflow and runs it. Each agent's placement is set
  in the workflow: a pane agent gets a tab in the run's one Herdr workspace, and a headless agent
  runs as a subprocess per turn that resumes one native session. claude and codex run in panes;
  codex and pi run headless. A headless claude needs `metered: true`, as `claude -p` bills per
  token even on a subscription login. Pane agents open in the Herdr session `awf run` is started
  from (`AWF_HERDR_SESSION` overrides it), and `--cwd` sets the directory the workflow works in.
- While it runs, `awf run` shows each labelled `parallel` stage and its agents' turns: a block
  redrawn in place on a terminal, a line per change otherwise.
- Each agent answers through `wf result`, over a socket the engine opened for that agent alone. At
  most one result is accepted per operation, validated against its schema, with one nudge when an
  agent goes quiet without answering.
- Every wait has a deadline. The run's default is thirty minutes.
- Every run reports its wall time, and for each agent, stage and model its times, tokens, billing
  and a cost estimate at dated list prices, read from the harnesses' own session files when the run
  ends. `awf run` prints it and writes it to `output.json` (story 002), for a run that failed or
  was cancelled too; `runWorkflow` then rejects with a `WorkflowRunError` carrying it (story 003).
- Two workflows have run live:
  - `examples/minimum-review/review-loop.ts`, two reviewers in parallel (story 001);
  - catalogue review, 21 codex agents over lenses with a verifier per finding, from an entry point
    outside this repository (see [`examples/README.md`](../examples/README.md)).
- `examples/quick-check` asks each named harness a known-answer question, with a follow-up in the
  same session for headless agents. It is the cheap smoke test for a harness and its accounting.
- `feature-delivery` is a typechecked design and has never run.
- `bun run eval` checks every supported feature against the live harnesses, on their cheapest
  models, in about a minute for $0.10–0.16; [`testing.md`](testing.md) says when to run it.

## Stages

The gates are defined in [`foundation.md`](foundation.md) §12.

| Stage | State |
| --- | --- |
| D — fix the author surface in place | done |
| 0 — skeleton and move | done |
| 1 — the harness stands alone | in progress: no standalone command is accepted yet |
| 2 — minimum engine and control plane | done (story 001) |
| 3 — measure and run something real | in progress: catalogue review runs; accounting done (story 002); E4 not run |
| 4 — messaging, composition, checkpoints, then the journal | not started |

## Stories

- [001 — minimum multi-agent review](stories/001-multi-agent-review.md): done, approved
  2026-09-24 after its live acceptance was re-run on current code.
- [002 — cost and time accounting](stories/002-cost-and-time-accounting.md): done, approved
  2026-09-24. It also added per-agent placement (pane or headless) and multi-turn headless
  sessions, and changed the result prompt to a quoted heredoc carrying the schema.
- [003 — failed-run accounting](stories/003-failed-run-accounting.md): done, approved
  2026-09-24. It also added `bun run eval` and moved the agents' launcher under `/tmp`.
- [005 — review fixtures](stories/005-review-fixtures.md): draft. Tests with known answers for
  review workflows: old MRs frozen when review started, plus the real problems found in them, graded.

The inbox of possible stories is [`stories/todo/`](stories/todo/).

## Next

1. The first autoresearch loop over review variants, with its general tools in this repository
   ([ADR 0002](adr/0002-autoresearch-lives-here.md)), scored against old MRs replayed as they
   were when review started. In order:
   [story 005](stories/005-review-fixtures.md), the fixtures to score
   against; then
   [`eval-isolation`](stories/todo/eval-isolation.md) and
   [`review-recall-scorer`](stories/todo/review-recall-scorer.md) — settle
   [`deadline-outcome`](stories/todo/deadline-outcome.md) before it reads `output.json` — then
   [`variant-matrix-runner`](stories/todo/variant-matrix-runner.md), and last
   [`autoresearch-loop`](stories/todo/autoresearch-loop.md).

## Known gaps

- A pane agent takes one operation. Multi-turn pane work waits on verified pane release
  ([`herdr-pane-settlement`](stories/todo/herdr-pane-settlement.md)).
- No OS sandbox. Agents run with the operator's authority ([`design/permissions.md`](design/permissions.md)).
- E4, concurrency, has never been measured.
- A headless turn killed mid-request, by its 30 s grace after answering or by a follow-up that
  stopped waiting, loses that request from its usage. At run end the runner waits up to 10 s for it
  instead.
- An agent its host cannot run (pi in a pane, claude headless without `metered`) is refused only
  when it opens, possibly after other agents have spent. pi's billing is inferred from its
  `auth.json`. A headless claude has never run live.
