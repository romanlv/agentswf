# @agentswf/lab

`awf-lab` tells you whether a change made a workflow better. It runs the workflow on **cases whose
answers are known**, grades each result against its case's **key**, and compares two versions of
the code, or two settings, case by case.

The full reference, covering every file, flag, record and rule, is [`docs/cases.md`](docs/cases.md).
A worked example is [`examples/refund-desk`](../../examples/refund-desk/README.md).

## How it works

```text
evals/{dataset}/cases/{case}/   input, files and key.md, what a good result looks like
for each case, each trial:
  1. env.ts builds the case's world in a throwaway folder: files, a checkout, mocked services
  2. awf run {your workflow}                  ─▶ its result, and what env.ts reads off it
  3. the graders: expect, the key's criteria judged, your own code or grader workflows
then: the report, a verdict per case, and, between two columns, graders.ts's compare
```

- **Everything is an ordinary `awf run`**, of the workflow in your checkout, as it is.
- **A trial can't see the answer.** The key stays in the lab; with `"sandbox": { "lab": "srt" }`
  the whole trial runs in one box that reads no key.
- **Nothing is overwritten.** Records are written once, and a trial is reused while nothing that
  shaped it changed, so repeating a command costs nothing.
- **Spending asks first.** `run` and `score` print a plan and an estimate and ask at a terminal;
  without one, as in CI, they run without asking, and `--yes` skips the question anywhere. `loop`
  spends only up to its required `--budget`. `report` and `runs` only read.

## The words

| Word | Means |
| --- | --- |
| **workspace** | `evals/` with `awf-lab.json`, in your project |
| **dataset** | a folder of `evals/` holding `dataset.json`, `env.ts` and `cases/` |
| **case** | one input plus its **key**, what a good result looks like |
| **trial** | one run of the workflow on one case |
| **column** | one folder of code under one set of parameters; the first is the reference |
| **grader** | what turns a trial into a verdict or numbers: `expect`, the criteria judge, or yours |
| **verdict** | a case's: `passed`, `failed`, `flaky` or `unclear`, from its trials; a column's: `better`, `worse`, `tie` or `undecided` against the reference, from `compare` |

## Getting started

With `agentswf`, `@agentswf/lab` and `typescript` in your project
([`docs/cases.md`](docs/cases.md#a-first-dataset) says how):

```sh
awf-lab case new mail/trip-form      # awf-lab.json, dataset.json, a stub env.ts and the case
# fill env.ts and delete its first line; write the case's input and its key's expect
awf-lab run --dataset mail           # every case, graded
awf-lab report --case trip-form      # one case in full
```

## Comparing

```sh
awf-lab run --against ../other-checkout                  # the same cases on other code
awf-lab run --vary model=claude-haiku-5-5,claude-sonnet-5-5
```

The dataset's `graders.ts` says what "better" means, as `compare`: for example `better.paired`
from `@agentswf/lab/cases`, on a grader's numbers, with guards that may not get worse. A verdict
is cautious on purpose: `better` is given only at case counts planned in advance, and a small
difference ends `undecided`.

## The loop

`awf-lab loop {name} --budget {usd}` lets an agent improve the workflow: a proposer, in the lab's
box, reads the tuning cases' feedback and the operator's program, changes a copy of the code, and
the copy is kept only when `compare` says better than the last kept one. Held-out cases
(`dataset.json`'s `holdout`) are never shown to it; `loop {name} --final --budget {usd}` checks
the kept code on them once, and `loop {name} --patch` prints it as a patch.

## Commands

| Command | Does | Spends |
| --- | --- | --- |
| `case new {dataset}/{case}` | a case folder, and the workspace the first time | no |
| `run` | each case, each trial, in each column, graded | yes |
| `score [{run}]` | grades kept trials again, such as with another grader or judge | yes |
| `report [{run}]` | the last run, or the one named | no |
| `capture {trial id}` | a new case from a past trial or a real run | no |
| `label {trial id}` | your verdict on a trial | no |
| `loop {name}` | a proposer's changes, kept only when better | yes |
| `runs` | the runs kept, newest first | no |

## Read more

- [`docs/cases.md`](docs/cases.md): every file, flag, record and rule.
- [`AGENTS.md`](AGENTS.md): how the package is laid out, and the rules for changing it.
- Story [044](../../docs/stories/044-cases-for-a-workflow.md): why it works this way.
