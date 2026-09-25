# Testing

How awf is checked, what each level costs, and when to run it. Costs are list-price estimates from
the run's own accounting. Every live check here runs on subscription logins, so nothing is charged
per token; the estimate is what the same tokens would cost metered, and a proxy for the quota used.

## Levels

### 1. Offline — every change, free

```sh
bun test          # ~440 tests, under a minute
bun run check     # Biome, tsc, the package boundaries
```

No live agent runs. Harnesses are replaced by fakes: `@wf/harness/testing` has a fake adapter and a
fake Herdr CLI, and fake session files stand in for the harnesses' usage logs. The tests in `tests/`
drive the real examples (`minimum-review`, `quick-check`, `catalogue-review`) and `awf run` itself
through those fakes, so example workflows are covered here too.

The fakes encode what the real CLIs do today. They go stale silently, which is what the live levels
are for.

### 2. Evals — every supported feature, live, about $0.10–0.16

```sh
bun run eval                        # all of them, one after another: ~1 min, $0.09–0.16
bun run eval harnesses failed-run   # only the ones named
```

`*.eval.ts` files under `tests/` start live agents, assert what they did, and print what they
cost. `bun test` does not collect them. `bun run eval` is the consent to spend: it sets
`WF_LIVE_EVAL=1`, which each eval requires, and ends with each eval's time and cost and the total.
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

Not covered live, on purpose:

- claude headless: it is billed per token even on a subscription, so an eval would cost real money.
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
  eval`, all of it — at $0.10–0.16 there is no reason to pick. Record the date, outcome and cost in the
  story's Verification section.
- **While working on one area:** the matching eval — `harnesses` for an adapter, liveness or usage
  reader; `minimum-review` for panes, the control plane or the result channel; `failed-run` for run
  lifecycle, cancellation, accounting or `output.json`.
- **Level 4:** only when a story names it.

## Adding an eval

- Name it `*.eval.ts` under `tests/`, and refuse to start without `WF_LIVE_EVAL=1`. `bun run eval`
  picks it up.
- Use the cheapest model that exercises the feature.
- Go through `awf run` (`runOperatorCli`) where possible, so the operator runtime and the record
  are what is tested. Use `runWorkflow` only when the eval must observe the harness from inside.
- Assert outcomes from the record, not from prose.
- End stdout with a JSON object holding `ok` and `estimateUsd`, and say in the file's header what a
  run costs.
- Keep any pure logic in the eval unit-testable, as `tests/minimum-review-eval.test.ts` does.

## Measured

2026-09-24, on `469278e` plus story 003. Herdr 0.8.2; codex on the ChatGPT subscription, claude on
claude.ai.

- `bun run eval`: 3/3 passed in 63 s, ~$0.09 — `harnesses` ~$0.05, `minimum-review` ~$0.04,
  `failed-run` under a cent.
- Two more full runs: ~$0.16 (`harnesses` ~$0.11) and ~$0.12. Spend varies run to run.
- luna first failed `failed-run` 3 times in 4: it typed the launcher's macOS temp path
  (`/var/folders/…/T/…/wf`) without the `/` before `T`. With the control plane under `/tmp` it
  passed 4 of 4.
- Before moving to the cheapest models, the same checks cost ~$0.50: `minimum-review` on sonnet and
  gpt-5.6-sol was ~$0.29.
- Catalogue review: 19 agents, 7 m 54 s, ~$6.77 (story 002).
