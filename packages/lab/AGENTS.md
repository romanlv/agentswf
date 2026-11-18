# @agentswf/lab

Tools for evaluating workflows against cases with known answers, and later for improving them.
It has two kinds of case, and one command line, `awf-lab`, whose entry `src/cli.ts` hands a
command to either: `case` and `runs` are the case kind's; otherwise `--dataset` naming a folder
beside `awf-lab.json` with a `dataset.json` of kind `awf.case-dataset/0` is, and without it the
case kind serves a workspace that names no review `datasets`, the review kind one that does. Each
kind keeps its own flags and help.

**The case kind** (story 044; its rules, for a dataset's author, are `docs/cases.md`, kept current as it changes), `src/cases/`: `format/` (pure: `dataset.json` and `key.md` in
`settings.ts`, the strict key reader `key.ts`, the trial file, the env variables, and the run,
trial and score records), `env/` (`@agentswf/lab/cases` and the `fetch` preload: what runs in a
trial's own process, in the project), and `lab/` (the lab's side: datasets and cases, `case new`,
the checks before the first trial, the lock and the store under `~/.awf/lab/`, each trial's
folders and marker search, the reach check, `expect`, blame, verdicts, the report; grading in
`grading.ts`, shared by `run` and `score`: a dataset's code graders through `code-graders.ts` and
the grade helper, grader workflows through `workflow-graders.ts` and a grade folder that
`gradeCase()` reads, and `score.ts`, which plans and grades kept trials again). It never
imports `review/` and names no word of one workflow's domain (`mail`, `review`, `finding`); the
boundary checker holds both. `lab/` is pure but for `cli.ts`, `code-graders.ts`, `dataset.ts`,
`folders.ts`, `git.ts`, `grading.ts`, `inspect.ts`, `record-copies.ts`, `runs.ts`,
`scaffold.ts`, `score.ts`,
`store.ts`, `trial.ts`, `workflow-graders.ts` and `workspace.ts`.

**What both share**, `src/shared/`: the process seam (`runner.ts`: a request, `awf run`'s argv,
starting this checkout's `awf` or a folder's own bin with a preload, record parsing), the common
fields of `awf-lab.json` (`config.ts`: `kind`, `judgeAgent`, `store`; `config-file.ts` finds and
reads it, in a folder or its `evals/`), and the schema checks (`validate.ts`). It imports neither
kind and is pure but for `runner.ts` and `config-file.ts`.

**The review kind**, `src/review/`, holds review fixtures (story 005) and their scoring (story 008), in `src/review/` by purpose:
`format/` (the formats and their checks), `fixtures/` (reading, checking and sealing a set:
`seal.ts` writes `set.json`, each fixture pinned by a digest), `build/` (`collect`, code that
freezes a GitLab MR as a fixture; `draft-key`, where an agent drafts the answer key and code
checks it against the fixture; and `fixtures.workflow.ts`, which runs both and seals the set),
`judge/` (match first, the review scorer: `matching.ts` settles what Jev matches surely,
`voting.ts` has voters label the rest, which with nothing settled is the retired panel,
`judge.workflow.ts`; and the check every judgement passes), `metrics/` (pure
numbers from records), and `lab/` (`awf-lab`, the command line that runs a variant and a scorer
per case through `awf run` and keeps the trials and scores in the workspace's results; its runner
adds the contained mode and `summaryOf` to the shared seam). Story 008 has its terms and command
line. Its `awf-lab.json` fields are checked only when a review dataset is used.

`src/compare/` (`@agentswf/lab/compare`, story 011) turns two variants' per-case numbers into a
verdict: `pairedComparison` and the types a workspace's `*.compare.ts` uses. It knows nothing of
reviews, imports nothing, and is pure; review folders may import it. `review/metrics/named.ts`
gives a review's metrics their names, and `review/lab/default.compare.ts` is the built-in
comparison.

It is a consumer of the engine (ADR 0002): it may import `@agentswf/contract` and the engine's public
entry, never a harness; `awf-lab` starts workflows with the checkout's own `awf run` and reads the
record it prints. Every file in `src/review/` is pure except those the boundary checker names as
doing I/O (`fixtures/git.ts`, `verify.ts`, `seal.ts`; `build/gitlab.ts`, `collect.ts`,
`draft-key.ts`; `judge/case.ts`; `lab/cli.ts`, `execute.ts`, `provenance.ts`, `load.ts`,
`runner.ts`, `store.ts`, `workspace.ts`; `lab/loop/bundle.ts`, `loop.ts`, `scope.ts`; the
workflows; the index). A folder imports only the folders below it, and `src/shared/`: `format`
nothing else of ours, `fixtures` `format`, `build`, `judge` and `metrics` those two, `lab` all but
`build`; the boundary checker keeps the order. Agents are used only where a step needs judgement:
drafting a key and its graders' votes, and judging a review. No person is in the loop.

Every file it writes in a format of its own has a TypeBox schema and is checked before it is
written. The case kind's are in `cases/format/` (published as `schema/case-*.schema.json`); the
review kind's in `review/format/`: the case formats in `format.ts`, the records `awf-lab` writes in
`records.ts`, its config in `workspace.ts`, and what each command prints with `--json` in
`output.ts`. A variant or scorer is identified by the version its file declares, nothing else:
an edit that changes what it measures bumps it, and the records keep only the file's commit, as
provenance. The raw GitLab
responses under `key/evidence/gitlab/` are kept as GitLab sent them, unvalidated. After changing
a schema, regenerate `schema/` with `bun packages/lab/src/write-schemas.ts`.

GitLab is reached only through `glab api`, read-only. Fixtures and their data live outside this
repository, in the project's own autoresearch repository. It imports the package by name, linked
from a clone: `bun link` here, then `bun link @agentswf/lab` there. `@agentswf/lab/review` is the
entry; `@agentswf/lab/review/{dir}/{file}` reaches any other module, with no promise it stays.
