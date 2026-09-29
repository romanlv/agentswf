# Testing

How awf is checked, what each level costs, and when to run it. Costs are list-price estimates from
the run's own accounting. Every live check here runs on subscription logins, and the estimate is
what the same tokens would cost metered, a proxy for the quota used, with one exception:
`sandbox-srt` and `sandbox-docker` run claude headless, which is billed per token even on a subscription (E3), so
their claude share, $0.07–0.15 a run, is money.

## Levels

### 1. Offline — every change, free

```sh
bun test          # ~440 tests, under a minute
bun run check     # Biome, tsc, the package boundaries
```

No live agent runs. Harnesses are replaced by fakes: `@agentswf/harness/testing` has a fake adapter and a
fake Herdr CLI, and fake session files stand in for the harnesses' usage logs. The tests in `tests/`
drive the real examples (`minimum-review`, `quick-check`, `catalogue-review`) and `awf run` itself
through those fakes, so example workflows are covered here too.

Each sandbox provider also has a local test, `packages/sandbox/src/srt/srt.local.test.ts` and
`packages/sandbox/src/docker/docker.local.test.ts`. It runs the real provider with `sh` standing in
for each agent, no model: the conformance suite, then what the provider allows and denies. It is
part of `bun test` and free, and skipped where its provider is not installed; docker's also where
the daemon does not answer within 5 s or the default image is not built.

The fakes encode what the real CLIs do today. They go stale silently, which is what the live levels
are for.

### 2. Evals — every supported feature, live, about $1.50

```sh
bun run eval                        # all of them, one after another: ~15 min, about $1.50
bun run eval harnesses failed-run   # only the ones named
```

`*.eval.ts` files under `tests/` start live agents, assert what they did, and print what they
cost. `bun test` does not collect them. `bun run eval` is the consent to spend: it sets
`AWF_LIVE_EVAL=1`, which each eval requires, and ends with each eval's time and cost and the total.
Each runs on a cheap model — codex `gpt-6-luna`, claude `claude-haiku-4-5`, pi
`openai-codex/gpt-5.6-terra` — because an eval checks the machinery, not
the quality of the answer.

What they cover between them:

- `harnesses` — quick-check across codex and pi headless and claude in a Herdr pane, through
  `awf run`. Every answer must be right, the headless ones including a follow-up in the same
  session, and every agent's spend known and billed to its subscription. 3 agents, ~20 s,
  $0.05–0.11.
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
  each running fixed commands against canaries the host planted: files under `~`, in harness
  state and in the temp directories, a listener, a disallowed domain, a git hook, another
  sandbox's home. Checked from the agents' own transcripts, the listener and the working tree.
  3 agents, ~2½ min, ~$0.30, of which claude's ~$0.07 is billed per token, estimated. codex runs on gpt-5.6-sol:
  luna declined the probe's commands. Neither is skipped: each fails, saying why, where its
  provider is not installed or docker's daemon does not answer within 30 s, so a sandbox
  regression cannot pass unseen. `sandbox-docker` builds the default image first when it is
  missing.
- `sandbox-panes-srt` — the same probe with codex and claude in terminal panes of the run's Herdr,
  typed in behind srt's confining prelude, and also refused the run's Herdr socket, leaving no
  secret or process behind; processes are found by their environment, where a pane's carry the
  run's path. 3 agents, ~3 min, ~$0.30; claude in a pane is on its subscription.
- `skills` — agents given one of two probe skills and using it (story 007): codex, pi and a
  claude pane on the host, and codex and pi sharing one srt sandbox with different probes. The
  prompt never mentions skills; it asks for a build's release stamp and audit seal, each claimed by
  one probe's description and made only by a script inside it, from a secret no `SKILL.md` holds.
  Each agent must make its own probe's value for its own build id and not the other's, leave the
  script's receipt in its own copy and none in a source or snapshot, list its own probe and none of
  the operator's skills; `output.json` must record each, the git-sourced probe with its commit.
  `tests/skills-eval.test.ts` checks these checks for free. 5 agents, ~40 s, ~$0.08, on
  subscriptions; srt must be installed.
- `review-judge` — the panel judge (story 008) through `awf run`, on a synthetic fixture: a
  two-file change with two planted issues, a hand-written key, and six findings with known labels.
  The judgement must pass `checkScorerResult` and hit both planted issues; how many of the six labels
  match, the panel's κ and the tiebreak are printed, since they are what it measures. codex luna
  and claude haiku judge, luna breaks ties. 3 agents, ~1–1½ min, ~$0.09 at list prices, and
  $0.07–0.14 of claude's own reported cost; awf assumes headless claude is billed per token
  ([`billing-provenance`](stories/todo/billing-provenance.md)). Three runs,
  2026-09-27: 5/6 labels, κ 0.80.
- `sandbox-panes-docker` — the same, with the panes in the box's own Herdr, typed in behind a
  prelude that sets their environment and loads their secret. 3 agents, ~3 min, ~$0.32. Fails,
  saying why, where docker cannot run.

Added up, the figures above come to ~9 min and ~$0.90 without docker; `sandbox-docker` and
`sandbox-panes-docker` add ~6 min and ~$0.60. All are list-price estimates.

Not covered live, on purpose:

- claude headless outside a sandbox: it is billed per token even on a subscription. The sandbox
  evals run it, as a sandboxed claude has no other way to run headless. `review-judge` is the
  exception: the panel runs its judges headless, so its eval does too.
- Deadlines, nudges, parallel limits and cleanup: the offline suite drives them through fakes, and
  a live run adds only a slower clock.

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
  eval`, all of it — at about $1.50 there is no reason to pick. Record the date, outcome and cost in the
  story's Verification section.
- **While working on one area:** the matching eval — `harnesses` for an adapter, liveness or usage
  reader; `minimum-review` for panes, the control plane or the result channel; `failed-run` for run
  lifecycle, cancellation, accounting or `output.json`; `sandbox-srt` and `sandbox-docker` for
  `packages/sandbox`, a harness's sandbox needs, or the engine's sandboxes; `skills` for
  `engine/src/skills`, `harness/src/capabilities` or a harness's launch arguments; `sandbox-panes-srt` and
  `sandbox-panes-docker` for a sandboxed pane, the Herdr host's typed start or a box's Herdr.
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
