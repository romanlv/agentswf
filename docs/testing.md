# Testing

How awf is checked, what each level costs, and when to run it. Costs are list-price estimates from
the run's own accounting. Every live check here runs on subscription logins, and the estimate is
what the same tokens would cost metered, a proxy for the quota used, with one exception: claude
headless, which `sandbox-srt`, `sandbox-docker`, `compaction` and `review-judge` run, is billed per
token even on a subscription (E3), so its share of those evals is money.

## Levels

### 1. Offline — every change, free

```sh
bun test          # ~970 tests, about two minutes
bun run check     # Biome, tsc, the package boundaries
```

No live agent runs. Harnesses are replaced by fakes: `@agentswf/harness/testing` has a fake adapter and a
fake Herdr CLI, and fake session files stand in for the harnesses' usage logs.

A workflow's own logic is tested beside it, in `workflow.test.ts`, against `agentswf/testing`: each
agent scripted, the real engine between them, milliseconds a test ([the workflow
API](workflow-api.md#testing-a-workflow) says how). Every example but `quick-check` and
`sandbox-probe`, which exist to watch real agents, has one; `bun test examples` runs just those.
Write one when a workflow gains a branch, a loop or a new outcome to handle, and change the
workflow's tests with the workflow. The tests in `tests/` check what the engine and `awf run` do
for a workflow, and `tests/workflow-api-samples.test.ts` runs the API page's samples with `awf
test`.

Each sandbox provider also has a local test, `packages/sandbox/src/srt/srt.local.test.ts` and
`packages/sandbox/src/docker/docker.local.test.ts`. It runs the real provider with `sh` standing in
for each agent, no model: the conformance suite, then what the provider allows and denies. It is
part of `bun test` and free, and skipped where its provider is not installed; docker's also where
the daemon does not answer within 5 s or the default image is not built.

The fakes encode what the real CLIs do today. They go stale silently, which is what the live levels
are for.

### 2. Evals — every supported feature, live, minutes and dollars

```sh
bun run eval                        # all of them, four at a time; time and cost below
bun run eval harnesses failed-run   # only the ones named
```

`*.eval.ts` files under `tests/` start live agents, assert what they did, and print what they
cost. `bun test` does not collect them. `bun run eval` is the consent to spend: it sets
`AWF_LIVE_EVAL=1`, which each eval requires, runs four evals at a time (`--jobs n` changes it),
prints each one's output in one block when it ends, and ends with each eval's time and cost and
the total. An eval checks that the pieces connect, not how well a model reasons: each gives its
agents the smallest task that exercises its path, and checks the result in code.
Each runs on a cheap model where a cheap one is dependable — codex `gpt-6-luna`, pi
`openai-codex/gpt-5.6-terra` — because an eval checks the machinery, not the quality of the
answer. Claude runs `claude-sonnet-5-5`: on haiku, about one eval in four failed on the model's
own call rather than awf's (a sandbox probe refused as an injection, a `wf result` command
printed instead of run, a skill listed but not used), 2026-10-01.

What they cover between them:

- `turn-liveness` — story 021's cooperative `wf waiting` path through `awf run`, repeated check-ins,
  final answer and a dependent operation in one Claude pane. `bun run eval turn-liveness` runs
  the host case. With explicit live opt-in, `AWF_LIVE_EVAL=1 bun tests/turn-liveness.eval.ts {mode}`
  selects `host`, `srt`, `silent`, `timeout`, `cancel` or `lost-route`. Each invocation has a five-minute outer
  deadline; initial cost guidance is under $1 list price per scenario, not a measured suite total.
  Host/SRT acceptance, failure cases and the final offline suite passed; Cursor-dependent full
  live matrices remain blocked by authentication. Exact results are in
  [[021-implementation-proof]].
  Inspect native receipt evidence and persisted waiting events, not merely agent prose or exit code.

- `harnesses` — quick-check across codex, pi and cursor headless and claude, pi and cursor in a
  Herdr pane, through `awf run`. Every answer must be right, each including a follow-up in the same
  session, and every agent's spend known and billed to its subscription, but cursor's: its billing
  is unknown, and a pane's cursor prints no usage. 6 agents, ~40 s, ~$0.13.
- `compaction` — native compaction (stories 015, 019) on every harness in panes and headless: each
  compacts with a focus naming a codename it was never told, then must recall it and what it noted
  before. A headless cursor, which has none, must refuse, saying why. `bun
  tests/compaction.eval.ts pi pi-pane` runs only those. 8 agents, ~60 s, ~$0.63 at list prices,
  the headless claude's share billed per token.
- `fork` — forks (story 016) on every harness, in panes and headless, across a placement change
  and after a compaction: each worker notes a codename, is forked, then notes a release. Each fork
  must answer the codename through its own channel and not know the release, and its first turn
  must read at least half its prompt from the cache, except a pane's cursor, which prints no
  usage. `bun tests/fork.eval.ts codex claude>headless` runs only those cases. 32 agents, ~2 min,
  ~$1.40 at list prices, the headless claude's share billed per token.
- `calling-session` — `awf run --here` (story 014) from a claude, codex, pi and cursor session,
  each started in a Herdr tab and told to run the command; codex under its workspace-write sandbox
  with local sockets allowed. Each run, in a tab of its own, drives its session through three steps;
  the eval presses Esc a few seconds into the second, a long essay. The first number must come back
  at the third, the interrupted step must be `cancelled` (`unanswered` for cursor, whose interrupt
  cannot be read), and each session's spend known, cursor's apart. Must run inside Herdr; outside it
  skips. 4 sessions, ~40 s, ~$0.05.
- `minimum-review` — two reviewers in parallel in one Herdr workspace, claude and codex both in
  panes, on a disposable copy of a fixture. Both must complete natively and in lens order, and the
  repository must be untouched. 2 agents, ~20 s, ~$0.04. `bun tests/minimum-review.eval.ts
  --dry-run` runs only its preflight — Herdr's version and behaviour, both subscription logins, no
  metered credentials — for free.
- `failed-run` — a run that crashes, and one cancelled mid-turn, after a headless codex agent
  answered, keep that spend in `output.json` with the right `outcome` and exit code. 2 runs, ~20 s,
  under a cent.
- `decisions` — `examples/triage` through `awf run` and the operator runtime it installs, on Jev
  through OpenRouter (story 006): four synthetic tickets, one decision each with a choice, a yes-no
  and a score. Every call must answer from a `typesafe/jev-1.13-` snapshot, priced, with its charge
  under $0.001 all told. No agent, ~1 s, ~$0.0001. It skips, and passes, when
  `OPENROUTER_API_KEY` is not set, and the runner shows it as skipped, not passed. awf reads the
  key from the environment, else that one name from `.env` in the working directory; Bun loads no
  `.env` itself (`bunfig.toml`). Copy `.env` into a worktree.
- `sandbox-srt` and `sandbox-docker` — the sandbox probe (story 004): codex and claude headless
  sharing a sandbox that writes the working directory, pi in a private one that writes nothing,
  each running a script of fixed commands, which the host wrote, against canaries it planted:
  files under `~`, in harness state and in the temp directories, a listener, a disallowed domain,
  a git hook, another sandbox's home. One tool call runs it and the agent relays its output, which
  the workflow splits back by command. Checked from the agents' own transcripts, the listener and
  the working tree. The coder runs first, then the tester and reviewer together. 3 agents, ~40 s,
  ~$0.10–0.16, claude's part billed per token, estimated. codex runs on gpt-5.6-sol: luna declined
  the probe's commands when they were listed one by one. Neither is skipped: each fails, saying why, where its
  provider is not installed or docker's daemon does not answer within 30 s, so a sandbox
  regression cannot pass unseen. `sandbox-docker` builds the default image first when it is
  missing.
- `sandbox-panes-srt` — the same probe with codex, claude and pi in terminal panes of the run's
  Herdr, typed in behind srt's confining prelude, and also refused the run's Herdr socket, leaving
  no secret or process behind; processes are found by their environment, where a pane's carry the
  run's path. 3 agents, ~50 s, ~$0.12; claude in a pane is on its subscription.
- `skills` — agents given one of two probe skills and using it (story 007): codex, pi and a
  claude pane on the host, codex and pi sharing one srt sandbox with different probes, and cursor
  in one of its own, as co-tenants read each other's homes. The
  prompt never mentions skills; it asks for a build's release stamp and audit seal, each claimed by
  one probe's description and made only by a script inside it, from a secret no `SKILL.md` holds.
  Each agent must make its own probe's value for its own build id and not the other's, leave the
  script's receipt in its own copy and none in a source or snapshot, list its own probe and none of
  the operator's skills; `output.json` must record each, the git-sourced probe with its commit.
  `tests/skills-eval.test.ts` checks these checks for free. 5 agents, ~40 s, ~$0.08, on
  subscriptions; srt must be installed.
- `review-judge` — the panel judge (story 008; since story 011 match first with nothing settled, which
  `match-first` scorers can also run as `--sure 1`) through `awf run`, on a synthetic fixture: a
  two-file change with two planted issues, a hand-written key, and six findings with known labels.
  The judgement must pass `checkScorerResult` and hit both planted issues; how many of the six labels
  match, the panel's κ and the tiebreak are printed, since they are what it measures. codex luna
  and claude sonnet judge, luna breaks ties. 3 agents, ~1–1½ min, ~$0.09 at list prices, and
  $0.07–0.14 of claude's own reported cost; awf assumes headless claude is billed per token
  ([`billing-provenance`](stories/todo/billing-provenance.md)). Three runs,
  2026-09-27: 5/6 labels, κ 0.80.
- `run-sandbox` and `run-sandbox-docker` — `awf run --sandbox` (story 010). awf-lab runs a probe
  variant on a synthetic case, in the workspace's sandbox: two codex agents that name no sandbox,
  a prober on gpt-5.6-sol running fixed commands and a reader on luna. Both must be in the run's one
  sandbox. Read from codex's transcripts, not the agents' reports: the request and `git diff
  origin/main...HEAD` must be readable, and the case's key, the clone, `~`, GitLab and writing the
  checkout refused, the key's text in no transcript. Then under
  a run sandbox: quick-check must run unchanged, the `sandboxes` example must be refused for opening
  its own, and a spec that can't open must end the run before it starts, leaving no record.
  `tests/run-sandbox.test.ts` checks these checks for free. 3 agents; srt ~1 min, ~$0.05–0.17;
  docker ~1½ min, ~$0.12–0.16.
- `sandbox-panes-docker` — the same, with the panes in the box's own Herdr, typed in behind a
  prelude that sets their environment and loads their secret. 3 agents, ~50 s, ~$0.16. Fails,
  saying why, where docker cannot run.

A historical suite, before story 021 added `turn-liveness`, ran four at a time and took 2m 36s and ~$1.87 at list prices on 2026-10-01, the
compaction eval the dearest at ~$0.63: pi needs 20k tokens of history before it compacts, and the
headless claude is metered. Run one by one, before the sandbox probes ran one script per agent,
it took about 17 min. These are historical measurements, not the current full-suite budget.
Story 021 measured its final host/SRT waiting pair at about $0.23; each scenario can take
1–3 minutes. See [[021-implementation-proof]] for exact runs and the incomplete Cursor matrix.

Not covered live, on purpose:

- claude headless outside a sandbox, beyond what a feature needs: it is billed per token even on a
  subscription. The sandbox evals run it, as a sandboxed claude has no other way to run headless;
  `compaction` runs it, as headless compaction is what it checks; and `review-judge` runs it, as
  the panel runs its judges headless.
- Combinatorial deadline, admission, check-in and cleanup races stay in deterministic offline
  tests. `turn-liveness` exercises their provider integration; it does not replace fake-clock
  coverage or establish every provider's receipt/cleanup behavior.

Each eval prints a JSON summary on stdout, with `ok` and `estimateUsd` — a failed one too — and the
run's accounting on stderr. It exits non-zero when an assertion fails and keeps its artifacts under
the system temp directory. Ctrl-C stops the running eval's agents as `awf run` would, and the runner
then starts no other.

Agents reach the engine through a launcher under `/tmp` (`CONTROL_PLANE_ROOT`), not the system
temp dir: cheap models mistyped the long macOS path. A host whose `/tmp` is read-only cannot run
agents yet.

### 3. Smoke — by hand, when you want to see one harness answer

```sh
bun awf run examples/quick-check/workflow.ts -- codex
```

What the `harnesses` eval runs, without assertions: the answers print on stdout.

### 4. Acceptance — a real workload, dollars

Catalogue review over a real diff: 19–21 agents, 8–14 min, $4–7. It lives outside this repository
(see [`examples/README.md`](../examples/README.md)). Run it only when a story's acceptance says so,
as story 002 did to check accounting against the session files.

## When to run what

- **Every change:** level 1. The pre-commit hook runs Biome only; run the rest yourself.
- **Before a story goes to human review, or after upgrading Herdr or a harness CLI:** `bun run
  eval`, all of it — at the cost above there is no reason to pick. Record the date, outcome and cost in the
  story's Verification section.
- **While working on one area:** the matching eval — `harnesses` for an adapter, liveness or usage
  reader; `turn-liveness` for waiting, repeated check-ins, receipt or release; `minimum-review` for panes, the control plane or the result channel; `failed-run` for run
  lifecycle, cancellation, accounting or `output.json`; `sandbox-srt` and `sandbox-docker` for
  `packages/sandbox`, a harness's sandbox needs, or the engine's sandboxes; `skills` for
  `engine/src/skills`, `harness/src/capabilities` or a harness's launch arguments; `sandbox-panes-srt` and
  `sandbox-panes-docker` for a sandboxed pane, the Herdr host's typed start or a box's Herdr;
  `run-sandbox` for `awf run --sandbox` or how awf-lab runs a trial; `calling-session` for
  `awf run --here`, `agents.caller` or the caller's Herdr backend. Pane layout, `keepPane` and the
  marks that sweep a dead run's panes have no eval, as their result is what a person sees: run
  `examples/pane-layout` from a Herdr pane and look (three codex luna agents, a few cents).
- **Level 4:** only when a story names it.

## Adding an eval

- Name it `*.eval.ts` under `tests/`, and refuse to start without `AWF_LIVE_EVAL=1`. `bun run eval`
  picks it up.
- Use the cheapest model that exercises the feature.
- Go through `awf run` (`runOperatorCli`) where possible, so the operator runtime and the record
  are what is tested. Use `runWorkflow` only when the eval must observe the harness from inside.
- Assert outcomes from the record, not from prose.
- Keep the checks a pure function of what the runner gathered, and unit-test it, as
  `tests/sandbox-probe.test.ts` and `tests/minimum-review-eval.test.ts` do.
- End stdout with a JSON object holding `ok` and `estimateUsd`, and say in the file's header what a
  run costs.

## Measured

2026-09-24, on `469278e` plus story 003. Herdr 0.8.2; codex on the ChatGPT subscription, claude on
claude.ai.

- `bun run eval`: 3/3 passed in 63 s, ~$0.09 — `harnesses` ~$0.05, `minimum-review` ~$0.04,
  `failed-run` under a cent.
- Two more full runs: ~$0.16 (`harnesses` ~$0.11) and ~$0.12. Spend varies run to run.
- 2026-09-26, on `a7c36ef` with Herdr 0.9.1: 3/3 passed in 72 s, ~$0.09 — `harnesses` ~$0.05,
  `minimum-review` ~$0.05, `failed-run` under a cent.
- 2026-09-26, `sandbox` under srt (story 004): passed in 2m 20s, ~$0.13, twice in a row once
  its three failures were fixed (X22, X23, and a probe prompt codex's cheapest model would run).
  Under docker it has not run: the daemon was not answering. Later luna declined every command
  in one run of two, so the probe's codex is gpt-5.6-sol: 2m 41s, ~$0.30. `sandbox-panes-srt`
  passed after Task 5's review fixes in 2m 40s, ~$0.29.
- 2026-09-26, all evals after story 004's Task 5 and 6: 5 passed and `sandbox-docker` skipped (its
  daemon did not answer) in 6m 13s, ~$0.58. `sandbox-srt` was ~$0.20, of which claude's $0.15 was
  metered: it varies run to run.
- 2026-09-26, docker once its daemon answered: `sandbox-docker` passed in 2m 39s, ~$0.29, and
  `sandbox-panes-docker` in 2m 56s, ~$0.32, each on its first run; after Task 5's review, 2m 48s
  (~$0.31) and 3m 07s (~$0.31). OrbStack stopped answering twice when several agents drove it at
  once: if a docker eval fails for its daemon, try it again alone.
- 2026-09-26, story 007: `skills` passed in 15 s, ~$0.06, its first run lost to a Haiku pane that
  wrote over its own launcher. `harnesses`, `failed-run`, `minimum-review`, `sandbox-srt` and
  `sandbox-panes-srt` passed, ~$0.73 in all. `sandbox-srt` needs `CLAUDE_CODE_OAUTH_TOKEN`
  exported, and `minimum-review`'s preflight refuses one: run them apart. `minimum-review` also
  fails if the repository changes while it runs, edits by hand included. A sandboxed claude pane
  once declined the probe as pasted instructions.
- 2026-09-26, story 007 review: `skills`, rewritten to prove each agent used its skill, passed
  5/5 on its first run in 38 s, ~$0.08.
- luna first failed `failed-run` 3 times in 4: it typed the launcher's macOS temp path
  (`/var/folders/…/T/…/wf`) without the `/` before `T`. With the control plane under `/tmp` it
  passed 4 of 4.
- Before moving to the cheapest models, the same checks cost ~$0.50: `minimum-review` on sonnet and
  gpt-5.6-sol was ~$0.29.
- Catalogue review: 19 agents, 7 m 54 s, ~$6.77 (story 002).
