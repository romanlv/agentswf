# @agentswf/lab

Tools for evaluating workflows against cases with known answers, and for improving them. Its one
command line, `awf-lab`, is `src/cli.ts`; the rules for a dataset's author are `docs/cases.md`,
kept current as it changes.

**The cases**, `src/cases/` (story 044): `format/` (pure: `dataset.json` and `key.md` in
`settings.ts`, the strict key reader `key.ts`, the trial file, the env variables, the run, trial
and score records, and the loop's), `env/` (`@agentswf/lab/cases` and the `fetch` preload: what
runs in a trial's own process, in the project), `loop/` (the loop's proposer, a workflow), and
`lab/` (the lab's side: datasets and cases, `case new`, the checks before the first trial, the
lock and the store under `~/.awf/lab/`, each trial's folders and marker search, the reach check,
`expect`, blame, verdicts, the report; grading in `grading.ts`, shared by `run` and `score`: a
dataset's code graders through `code-graders.ts` and the grade helper, grader workflows through
`workflow-graders.ts` and a grade folder that `gradeCase()` reads, and `score.ts`, which plans and
grades kept trials again; the loop in `loop.ts` and `loop-command.ts`; and `retired.ts`, the older
lab's commands and flags refused with what replaced them). It names no word of one workflow's
domain (`mail`, `review`, `finding`); the boundary checker holds it. `lab/` is pure but for
`box.ts`, `cli.ts`, `code-graders.ts`, `compare.ts`, `dataset.ts`, `folders.ts`, `git.ts`,
`grading.ts`, `inspect.ts`, `labels.ts`, `loop.ts`, `loop-command.ts`, `record-copies.ts`,
`reuse.ts`, `runs.ts`, `scaffold.ts`, `score.ts`, `store.ts`, `trial.ts`, `workflow-graders.ts`
and `workspace.ts`.

**What the cases share**, `src/shared/`: the process seam (`runner.ts`: a request, `awf run`'s
argv, starting this checkout's `awf` or a folder's own bin with a preload, record parsing),
`awf-lab.json` (`config.ts`: `kind`, `judgeAgent`, `store`, `records`, `hide`; `config-file.ts`
finds and reads it, in a folder or its `evals/`, and refuses a `/0` one or the older lab's by
name), the plan-window wait (`allowance.ts`), and the schema checks (`validate.ts`). It imports
nothing of `src/cases/` and is pure but for `runner.ts`, `config-file.ts` and `allowance.ts`.
`src/shared/compare/` turns two columns' per-case numbers into a verdict:
`pairedComparison`, which `better.paired` wraps. It imports nothing, and is pure.

It is a consumer of the engine (ADR 0002): it may import `@agentswf/contract`, never a harness;
`awf-lab` starts workflows with a folder's own `awf run` and reads the record it prints. Agents
are used only where a step needs judgement: the criteria judge and a dataset's grader workflows,
and the loop's proposer.

Every file it writes in a format of its own has a TypeBox schema in `cases/format/`, published as
`schema/*.schema.json`, and is checked before it is written and when it is read. After changing a
schema, regenerate `schema/` with `bun packages/lab/src/write-schemas.ts`. The records, the grade
folder's `grade.json` and `awf-lab.json` are `/1`; a `/0` one is named and refused or left out,
never converted.

Datasets with private data live outside this repository, in their own project's `evals/`, which
links the package by name from a clone.
