# @agentswf/lab

`awf-lab` tells you whether one workflow is better than another. It runs a workflow on **cases
whose answers are known**, has a **scorer** grade what it returned, and compares the numbers.

Code review is the first kind of case. A case is a real merge request, frozen at the moment review
started. Its **key** lists the problems that turned out to be real. A review workflow scores well
when it finds those problems and doesn't say things that are wrong.

```text
                     one-agent-bare    catalogue-review
must-fix             2/5               3/5
should-fix           0/9               5/9
weighted recall      0.19              0.49
precision            1.00              0.93
wrong                0/7 (0%)          0/27 (0%)
trial                36m  $5.79        1h 18m  $13.38
```

The full reference, covering every flag, record and rule, is [`docs/reference.md`](docs/reference.md).

## How it works

```text
for each case:
  1. restore the frozen code into a temporary checkout
  2. awf run {variant}, in a sandbox     ─▶ findings      (a trial)
  3. awf run {scorer}, which reads the key ─▶ one label per finding   (a score)
then: report turns the stored scores into numbers, and compares two variants
```

- **Everything is an ordinary `awf run`.** The workflow being tested (a **variant**) and the
  scorer are both plain workflows.
- **A trial can't see the answer.** It runs in a sandbox that holds only the checkout and the
  merge request's description, never the key.
- **Nothing is overwritten.** Records are written once. Running again does only what's missing, so
  repeating a command costs nothing.
- **Reading is free.** `run`, `score` and `loop` spend money on live agents. They show a plan and
  an estimate, and ask before spending. `list`, `report`, `check`, `show` and `schema` only read.

## The words

| Word | Means |
| --- | --- |
| **workspace** | a folder with `awf-lab.json`: datasets, variants, scorers and results |
| **dataset** | a sealed set of cases |
| **case** | one input plus its **key**, the known answers |
| **variant** | the workflow under test, plus how to hand it a case and read its result |
| **trial** | one run of a variant on one case |
| **scorer** | a workflow that labels each finding: `hit`, `new`, `wrong`, `noise`, … |
| **baseline** | the variant you compare against |
| **verdict** | `better`, `worse`, `tie` or `undecided`, from a statistical comparison |

The main number is **weighted recall**: the share of the key's problems a review found, with
must-fix problems counting 3, should-fix 2 and could-fix 1. **Precision** and the **wrong** share
guard against a review that just says more.

## Getting started

Datasets are private, so a workspace lives in its own repository. Link the package into it:

```sh
cd packages/lab && bun link
cd ~/my-workspace && bun link @agentswf/lab
```

A minimal `awf-lab.json`:

```json
{
  "clone": "../project",
  "datasets": "datasets",
  "dataset": "first",
  "results": "results",
  "runs": "runs",
  "variants": ["variants/*.variant.ts"]
}
```

`clone` is a checkout of the project the merge requests came from. Datasets are built by a workflow,
`src/review/build/fixtures.workflow.ts`, which collects merge requests from GitLab and has agents
draft and vote on each key. The reference explains how.

## Writing a variant

A variant is your workflow, unchanged, plus a small file that says how to call it:

```ts
// variants/single-agent.variant.ts
import { defineReviewVariant } from "@agentswf/lab/review";
import review from "../workflows/single-agent/workflow.ts";

export default defineReviewVariant({
  workflow: review,
  argv: ["--range", "{base}...HEAD", "--request", "{request}"], // filled in per case
  timeout: "30m",
  read: (result) =>
    result.findings.map((f) => ({ path: f.file, line: f.line, text: f.claim, severity: f.severity })),
  version: "1.0.0",
});
```

The variant's name is the file stem. Results belong to `{name}@{major}.{minor}`, so bump the minor
version when a change alters what the variant does: it then starts with no trials. A patch bump
keeps them.

## Comparing two variants

```sh
awf-lab run my-review --cases 8 --dry-run                  # see the plan and what it costs
awf-lab run my-review --baseline one-agent --cases 8       # run both, case by case, until decided
awf-lab report my-review --baseline one-agent --cases 8    # the numbers and the verdict, for free
```

With `--baseline`, `run` stops as soon as the verdict is settled. A verdict is cautious on purpose:

- `better` is given only at case counts planned in advance (8, 16 and all), so checking as cases
  come in can't create a false win.
- Eight cases often end `undecided`. That's an honest answer: the difference may still be noise.
- `--trials 2` runs each case twice, which separates a real difference from luck with fewer cases.

`awf-lab check {variant}` says, from stored records alone, whether your cases can tell a change from
noise at all.

## Holding cases out

Choose some cases to set aside before you start tuning:

```json
"holdout": { "first": { "cases": ["app-41", "app-57"], "chosen": "2026-09-30" } }
```

Every command then acts as if those cases weren't there. Only `loop --final` uses them. A variant
you tuned while looking at a case will look better on that case than it really is, and held-out
cases give an honest final number.

## The loop: letting an agent improve a workflow

`loop` automates "edit, run, compare, keep if better":

1. A **proposer** agent reads a **program** (your notes on what to try), the current best workflow,
   and what it missed on each tuning case. It writes a changed `workflow.ts` and says why.
2. Code checks that the change stays in scope. It may use only the author surface, with no files,
   network or process, and it may not copy file names or wording from the keys.
3. The new workflow runs against the current best on the tuning cases. It replaces the current best
   only if the verdict is `better`.

```sh
awf-lab run air-lenses --cases 8               # the start needs scored trials to learn from
awf-lab loop lens-tune --baseline air-lenses \
  --program programs/review.md --source variants/air/workflow.ts --budget 20
awf-lab loop lens-tune --baseline air-lenses --rounds 3      # resume: three more tries
awf-lab loop lens-tune --baseline air-lenses --final --budget 10   # the best one, on the holdout
```

The first run names the program, the start's workflow file and a spending cap. After that, the loop
resumes from its records in `results/{dataset}/loops/{name}/`. It stops when the cap is spent, or
after 3 tries in a row keep nothing.

## Commands

| Command | Does | Spends |
| --- | --- | --- |
| `list` | what the workspace holds: datasets, cases, variants, scorers | no |
| `run {variant}` | the missing trials, then their scores | yes |
| `score {variant}` | scores stored trials again, such as with a new scorer | yes |
| `report {variant}` | metrics side by side; with `--baseline`, a verdict | no |
| `check {variant}` | whether the cases can tell a change from noise | no |
| `show {variant} {case}` | one case, trial or finding in full | no |
| `loop {name}` | an agent proposes changes and keeps only the better ones | yes |
| `schema` | the JSON Schema of each record and `--json` output | no |

Common flags: `--cases {n}` (the first n cases, in a fixed seeded order), `--trials {n}`,
`--jobs {n}` (run in parallel), `--budget {usd}`, `--dry-run`, `--yes` and `--json`.

## Read more

- [`docs/reference.md`](docs/reference.md): every term, label, metric, comparison rule, flag and
  file location.
- [`AGENTS.md`](AGENTS.md): how the package is laid out, and the rules for changing it.
- Stories [008](../../docs/stories/008-review-scorer.md) (scoring),
  [011](../../docs/stories/011-compare-variants.md) (verdicts) and
  [013](../../docs/stories/013-autoresearch-loop.md) (the loop): why it works this way.
