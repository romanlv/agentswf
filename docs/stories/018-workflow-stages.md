---
id: "018"
title: Run a workflow as named stages, and continue it from one
summary: A run is one piece of work with an id, given or generated, and numbered attempts; a workflow marks its stages inline; the run keeps each stage's current record, and a continue reuses the ones that succeeded and runs the rest. The view, costs and endings read by stage. awf gains `stage` and `stop`; the prototype's ask, durations and md are left to the boilerplate and the next story.
type: story
status: in-progress
discovered_in: implement-ticket flow.ts live runs, AIRS-1515, 2026-10-02
depends_on: []
---

# Run a workflow as named stages, and continue it from one

The model is in [[runs-and-stages]]: what a workflow, run, attempt, stage and stage record are,
the files on disk, one attempt from start to end, and what breaks it. This story is the plan to
build it.

## Outcome

```ts
export default defineExecutableWorkflow({
  definition: {
    meta: { name: "implement-ticket", description: "…" },
    id: ({ ticket }) => ticket, // the run's id, unless --id gives another
    async run(workflow, { ticket }) {
      const worker = await workflow.agents.open({ key: "worker", runtime: CLAUDE, cwd: AGENT_DIR });

      // ask and md come from the workflow's boilerplate, over awf's run and stop
      const doc = await workflow.stage("doc-review", { result: DOC_REVIEW }, async () => {
        const doc = await worker.ask(DOC_REVIEW, { timeout: "45m" }, md`
          Review the ticket doc for ${ticket} …
        `);
        if (doc.kind === "no-doc") workflow.stop(doc.reason); // inside: a continue redoes doc-review
        return doc;
      });
      if (doc.kind === "open-questions") return { kind: "not-ready", questions: doc.questions };

      await workflow.stage("implement", { result: IMPLEMENTED }, async () => {
        await worker.compact({ prompt: "Keep the doc, the plan's decisions, the branch and worktree." });
        return worker.ask(IMPLEMENTED, { timeout: "3h" }, md`Implement ${ticket} from ${doc.docPath} …`);
      });
      // review, mr, qa the same way
    },
  },
  prepare: ({ argv }) => parseArgs(argv),
});
```

```
awf run flow.ts -- AIRS-1515                              # run AIRS-1515, its id from the workflow's id(args)
awf run flow.ts --id retry-2 -- AIRS-1515                 # the same ticket as another run
awf run flow.ts --continue AIRS-1515                      # attempt 2: reuses what succeeded, runs the rest
awf run flow.ts --continue AIRS-1515 --from-stage qa      # …or from qa on
```

- **A run is one piece of work, with numbered attempts.**
  - It has an id, unique within its workflow in the storage folder: given with `--id`, derived by
    the workflow's `id(args)`, or generated.
  - `--continue` adds an attempt to the same run, with the argv it was started with.
- **Stages are marked inline.**
  - `workflow.stage(name, options?, work)` names the step.
  - A stage returns nothing, when it only has to happen, or a value checked by its `result` schema.
    A reused stage isn't run: its work isn't called, and it gives back its recorded value.
- **A continue reuses the stages that succeeded and runs the rest.** The stage plan in
  [[runs-and-stages]] decides each stage. A record that no longer fits stops the attempt there,
  with the command to go on. Reaching its start point, an attempt moves the records it didn't
  reuse to `replaced/`.
- **Robust to the workflow changing.**
  - A run belongs to the workflow's `meta.name`, so moving, renaming or copying the file changes
    nothing.
  - Changed code is expected between attempts. Changed types are caught by the stage schemas,
    which stop the attempt at the stage whose record no longer fits.
- **Progress, cost and endings by stage.**
  - The view names the run, its attempt and its current stage, groups agents under it, and
    collapses finished stages.
  - `byStage` splits the worker's cost.
  - A stop or failure names its stage and prints `--continue`.
- **The prototype's plumbing goes.** These move into awf: `stages()`, `OUTLINE`, `Results`,
  `run(script, stopped)`, `StageRecord`/`jsonRecord`/`memoryRecord`, the `session()` wrapper, the
  workflow's `Stopped` type and its `--from` parsing. `stop` becomes awf's; `session().ask` and `md`
  stay in the workflow's boilerplate, now calling awf's `stop`.


Why now:
- The first live runs ([run notes](~/dev/braintrust/agent/workflows/implement-ticket/run-notes.md))
  needed all of this:
  - the view couldn't say the run was in QA;
  - the agent that did everything was one cost line;
  - a restart worked only because the workflow kept its own record;
  - the restart came after a code fix, so attempts on changed code are the normal case.
- [[stopped-run-recovery]], [[run-logs-and-telemetry]] and [[turn-liveness-and-limits]] wait on
  stages.
- Changing the published surface and the run dir is cheapest now.

## The author surface

awf provides the API; convenience wrappers ship in a workflow's boilerplate, which an author copies
and changes, as shadcn components are ([[ideas]]). The prototype's `flow.ts` against awf's surface
today, and what this story does about each:

- **Stages.**
  - Prototype: `stages(workflow, OUTLINE, { from, record })`, plus a hand-written `Results` type.
  - awf: `workflow.stage(name, options?, work)`, typed from `work`, checked by `options.result`,
    with an optional `summary(value)` for the view. **Now.**
- **Stop.**
  - Prototype: `stop(reason)`, and `run(script, stopped)` builds a `Stopped` result.
  - awf today: a throw, which reads as a failure.
  - awf: `workflow.stop(reason): never` ends the attempt `stopped`, in the stage it is in. **Now.**
- **The run's id.**
  - Prototype: the record was keyed by the ticket.
  - awf: an optional `id(args)` in the workflow's definition, beside `prepare`. The workflow
    defines it; awf calls it before creating the run, and `--id` overrides it. **Now.**
- **Ask, durations and inline prompts.** `ask(schema, { timeout: "3h" }, prompt)`, which stops on
  anything but an answer, and `md`. Wrappers over `run` and `stop`: they stay in the boilerplate.
  Whether `timeout: Duration` replaces `timeoutMs` in awf's API is [[readable-workflows]]. **Not
  here.**
- **Compact.** `compact({ prompt })` is unchanged. **No.**
- **Named parallel results, and prompt files.** [[readable-workflows]]. **Later.**

## Scope

In scope:
- runs, attempts and their claims, laid out as in [[runs-and-stages]];
- `--id`, `--continue` and `--from-stage`;
- stages, their records and the stage plan;
- the author surface marked **now**;
- the view, accounting and endings by stage;
- the consumers.

Out of scope:
- [[runs-and-stages]]'s "Later" list: `awf status`, `awf continue {workflow}/{id}`, `--to-stage` and
  `--only-stage`, `--skip-stage`, `fresh`, fork, a status the workflow sets.
- Reopening agents' sessions on a continue, and debug mode ([[stopped-run-recovery]]).
- Live cost during a run, `awf logs` and OTel ([[run-logs-and-telemetry]]).
- Per-stage limits and pending background work ([[turn-liveness-and-limits]]).
- A status command for a live run ([[operator-run-observation]]).
- Red log lines: fixed already (commit 4f54d32).

## Context and evidence

- **Fact: "stage" means two unrelated things in the engine today.**
  - Accounting: `stageOf` in `packages/engine/src/accounting/summary.ts` is the agent key's prefix.
  - Progress: `StageProgress` in `packages/engine/src/run-progress.ts` is a labelled `parallel`. An
    agent records only the stage it was opened in, which is why the worker was one line.
- **Fact: a turn's `label` reaches no record.** It is read only by the test fake and the scripted
  host.
- **Fact: per-operation spend exists.** `share` in `packages/engine/src/run-usage.ts`.
- **Fact: a stopped run has no shape in awf.** `present` and `report` see only a succeeded value.
  "Stopped at qa" was the prototype's own string.
- **Fact: runs aren't identified.**
  - `operator-cli.ts` makes `~/.awf/runs/invocation-{uuid}/{runId}` per invocation.
  - Nothing records the args.
  - The Herdr workspace is labelled `awf ${basename(file)}` for every ticket.
- **Fact: the prototype works.** Two live runs, and a `--from qa` that replayed three stages
  after a code fix. A side effect at a stage boundary reran on replay; here reused stages run no
  code.
- **Context: the original plan.**
  - foundation.md §10 left journal and resume until effect boundaries, persistence and versioning
    were decided.
  - E6 found replay of every call "is not enough".
  - Continuing from stages answers those for their narrower case. That amends the plan, so it
    needs an ADR (task 1).
- **Comparable tools.**
  - GitHub Actions: runs with attempts, "re-run failed jobs", concurrency groups.
  - Temporal: a workflow id apart from the run id.
  - `dbt retry`: reruns what failed, read from the last results.
  - LangGraph: threads and checkpoints.
  - Claude Code, Codex and pi: sessions always recorded, continued by id.
  - docker: containers with optional unique names and a status.
- **Constraint: ADR 0001.** Each published type lands with its implementation and a workflow that
  uses it (task 8).
- **Constraint: [[operator-run-observation]].** Herdr ids aren't portable workflow state.

## Code map

### contract

- `workflow/workflow.ts`: `WorkflowContext` gains `stage` and `stop`, and `runId` becomes the run's
  id, beside `attempt`. `Steps` is unchanged.
- `workflow/agents.ts`: `OperationRecord` gains `stage` and `label`.
- `workflow/decisions.ts`: `DecisionRecord.stage`.
- `workflow/executable.ts`: the optional `id(args)`, and `present` and `report` taking an ending.
- `records.ts`: `RunRecord` (`run.json`), `AttemptRecord`, `StageRecord`, the `stopped` outcome, and
  `OutputRecord` with its attempt and stages.

### engine

- New: `runs.ts`, the only module that knows `.awf/`'s layout. It creates runs, claims ids, opens
  attempts, replaces stage records, and reads the run's status.
- New: `stage-plan.ts` (pure) and `stage-ledger.ts` (per attempt: current stage, one at a time, at
  most once, writes stage records).
- `workflow-runner.ts`:
  - `context.stage` and `context.stop`;
  - `ExecutionScope` carries the stage;
  - progress per turn, not per open.
- `run-dir.ts`: an attempt's own files, under `runs.ts`.
- `run-progress.ts` and `progress-view.ts`: stages, the run's id and attempt.
- `run-usage.ts`: copies `stage` and `label`.
- `accounting/`: `stageOf` from stages; a run's total across attempts.
- `operator-cli.ts`:
  - `--id`, `--continue` and `--from-stage`;
  - the workspace label;
  - `ENDINGS` for `stopped` and `interrupted`;
  - `watchProgress`, `handOver`.
- `workflow-testing/`: `testWorkflow(…, { fromStage, recorded })`, `run.stages`, `run.stopped`, and
  `stage` on turn and compaction records.

### sandbox

- `resolve.ts`: a sandbox may contain the run root (`./.awf`); the check that a sandbox path isn't
  inside the run root stays.
- `srt/profile.ts`: the run root denied for writes as well as reads.
- `docker/`: an empty tmpfs over the run root inside the container.

### Checked, no change

- `harness` (beyond the workspace label passed in) and `wf`.
- `lab` runs `awf run` and reads `output.json`. Check where it finds that file, and that it handles
  `stopped`.

### Outside the repo

- `~/dev/braintrust/agent/workflows/script.ts` shrinks or goes.
- `implement-ticket/flow.ts` moves onto awf's stages, and loses its record beside the ticket.

## Tasks at a glance

- [x] 1. Decisions and the ADR: the open questions below and in [[runs-and-stages]]; ADR 0011
  "A run continues from its stages".
- [x] 2. Runs and attempts: `runs.ts`, `run.json`, attempts, id and attempt claims, `--id`,
  `--continue`, labels.
- [x] 3. Stages recorded: `workflow.stage`, the ledger, tagging, stage records, test support.
- [ ] 4. Continue from a stage: the stage plan, `--from-stage`, removing stale records, schemas, test
  support.
- [ ] 5. The author surface: `stop`, `id(args)` and `summary`, documented, with the boilerplate's
  `ask` and `md` over them.
- [ ] 6. The view by stage.
- [ ] 7. Accounting and endings by stage.
- [ ] 8. Consumers: an example with stages, and implement-ticket on awf's stages, run live.

## Open questions

The design's questions are settled ([[runs-and-stages#Decided]]);
[[runs-and-stages#Settled in the second pass]] lists what was settled by reasoning, to veto. The
design doc's "Checked against implement-ticket" walks the live runs through the model. What is
left was task 1: the operator accepting [ADR 0011](../adr/0011-a-run-continues-from-its-stages.md),
taken as given when they asked for the implementation (2026-10-04).

Decided:

- **One stage at a time.** Parallel work goes inside a stage, including child workflows run with
  `call`, which can run in parallel. (2026-10-04)
- **`feature-delivery` carries the in-repo proof** (task 8). (2026-10-04)
- **awf provides the API; wrappers ship in the boilerplate.** `ask`, `md` and durations leave
  this story. (2026-10-04)
- **The view shows each agent's placement and pane id.** The view is for the operator, not portable
  workflow state, so [[operator-run-observation]]'s line holds. (2026-10-04, second pass)
- **`byStage` per attempt and summed per run;** no per-agent split within a stage yet.
  `turns.jsonl` keeps the data for one. (2026-10-04, second pass)

## Task execution rule

Process one task at a time. Each task repeats the checklist under its details. Don't begin the next
task just because the current one compiles. Its design must be recorded, its diff reviewed by
subagents, findings resolved, and focused verification complete.

After all tasks are complete, run story-level verification and request human review of the complete
deliverable.

## Task details

Every task from 2 on runs the same checklist:

- [ ] Plan: inspect the code and tests, and settle the module, interface, invariants, failure
  behavior and proof.
- [ ] Implement: only this task's change, with focused tests.
- [ ] Review: two read-only subagents on the diff, one for architecture and scope, one for
  correctness and proof.
- [ ] Resolve: disposition every material finding.
- [ ] Verify: every `Done when` item.

### 1. Decisions and the ADR

Outcome: the task 1 questions are answered, here and in [[runs-and-stages]]. ADR 0011 records that
a run continues from its stages within its own attempts, why that isn't the shelved journal, and
what it rules out.

Done when:
- One subagent has read the ADR against E6's findings. Done 2026-10-04; its findings are folded in.
- The operator has accepted it: by asking for the implementation, 2026-10-04.
- [[#Readiness]] holds.

### 2. Runs and attempts

Outcome:
- `awf run` creates a run.
- `--id` claims an id, and `--continue` adds an attempt with the recorded argv.
- The attempt claim refuses a second live attempt.
- The view, workspace and endings name the run.
- Old `invocation-*` dirs are left alone.

Done when `runs.ts` tests cover, against a temp root:
- an id given, an id generated, and a taken id refused;
- a continue, and a continue with argv refused;
- a live attempt refusing, and a dead one (no `ended`, no process) read as `interrupted`;
- two attempts claimed at once: exactly one runs, and the refused one leaves no file;
- leftover `.tmp-*` and `.new-*` temp files and folders ignored;
- a continue after `meta.name` changed, pointing at the old folder;
- a deleted run dir freeing its id;
- a newer `version` refused;
- writes that leave no partial file.

Plan (2026-10-04):
- **contract.** `RunRecord` and `AttemptRecord` in `records.ts`, each with its `version`;
  `WorkflowMeta.version`; `WorkflowContext.attempt`. The call's `Attempt` becomes `Candidate`, and
  `attempts.jsonl` becomes `candidates.jsonl`. `OutputRecord` goes to version 5, with `attempt`;
  `runId` is the run's id.
- **engine `runs.ts`.** The only module that knows the layout:
  - `createRun` claims the id by renaming `.new-{random}/` into place, and writes `.gitignore`;
  - `openRun` finds a run, or the workflow it is under;
  - `claimAttempt` links its file and refuses when an earlier attempt is live;
  - `endAttempt` rewrites the attempt file with its ending;
  - `runStatus` reads the status off the attempt files;
  - `writeJson` writes a file whole, mode 0600.
  
  `RunRefused` carries every refusal, which exits 2. Liveness goes through a probe that tests can
  replace.
- **runner.** `RunWorkflowOptions.run` passes `{ dir, id, attempt }` in. Without it, the runner
  makes `runRoot/{uuid}` as today, for tests and `workflow-testing`. `label` names the Herdr
  workspace (`awf {workflow} {id} #{n}`), through the harness's `HarnessRunSpec.label`.
- **operator-cli.**
  - The run root is `.awf/runs` under `--cwd`.
  - `--id` and `--continue` are added. A continue takes argv, `cwd` and `sandbox` from `run.json`,
    and refuses others.
  - The run and the attempt are claimed before the runtime is installed, so a refusal exits 2 at
    once.
  - Every later exit ends the attempt.
  - `output.json` and `report.md` go in the run's folder.
  - The caller claim moves to `~/.awf/callers`.
  - `--here --continue` prepares the recorded argv.
- **sandboxes. Deviation from the design.** A sandbox's folder is `~/.awf/sandboxes/{uuid}`, not
  under the run. On macOS, srt emits a deny nested in an allowed path after the allow. With
  `.awf/runs` inside the project, which is allowed, the deny would also cover a sandbox folder
  under it. Linux's tmpfs-and-rebind doesn't have this problem.
  - `RunSandboxOptions.directory` sets where sandbox folders go.
  - `forbidden()` allows a path that contains the run root, and still refuses one inside it.
  - srt gains a `denyWrite` for the run root, and its `checkProfile` accepts an allowed path
    containing a run root that is denied for reads and writes.
  - docker mounts a tmpfs over a run root that lies inside a mount.
- **lab.** A contained run moves `{workflow}/{id}` into `runs/`. `stopped` comes with task 5.
- **Moved to task 3:** `turns.jsonl` and its torn-line test, since turns are written with their
  stage.

### 3. Stages recorded

Outcome:
- `workflow.stage` runs a stage and writes its record to the run's `stages/`.
- Every turn, compaction and decision inside it carries its stage and turn label.

Done when runner tests cover:
- a stage run;
- a second entry, and two stages at once, rejected;
- an agent's turns in two stages;
- a failed, stopped and cancelled stage;
- a value its schema rejects;
- a workflow without stages, unchanged;
- a torn `turns.jsonl` line skipped, with a later attempt's lines after it (moved from task 2).

Plan (2026-10-04):
- **contract.**
  - `StageRecord` and `TurnRecord` in `records.ts`.
  - `OperationRecord` gains `stage` and `label`, and `DecisionRecord` gains `stage`.
  - `WorkflowContext.stage` has two overloads, with `StageOptions` (`result`, `summary`).
  - The harness's `AuthoredTurn` gains `stage`, so a host sees it.
- **engine.**
  - `stage-ledger.ts` owns the rules: a name, one stage open at a time, at most once each. It
    writes each stage's record when the stage ends.
  - The runner's `ExecutionScope` carries the workflow stage. A stage runs in a scope of its own,
    which it cancels on failure.
  - A stage's value goes through JSON and is then checked by its schema; a stage without `result`
    returns nothing.
  - The ledger tags each operation with its stage and its turn's label, and appends it to
    `turns.jsonl` as it settles.
  - A stage left open when the body ends is recorded `failed`.
- **workflow-testing.** `run.stages`, and `stage` on each turn.
- **Deviations.**
  - A `stopped` stage comes with `stop`, in task 5. Until then, cancellation and a throw are
    `failed`, with their reason.
  - `stage` on compaction records is deferred: a compaction reaches the harness as positional
    arguments, and no test needs it yet. Its operation record and `turns.jsonl` line carry the
    stage.
  - A stage inside a `call`'s child isn't checked: `call` is unavailable in the runner.

### 4. Continue from a stage

Outcome: a continue follows the stage plan in [[runs-and-stages]], row by row.

Done when:
- `stage-plan` tests cover every row: reuse with and without a value, another major version, a
  record that no longer fits, nothing recorded after `--from-stage`, and the start point.
- Stale records: reaching the start point moves every record not reused to `replaced/`, the start
  stage's first; an attempt that stops before its start point moves nothing; after a crash
  mid-stage or mid-move, a continue starts at that stage.
- Stops: inside a stage the continue redoes it; between stages it checks again; the same stop
  twice says to move the check.
- A continue with no `--from-stage` from the first unrecorded stage, a `--from-stage` never
  reached, a completed run refused without `--from-stage`, and a stage renamed in the code.
- `testWorkflow(…, { fromStage, recorded })` reuses recorded stages without calling their work.
  That is the live run's compaction-on-continue bug, as a test, and it catches a variable assigned
  inside a stage.

### 5. The author surface

Outcome: `stop`, `id(args)` and a stage's `summary` are published and documented in
`docs/workflow-api.md`. implement-ticket's boilerplate keeps `ask` and `md`, its `ask` now calling
awf's `stop`.

Done when there are tests for `stop` inside a stage, between stages and before any, `id(args)`
deriving the id and `--id` overriding it, and `bun run check` passes.

### 6. The view by stage

Outcome:
- **The header:** `{workflow} {id} · attempt {n} · {stage} · {elapsed} · {n} working`.
- **Stages in the order entered:**
  - finished ones collapsed with time and outcome;
  - reused ones `↺` with their attempt;
  - those still to come, from the run's earlier attempts, dim.
- **The current stage expanded:** each agent with its placement, turn label and turn time.
  `waiting` rather than ✓ while its stage goes on.

Done when progress-view tests render a continued run mid-stage, the same run as non-TTY events,
and a run without stages, which is unchanged.

### 7. Accounting and endings by stage

Outcome:
- `byStage` comes from stages, per attempt and summed per run.
- A stopped, failed, cancelled or interrupted attempt prints its stage, its reason, and
  `awf run {file} --continue {id}`.
- `present` and `report` can render a stop.

Done when `accounting.test.ts` covers an agent across three stages, a reused stage at zero cost,
a run across two attempts and the key-prefix fallback, and `tests/operator-cli.test.ts` covers
each ending.

### 8. Consumers

Outcome:
- `examples/feature-delivery` uses stages, with tests for a full run and a continue.
- implement-ticket runs on awf's stages, with the prototype's helper gone.
- One live run and one continue are checked against the view, the records and `byStage`.

Done when the tests pass and the live notes are in [[#Implementation notes]].

## Verification

Automated:

- [ ] The tests named in each task.
- [ ] `bun test`, `bunx tsc --noEmit`, `bun run scripts/check-boundaries.ts`, `bun run check`.

Manual or live evaluation:

- [ ] One implement-ticket run with `--id`, then a continue `--from-stage qa` after a code change, by the
  operator. That is a ticket's run, ~$10–20 per the run notes, plus QA.
- [ ] Two cheap `examples/` runs side by side, to see the view and the workspace labels live.

## Review record

### Task 1

- ADR review:

### Task 2

Two subagents, 2026-10-04. Resolved:
- **Blocking, `~/.awf` no longer refused.** The old run root, `~/.awf/runs`, covered it, and the
  move into the project uncovered every sandbox's homes. `forbidden()` now refuses a path inside
  `~/.awf`, with a test.
- **Sandbox folders orphaned.** They go under `~/.awf/sandboxes/{workflow}/{id}/{uuid}`, found
  by their run. `runs.ts` builds the `~/.awf` paths, `machinePaths` and `sandboxesOf`.
- **`meta.name` and `meta.version` unchecked.** The loader refuses a name that can't be a folder
  and a version that isn't semver, with tests.
- **A continue from elsewhere.** "No run" now says a run is kept under its working directory,
  which `--cwd` names.
- **Refusals left a run behind.** A new run whose first attempt claim fails is discarded. Only
  ids differing in case are refused before the rename, so the rename claims every exact id and
  the race test exercises it.
- **Liveness.** `ps` runs in UTC, and start times a second apart match (Linux derives `lstart`
  from the boot time).
- **The ending is written before cleanup and the hand-back.** It is rewritten as `failed` only
  if cleanup fails.
- **`--here` refusing late.** `prepareRun` refuses a taken `--id` and a live attempt, so the tab
  never opens for one.
- **Races.** An attempt file gone between listing and reading is skipped. A completed run is
  refused at the attempt claim too, not only before it.
- **`label`** moved into `run`, and the runner refuses a `run.dir` outside `runRoot`. A run
  root holding `~/.awf/sandboxes` is refused. `report.md` is written whole.
- **Tests added:**
  - recorded argv that no longer parses;
  - a working directory that is gone;
  - `--sandbox` on a continue;
  - a refused new run leaving the root unchanged;
  - a fresh `.new-*` folder invisible;
  - liveness a second apart.

Accepted, not changed:
- **Other projects' runs.** A sandbox reading `~/dev` reaches every other project's
  `.awf/runs`, as it reaches their source. Recorded in [[runs-and-stages#Sandboxes]].
- **Interrupted attempts.** The message names an interrupted attempt's workspace without asking
  Herdr whether it is still open.
- **The completed-run refusal's text.** Task 4 adds "`--from-stage {stage}` to redo from there".
- **Case on Linux.** On a case-sensitive filesystem, two ids differing only in case and claimed
  at the same instant can both succeed.
- **Sandbox comparison.** `checkContinue` compares sandbox specs by their JSON text, so key order
  counts. The message says to leave `--sandbox` out.
- **The write-failure test** proves that the old file stays whole and the temp file is removed,
  not that a crash mid-write is safe; renaming the temp file into place is what makes that hold.
- **Untested:**
  - `--here --continue` has no test of its own; it runs the same `prepareRun` the tests cover;
  - Linux `ps`.

### Task 3

Two subagents, 2026-10-04. Resolved:
- **Blocking: a torn `turns.jsonl` line swallowing the next attempt's first line.** Each attempt
  ends a torn last line before it appends. The test now runs two real attempts with the torn
  line between them.
- **`TurnRecord`.** It has its own fields, no longer `OperationRecord`'s, and gains `outcome`,
  reported through the ledger entry's new `ended`. A line has no cost, since spend is read from
  sessions once the attempt ends; task 7 sums it from there.
- **A stage's `sessions`.** They are the session each of its turns ran on, the last one its agent
  had when the turn settled, not every session the agent had.
- **Records written once, before the result.** The ledger is sealed when the body ends, so
  nothing the body left running enters a stage. It is closed after the agents close: a stage
  still open is failed, and every write in flight is awaited. A stage that throws cancels its
  scope and waits a grace for its turns to settle before its record.
- **The result schema** is parsed before the work runs, with the stage named.
- **`run.stages`** follows the order of entry, now on `SettledRun.stages`.
- **Tests added:**
  - a stage's own cancellation, seen by the turn's signal before the run ends;
  - a run stopped mid-stage;
  - the deadline's reason and sessions;
  - a compaction carrying its stage;
  - two stages at once, recording only the first;
  - ledger unit tests for the races.

Accepted, not changed:
- **Naming.** `ExecutionScope.stage`, a labelled `parallel`'s progress, sits beside
  `workflowStage`. The view's rework in task 6 renames it.
- **Cancellation reasons.** A cancelled turn's reason doesn't name the stage, and `readTurns`
  doesn't check `version`.
- **Untracked stages.** A `void workflow.stage(…)` isn't tracked by its parent scope.

### Tasks 4–8

- Architecture and scope:
- Correctness and proof:

## Readiness

- [x] Outcome and boundaries are concrete.
- [x] Relevant implementation, callers, and tests are mapped.
- [x] Evidence and research support the proposed design.
- [x] Expensive interface, record-format, and stage-gate decisions are settled: ADR 0011.
- [x] Tasks are ordered, coherent, and independently verifiable.
- [x] Open questions are resolved or explicitly moved out of scope.

## Implementation notes

## Human review

- [ ] Every task is complete and story-level verification passes.
- [ ] Set the story status to `awaiting-human-review` and present the outcome, architecture
  decisions, task-level subagent findings and dispositions, exact verification results, deviations,
  and remaining risks.
- [ ] Record the human's explicit approval or requested changes here.
- [ ] If changes are requested, return to the affected task and repeat its review and verification.
- [ ] Only after explicit approval, mark the story `done` and update `Stories at a glance`.
- [ ] review state file, as it might need changes
