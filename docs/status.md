# Status

Where awf stands, as of 2026-10-01. [`foundation.md`](foundation.md) is the argument and changes
slowly; this page is the state and changes with every story. When the two disagree about what
exists, the code is right, then this page.

## What runs today

- `awf run {workflow.ts}` loads a trusted local workflow and runs it. Each agent's placement is set
  in the workflow: a pane agent gets a tab in the run's one Herdr workspace, and a headless agent
  runs as a subprocess per turn that resumes one native session. claude, codex and pi run in
  panes (pi since story 017); codex and pi run headless. A headless claude needs `metered: true`,
  as `claude -p` bills per token even on a subscription login. A pane agent keeps its pane for all its turns (ADR 0008). Pane agents open in the Herdr session `awf run` is started
  from (`AWF_HERDR_SESSION` overrides it), and `--cwd` sets the directory the workflow works in.
- While it runs, `awf run` shows each labelled `parallel` stage and its agents' turns: a block
  redrawn in place on a terminal, a line per change otherwise.
- Each agent answers through `wf result`, over a socket the engine opened for that agent alone. At
  most one result is accepted per operation, validated against its schema, with one nudge when an
  agent goes quiet without answering.
- Every wait has a deadline. The run's default is thirty minutes.
- Every run reports its wall time, and for each agent, stage and model its times, tokens, billing
  and a cost estimate at dated list prices, read from the harnesses' own session files when the run
  ends. `awf run` prints it and writes it to `output.json` (story 002), for a run that failed, timed
  out or was cancelled too; `runWorkflow` then rejects with a `WorkflowRunError` carrying it (story
  003). A run its own deadline ended is `timed-out`, apart from `failed` (story 008).
- Two workflows have run live:
  - `examples/minimum-review/review-loop.ts`, two reviewers in parallel (story 001);
  - catalogue review, 21 codex agents over lenses with a verifier per finding, from an entry point
    outside this repository (see [`examples/README.md`](../examples/README.md)).
- `awf test` runs a workflow's tests, in any folder, with nothing installed there (story 012):
  `testWorkflow` from `agentswf/testing` runs the workflow through the real engine with each agent
  and decision model scripted, typed by the schema each turn asks for. Nine examples have theirs
  beside them.
- `agent.compact({ prompt })` runs the harness's own compaction with the workflow's focus (story
  015, ADR 0007), within the workflow's deadline unless `timeoutMs` bounds it: claude, codex and pi
  in a pane or headless; cursor refuses.
  `examples/compaction` checks each live.
- `awf run --here`, typed in a claude, codex, pi or cursor session in a Herdr pane, starts the run
  in a tab of its own, which drives that session as an agent through `agents.caller` and hands it
  back with a last message (story 014, ADR 0010). The `awf-run` skill wraps it.
- `examples/quick-check` asks each named harness a known-answer question, with a follow-up in the
  same session. It is the cheap smoke test for a harness and its accounting.
- A workflow opens sandboxes and puts agents in them, shared or private, with
  `workflow.sandboxes.open` or `sandbox` on an agent (story 004). A sandbox's agents see the paths
  it names, their git directories and the provider's base (srt: the host system and toolchain
  outside the denied regions; docker: the image), and reach the domains it names plus their
  models'. They get exactly the environment variables the provider sets, and each has a fresh
  harness home holding its credential and first-run answers, nothing else of the operator's.
  `output.json` lists each sandbox and its agents. The providers:
  - **srt**, the default where installed: headless claude, codex and pi, and claude, codex and pi
    in panes of the run's Herdr, all verified live;
  - **docker**: headless agents in a container, with a filtering proxy and a relay for `wf`, and
    claude, codex and pi in panes of the box's own Herdr, all verified live.
- A workflow names each agent's skills, `{ path }` or a public `{ repo, skill, ref? }`, and the
  agent has exactly those, on the host or in a sandbox, under claude, codex and pi (story 007).
  Each agent gets a checked copy; a public skill is pinned to a commit in a cache shared by runs.
  `output.json` records each agent's skills. An agent named none keeps the operator's on the host.
- `feature-delivery` is a typechecked design and has never run.
- `bun run eval` checks every supported feature against the live harnesses, on their cheapest
  models; [`testing.md`](testing.md) says what each eval takes and when to run it.

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
- [004 — sandboxed agents](stories/004-sandboxed-agents.md): done, approved 2026-09-26. A workflow
  opens sandboxes and agents inside them, private or shared, headless or in panes, under srt or
  docker
  ([findings](findings/sandbox-providers.md)). Credential rotation (X13) waits on the operator.
- [005 — review fixtures](stories/005-review-fixtures.md): done, approved 2026-09-26. Tests with
  known answers for review workflows: old MRs frozen when review started, plus the real problems
  found in them, graded. `packages/lab` builds them: `collect` freezes a GitLab MR,
  `draft-key` drafts its key, graders from two model families vote on it, and the set is sealed in
  `set.json`, each fixture pinned by a digest. The first set has 33 fixtures from 61 of the
  private project's MRs.
- [006 — typed decisions](stories/006-typed-decisions.md): done. A workflow asks a System One
  model (Jev, on OpenRouter) closed questions about a state and gets a probability for every answer
  back, recorded and costed apart from agents; `examples/triage` routes tickets with it
  ([findings](findings/system-one-models.md)). `awf-lab`'s review scorer, match first, uses it to
  match findings to a key ([story 011](stories/011-compare-variants.md)).
- [007 — agent skills](stories/007-agent-skills.md): done, approved 2026-09-29. A workflow names
  each agent's skills, as a path or a public skill in a git repository, and the agent sees exactly
  those, on the host or in a sandbox ([findings](findings/agent-skills.md)).
- [008 — review scorer](stories/008-review-scorer.md): done, approved 2026-09-29. `awf-lab` runs
  a review variant and a scorer per case of a dataset through `awf run`, keeps each trial's findings and the
  scorer's labels as records by each file's declared version, `{name}@{major}.{minor}` of its
  semver, a patch keeping the results, and reports recall by severity,
  precision, wrong claims, noise, κ, and list-price cost and time, for any number of variants
  against a baseline, or one variant under two scorers. Its commands are `list`, `run`, `score`,
  `report`, `show` and `schema`, one selection grammar on each (`--cases`, `--only` by address,
  `--where` by stored result), and `--json` with a schema on every one. Its scorer was a panel of
  two model families with a tiebreak; a trial on five cases put the lens catalogue well ahead of a
  single agent with or without a public review skill. Match first, measured in the data
  repository as accurate as the panel at a fifth of its time and list price, replaced it in
  [story 011](stories/011-compare-variants.md).
- [009 — run agents.wf from GitHub](stories/009-publish-agentswf.md): in progress. One naming
  rule (`@agentswf/*`, `agentswf/workflow`, `awf`, `wf`); `awf run` serves `agentswf/workflow` and
  `typebox` to a workflow in any folder; `awf --version` and a Bun check; a README that installs
  from a clone. Left: tag v0.0.1 and run it on the operator's second machine, and reserve the
  names.
- [010 — eval isolation](stories/010-eval-isolation.md): done. `awf run --sandbox {file}`
  puts every agent of a run in one operator sandbox and refuses a workflow's own; `awf-lab` runs
  every trial in one, from `awf-lab.json`'s `sandbox` (srt by default), holding the checkout and
  the request. The case is restored as the reviewer's clone was. Design:
  [`design/evaluation.md`](design/evaluation.md).
- [011 — compare variants](stories/011-compare-variants.md): done, approved 2026-09-30.
  `awf-lab report --baseline` gives each challenger a verdict (better, worse, tie or undecided,
  whether to stop, and why) from a comparison the project can replace, `@agentswf/lab/compare`;
  the package's own is a paired t rule with planned looks, guards and tie-breakers. `--trials n`
  runs several trials a case, counted only whole; `run {challenger} --baseline {variant}` runs
  both case by case until the verdict says stop; `check` says whether a variant's cases can tell
  a change from noise; match first (`match-first`) is the review scorer and the panel retires.
  Its live check, a public review skill added to the codex baseline, was
  undecided at 16 cases: recall −0.01 [−0.08, +0.06], 36 s a case slower. A futility stop
  (`minGain`, 0.05 in `default` 1.1.0) now ends such a run at a look.
- [012 — workflow tests](stories/012-workflow-tests.md): done, approved 2026-09-30. A workflow's
  test beside it scripts each agent's and decision's answers, typed by the turn's schema (`answer`,
  `reply`), and runs the real engine against them: `testWorkflow` in
  `@agentswf/engine/workflow-testing`, served to authors as `agentswf/testing`, on a second
  composition root (ADR 0006); nine examples tested beside them; `awf test` runs them in any
  folder.
- [013 — autoresearch loop](stories/013-autoresearch-loop.md): in progress. The proposer writes
  workflow code, so trials run whole in a container; air-1 is split 23 tuning / 10 holdout.
- [014 — a workflow in the current session](stories/014-workflow-in-current-session.md): done,
  approved 2026-10-01. `awf run --here` takes the session it was typed in over as `agents.caller`
  ([ADR 0010](adr/0010-the-calling-session-is-an-agent.md)); its eval passes on claude, codex, pi
  and cursor.
- [015 — native compaction](stories/015-native-compaction.md): done, approved 2026-10-01.
  `agent.compact` runs each harness's own compaction with the workflow's focus, and a pane agent
  takes more than one operation, so one agent can carry a long task as an operator does with
  `/compact`. Measured on every harness
  ([findings](findings/native-compaction.md)); its eval passes on all seven runtimes, pi panes
  included. `compact({ prompt })` takes `run`'s id and deadline defaults (ADR 0007, amended).
- [016 — fork](stories/016-fork.md): done, approved 2026-10-04 (ADR 0009).
  `agent.fork({ key })` opens a new agent on a copy of an agent's session, made with no model
  call: claude, codex and pi in a pane or headless, into either, in a sandbox too, and cursor
  headless. Every fork reads its parent's cache, codex's and cursor's by keeping their parent's
  key; cursor's was measured on `composer-2.5` only ([findings](findings/fork-cache.md)). A headless claude turn charges what it added to its
  session's total. Claude panes are typed their prompts, which claude 2.1.288 otherwise shows as
  pasted text and will not act on.
- [017 — pi in panes](stories/017-pi-pane-agent.md): done, approved 2026-10-01. pi runs in a Herdr
  pane, on the host and in srt and docker sandboxes, and compacts there with a focus.

The inbox of possible stories is [`stories/todo/`](stories/todo/).

## Next

1. The first autoresearch loop over review variants, with its general tools in this repository
   ([ADR 0002](adr/0002-autoresearch-lives-here.md)), scored against old MRs replayed as they
   were when review started. The fixtures to score against are built
   ([story 005](stories/005-review-fixtures.md)), and so are the sandboxes to isolate them in
   ([story 004](stories/004-sandboxed-agents.md)), and every trial runs in one
   ([story 010](stories/010-eval-isolation.md)). In order:
   [story 011](stories/011-compare-variants.md) (done), then
   [story 013](stories/013-autoresearch-loop.md), the loop, taken before
   [`second-case-kind`](stories/todo/second-case-kind.md) by the user's choice (2026-09-30).

## Known gaps

- An agent opened without a sandbox runs with the operator's authority, and a sandboxed one still
  spends the operator's login, which a refresh in its copy may rotate (X13). The harness-level
  permissions are designed, not built, but for a sandboxed claude's prompts, which are off
  ([`design/permissions.md`](design/permissions.md)).
- E4, concurrency, has never been measured. `awf-lab run --jobs` runs steps in parallel on the
  operator's say-so (story 008).
- A headless turn killed mid-request, by its 30 s grace after answering or by a follow-up that
  stopped waiting, loses that request from its usage. At run end the runner waits up to 10 s for it
  instead.
- An agent its host cannot run (cursor in a pane, claude headless without `metered`) is refused only
  when it opens, possibly after other agents have spent. pi's billing is inferred from its
  `auth.json`. A headless claude has run live only in a sandbox, on a setup token.
- A contained `awf-lab` trial ([story 013](stories/013-autoresearch-loop.md)) has an open network,
  as a real reviewer has: generated workflow code could send the copied codex credential out.
  Closing it waits on [`workflow-in-sandbox`](stories/todo/workflow-in-sandbox.md).
