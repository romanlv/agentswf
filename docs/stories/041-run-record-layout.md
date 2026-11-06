---
id: "041"
title: "A run's records, one home per fact"
summary: "A run's folder gets the layout of docs/design/run-record.md: run.json, run.jsonl with a published readRun, in.jsonl, attempts/, log.jsonl, ops/{agent}.{n}/, out.json and work/, before agents.wf leaves evaluation."
type: story
status: done
depends_on: ["039"]
---

# A run's records, one home per fact

## Outcome

A run's folder, `.awf/runs/{workflow}/{id}/`, has the layout [[run-record|docs/design/run-record.md]]
designs. Each fact has one home, chosen by who writes it and who relies on it:

- what the run settled is a closed set of lines in `run.jsonl`, whose reading, `readRun`, `contract`
  publishes;
- what came in is `in.jsonl`;
- each turn, message operation, compaction or decision is a folder `ops/{agent}.{n}/` or
  `ops/{decision}.{n}/`;
- the log is only read, never acted on;
- `out.json` and `report.md` are views;
- harness scratch is under `work/`.

Why now: record formats are what everything else builds on: `awf logs`, `awf runs`, 040's client, an
agent reading a run, a dashboard, the optimizer. Today's layout grew one story at a time, and
the todo `run-record-layout`, now folded in here, measured seven places where it has drifted, on
2026-11-04:

- a step's answer has three stores;
- the mailbox holds the run's own lines;
- a continue reads the log;
- sessions are recorded four ways;
- decisions are overwritten each attempt;
- the return value lives only in `output.json`;
- records share the folder with scratch.

Changing this is cheap while agents.wf is in evaluation and costs a deprecation cycle once it isn't.
039's test option `earlier: { stages, mailbox }` is the first piece that gets published, with the
next beta.

## How it works

```text
{id}/
  run.json        identity, written once; `format` versions the four files below
  run.jsonl       what the run settled: claimed, stage, race, timer, took, wait,
                  turn-started, turn-ended, session. One writer, fenced by its claim.
  in.jsonl        events from senders, appended under {id}.lock
  attempts/{n}.json   claim, ending and `value`; a failed background launch too
  launches/{launch}.log
  log.jsonl       the story, best effort; nothing that acts reads it
  ops/{key}.{n}/  op.json, answers.jsonl, result.json, decision.json,
                  spend.json, live.jsonl, screen.txt
  out.json, report.md   views of the last ended attempt
  work/           skills/, agents/, staging/, forks/
```

**A continue** reads `run.jsonl`. For each key (a kind and a name) the latest line wins. Each stage
has two answers: `last`, its latest line, and `settled`, its latest `succeeded` or `provided`
line, which is what a continue may reuse. A redo is a `stage` line with `redo: true`, under 039's
rule as built.

**A wait** merges `in.jsonl`'s events, the `turn-ended` lines and due timers, and writes what it took
and acknowledged as `took` and `wait` lines. A fired timer is never appended as an event: the
`took` names it by its derived id.

**Claiming an attempt:**
1. wait until the previous attempt's process is gone, for every run;
2. truncate `run.jsonl` to its last newline;
3. append `claimed`;
4. end the turns a crashed attempt left;
5. settle any `spend.json` it didn't write;
6. list `ops/` to learn each key's last `n`.

Any line an older attempt writes after that `claimed` is ignored.

**Cost** is each operation's `spend.json`, priced when it is read. Only `out.json`, a view, holds a
priced figure.

**The question people ask first.** What happens to runs made before this? They are listed as
`unreadable` and are not read. The design ignores compatibility on purpose: agents.wf is in
evaluation, and a better shape replaces the shipped one, with no shims.

## Scope

In scope:

- every file in the design's folder, its writer and its readers, as the design's "Who changes"
  table lists them;
- `contract`:
  - the `RunLine` and `EventLine` types;
  - `readRun`;
  - `format`, in place of `RunRecord.version`;
  - the tiers in `records.ts`;
  - the attempt file without `stages`, `accounting` and `unacknowledged`, and with `value`;
- agent and decision keys become names, and share one namespace;
- the test option `earlier: { stages, events, run }` and `TestRun`'s matching fields, in place of
  039's `{ stages, mailbox }`;
- ADR 0014 for the record, amending ADR 0011's "Persistence" paragraph;
- `docs/design/runs-and-stages.md`'s "State on disk";
- every site page that names a gone file: `output.json`, `calls/`, `turns.jsonl`, `mailbox.jsonl`,
  `stages/`, `replaced/`, `decisions/` or `process.log`, `data.md` among them.

Out of scope:

- reading or migrating runs made before this;
- refusing a colon in a key, and cost grouping becoming one row per agent: both are 039's task 10
  (`039:541`, `039:546`), and the lab's colon keys move there;
- a child call's scope (`wf.call` is unbuilt; it gets a new `format` when it is built);
- [[crash-leftovers-reaper]]'s process record: the attempt file is its home, but the record is
  designed there;
- a cost cache for `awf runs` over thousands of runs (design, "Open");
- [[workflow-state]]'s author API and its saving: `state` is in the line types and `readRun`, but no
  task writes it, since nothing produces state yet.

## Context and evidence

- **Fact:** the design, its measurements and the alternatives it set aside are
  `docs/design/run-record.md`. The drift list is the Outcome's, from the todo `run-record-layout`.
- **Fact:** today a continue reads the log. A run with events resumes its agents' sessions through
  `keptSessionsOf(await readTurns(runDir))` and recovers turns through `recoverTurns`, both called
  from `workflow-runner.ts:633-637`.
- **Fact:** operation ids are `randomUUID()` in `workflow-runner.ts`:
  - turns at ~3304;
  - compactions at ~3369;
  - decisions through `ledger.reserve` at ~3637;
  - message operations at ~4105.

  The others in the file are bundle, fork, turn and run ids.
- **Fact:** decisions write `decisions/{n}.json` with a plain `writeFile` (`decisions/directory.ts:272`).
  Their numbers come from a per-instance counter, so each attempt starts again at 1.
- **Fact:** `previousGone` (`runs.ts:793`) is called only `if (run.record.events)`
  (`run-prepare.ts:261`).
- **Fact:** what an agent key refuses today:
  - a reserved key (`RESERVED_PARTICIPANT_KEYS`, `contract/src/participant.ts:14`);
  - an outside participant's key.

  A colon only logs the `colon-key` deprecation (`workflow-runner.ts:1680`,
  `deprecations.ts:49`); 039's task 10 makes it a refusal. `nameProblem`
  (`contract/src/workflow/events.ts:14`) is the rule events, stages and races already follow; it also
  refuses capitals, spaces and `#`, which `examples/site/guide/loops.ts:58` (`implementer#2`) uses.
- **Fact:** `screen.txt` shipped in `calls/{operationId}/` (e08d85e). Moving it renames only its
  parent folder.
- **Fact:** 040 names an event's integration `source`, in the mailbox record today and `in.jsonl`
  here. It records `args` "into whichever record ships first" (`040:194`). The design's `EventLine`
  now says `source`, and `RunRecord` has `args`: whichever of 040 and this story lands second takes
  the field over.
- **Constraint:** foundation §8 prices a run when it is summed, never when it is written.
- **Constraint:** ADR 0011 is kept: stages are reused by name, code runs again from the top, and
  calls are not replayed.
- **Constraint:** 039's task 10 refuses a colon in a key and removes `awf send --event-id`, which
  gates on the log (`holder-command.ts:251`). Tasks 2 and 5 wait for it: before it, task 2's name rule
  would refuse `triage:${id}` (`examples/triage/workflow.ts:22`) and the lab's `match:`, `key:` and
  `vote:` keys. That is the whole of `depends_on: ["039"]`.
- **Constraint:** the lab reads `accounting` from `awf run --json` (`lab/src/review/lab/runner.ts:228`)
  and only renames run folders (`execute.ts:484`). So `out.json` keeps `accounting`.
- **Assumption:** `F_FULLFSYNC` per line costs little at tens of lines per run. M1 measures it.

## Code map

### packages/contract

- `src/records.ts`:
  - `RunRecord`: `format` replaces `version`, and it gains `args`;
  - new: `RunLine`, `EventLine` and `readRun`;
  - the attempt record drops `stages`, `accounting` and `unacknowledged`, and gains `value`;
  - `RunJson.stages` (`:930`) gains `value`;
  - the log loses `session-known` and its `sessions` fields;
  - the log gains `sandbox-opened`, skills and placement on `agent-opened`, `kept` on
    `agent-stopped`, and `operation` on a decision's lines;
  - a tier comment on each type.
- `src/workflow/events.ts`, `nameProblem`: reused for agent and decision keys.
- `src/workflow/agents.ts`: an agent key's documented rule.

### packages/engine: what the run settled

- `stage-plan.ts`, `stage-ledger.ts`, `run-prepare.ts`, `runs.ts`:
  - the pure reading of `run.jsonl` replaces `stages/`;
  - `replaced/`, `replaceStale`, `stage-ledger.ts`'s `sessionsOf`, and in `contract` `StageRecord`,
    `STAGE_RECORD_VERSION` and their `stages/` comments (`records.ts:384`, `:478-503`,
    `contract/src/workflow/executable.ts:34`) go;
  - the other users of `StageRecord` and `readStageRecords` follow: `attempt-ending.ts:39`
    (`choose`), `stopped.ts:27` (`FromStageUnreached.recorded`), `attempt-view.ts:280-305`
    (`refusalMessage`, `listRecorded`), `workflow-runner.ts:509`, and the tests `continue`,
    `emit-e2e`, `receive`, `stages` and `runs.test.ts:371`;
  - `lastRedo` reads `redo` lines.
- A new pure module, with no I/O and importing contract only, holds the engine's policy over the
  lines:
  - reuse;
  - what a wait takes;
  - the held batch;
  - which turns need an end.

  Task 4 creates it, and `scripts/check-boundaries.ts` gains it as it has `engine/src/accounting`.
- `mailbox.ts`:
  - merges `in.jsonl`, `turn-ended` and due timers;
  - writes `took`, `wait`, `race`, `timer`, `turn-started` and `turn-ended`;
  - stops appending `timer:due`, `at:due` and `agent:ended`.
- `run-prepare.ts`, the claim: `previousGone` for every run, then truncate, `claimed`, turn
  recovery (moved from `workflow-runner.ts:633`), missing `spend.json`, and listing `ops/`. Its
  "interrupted in stage …" notice (`:276-279`) already reads the log, and only follows the rename.

### packages/engine: senders and readers

- `emit.ts`:
  - a starting event goes into `.new-*/in.jsonl` before the rename;
  - dedupe reads `in.jsonl`;
  - a returned run is refused by reading the attempt file's `value`.
- `wake.ts`, `tick-command.ts`:
  - read attempt files and `readRun`'s wait and timers;
  - `wake`'s readiness (`:95-98`, `foldMailbox` for the last wait and what is due) reads
    `readRun`;
  - `wake` replaces `process.log` (`:194-241`) with `launches/{launch}.log`, passes `AWF_LAUNCH`,
    and links a failed launch's attempt file.
- `run-state.ts`: `waiting` from `readRun`, `stuck` from attempt files only.
- `run-view.ts`, `run-read.ts`, `runs-command.ts`, `logs-command.ts`:
  - the story from `log.jsonl`;
  - stages, waits and sessions from `run.jsonl`;
  - `awf runs --json` gains each stage's `value`;
  - the cursor spans both files;
  - cost from `spend.json`;
  - `runs-command.ts`'s `records:` line;
  - `run-view.ts:199` builds the liveness path itself.
- `inbox-command.ts` (which reads the mailbox at `:708`) and `holder-command.ts`: the log, as
  today; wait labels from `readRun`.
- Comments and messages naming gone files: `index.ts:1`, `run-event-log.ts:44`, `help/run.txt:20-22`,
  `contract/src/records.ts` (`:108`, `:365`, `:390`, `:1262`), `contract/src/workflow/decisions.ts:124`.

### packages/engine: operations, accounting, scratch, tests

- Operations:
  - `result-slots.ts`, `runs.ts` (`writeCall` … `readAccepted`, `screenFile`, `writeScreen`),
    `operation-events.ts` and the test helper `testing/operation-events.ts:15` move to
    `ops/{op}/`, with the new file names (`liveness.jsonl` becomes `live.jsonl`);
  - `workflow-runner.ts` numbers turns, message operations, compactions and decisions per key, where
    it now draws a UUID;
  - opening an agent and asking a decision refuse a key that isn't a name, or that the other
    namespace already uses (`#assertFreeKey`, `workflow-runner.ts:1680`).
- `decisions/directory.ts`: `ops/{decision}.{n}/decision.json`, written whole, and named by
  `DecisionRecord.artifact`.
- Accounting:
  - `run-usage.ts`, `run-commands.ts` and `attempt-view.ts` read `spend.json` with `op.json`,
    priced at read;
  - `attempt-output.ts` writes `value`, `out.json` and `report.md`.
- Scratch:
  - `skills/run-skills.ts`;
  - `workflow-runner.ts`: `agents/` (`:2418`, where the codex home is set), `staging/` (`:2429`)
    and `forks/` (`:2665`), all moving under `work/`.
- Workflow tests: `workflow-testing/run-test.ts` (`:43-45`, `:126`, `:247`, `:452-456`, `:481`,
  `:654-673`, `:954`) and `testing.ts`
  take `earlier: { stages, events, run }`. `TestRun.stages` becomes the stage lines of the stages the
  test's attempt entered (task 4), and `TestRun.mailbox` becomes `events` and `run`.

### packages/agentswf

- `src/testing.typecheck.ts:81`, `:113`: `earlier: { stages, mailbox }` and `mailbox: []`.

### examples/, site/ and docs/

- Example tests that read `TestRun.stages` by `stage`, `attempt`, `outcome` and `summary`:
  `examples/feature-delivery/workflow.test.ts`,
  `examples/site/guide/{durability,how-it-works,runs}.test.ts`,
  `examples/site/patterns/review-on-event.test.ts`, `examples/event-sketches/mr-review.test.ts`
  (a `test.todo` on a stage never entered); and `site/reference/testing-api.md:358`,
  `site/guide/testing.md:86`, which describe that shape.

- `examples/site/guide/loops.ts:58`, `implementer#2`: a key that isn't a name.
- The site pages, found with `git grep -l` for the gone files' names under `site/`.
- `docs/design/runs-and-stages.md`, "State on disk".
- `docs/adr/0014-…`, and ADR 0011's "Persistence" paragraph.
- `docs/status.md`.
- 039's line 723: "event names", not the mailbox's record kinds.

### Checked, no change expected

- `packages/lab`'s code: it parses `awf run --json` and only renames run folders. Its colon keys are
  039's. Its `docs/reference.md:528` names `output.json` and follows in task 8.
- `packages/sandbox`: providers hide the whole run root (`sandbox/src/seam.ts:48-61`).
- `packages/harness`: the codex home is `join(bundle, "home")`, and the engine sets the bundle's
  path.
- `engine/src/agent-cli`: it does no file I/O.

## Proposed design

The design is `docs/design/run-record.md`, and this story builds it as written. Its rules are not
restated here. The decisions that shape the tasks:

- **Order by risk to what is published.**
  1. The new contract types first.
  2. Operations, which are self-contained.
  3. The claim, which the rest stand on.
  4. Stages, waits and sessions, which move a continue's inputs one at a time.
  5. Readers, views and docs last.
- **Each task keeps the suite green.** A task adds new types beside the old ones. An existing type
  changes in the task that moves its last writer and reader: the log types in task 6, the attempt
  record in task 7. Within the story, tasks may write both layouts while readers move over.
- **One format switch at the end.** When the story ends, the engine writes and reads only the new
  layout, and a run whose `format` is missing or unknown is `unreadable`. The commits go to main,
  but no beta is cut mid-story unless Q3 says so, and an unreleased state needs no compatibility.
- **The fence, the fsync and a crash before an event are tested at the file level:** a fake
  previous attempt that appends after a claim, a torn line, a `.new-*` folder that holds
  `in.jsonl` before its rename. They are not tested by killing a real process.

Alternatives rejected: those the design lists under "Considered and set aside".

## Tasks at a glance

- [x] 1. The record's new types in `contract`: line types, `readRun`, `format`, tiers, ADR 0014
- [x] 2. Operations: `ops/{key}.{n}/`, keys as names in one namespace, decisions written whole
- [x] 3. The claim: wait for every previous attempt, truncate, `claimed`, the fence
- [x] 4. Stages and redo from `run.jsonl`; `stages/` and `replaced/` go; `earlier.stages`
- [x] 5. Waits: `in.jsonl` and the run's own lines; timers and turn ends stop being events; `launches/`; `earlier.events` and `earlier.run`
- [x] 6. Sessions as `session` lines; the log is `log.jsonl` and nothing acts on it
- [x] 7. Attempt files keep `value`; `spend.json` priced at read; `out.json`; `work/`
- [x] 8. Readers, site and docs; old runs are `unreadable`

## Open questions

### Before refinement ends

- **Q1.** Is `docs/design/run-record.md` accepted as this story's design? The todo says nothing
  changes until it is reviewed. The short names and the key rule were settled on 2026-11-04, but
  the whole design was not.
- **Q2.** One story, or two? Task 2 and task 7's `work/` move stand alone and could ship first as a
  small story. The rest is one change to what a continue reads. A split lands `ops/` sooner, but
  leaves the record half-moved for a while.

### 4–5. The test option

- **Q3.** When does 039's next beta ship? (039's task 10, which tasks 2 and 5 wait for, may come
  before or after it.)
  - It could wait until tasks 1, 4 and 5 have wired `earlier: { stages, events, run }`, so that is
    what it publishes. The design recommends this.
  - Or it ships `{ stages, mailbox }` now, and this story deprecates it.

  A beta between those tasks would publish an option that type-checks and does nothing.

### 5. Waits

- **Q4.** Should `returns` and the first-wait rule stay as built (design, "Open")? Dropping either
  changes how 037's waits behave. That is cheaper before `format: 1` is published than after.

### 3. The claim

- **Q5.** Plain `fsync` or `F_FULLFSYNC` for `run.jsonl` on macOS? Bun 1.4.0's `sync()` is a plain
  `fsync` there, and neither Bun nor node exposes `F_FULLFSYNC`; `bun:ffi`'s `fcntl(fd, 51)` does.
  Measured on darwin arm64, 100 appends of a 100-byte line: 0.02–0.06 ms a line plain, 3.9 ms with
  `F_FULLFSYNC`. A plain `fsync` reaches the drive's cache, so a power loss or kernel panic can
  lose the lines of the last moments, a `claimed` or a settled stage included, after the step they
  settled returned; a process crash loses nothing. `F_FULLFSYNC` closes that at about 4 ms a line,
  and brings `bun:ffi`, marked experimental, into the engine. Linux's `fsync` already reaches the
  disk. Built: plain `fsync`.

## To measure

- **M1.** The cost of fsyncing every `run.jsonl` line (`F_FULLFSYNC` on macOS) on a run with
  hundreds of waits, such as an event run over a day. If it is noticeable, the fallback is to
  fsync only before a step returns to code that acts outside the run.
- **M2.** `awf runs` over 1,000 runs, with cost priced from `spend.json` at read, to see whether
  the "Open" cache is needed now.

## Task execution rule

Process one task at a time. Every task repeats the checklist shown under its details. Do not begin
the next task because the current one merely compiles: its design must be recorded, its diff
reviewed by subagents, findings resolved, and focused verification complete.

After all tasks are complete, run story-level verification and request human review of the complete
deliverable.

## Task details

Every task runs this checklist:

- [ ] Plan: inspect the relevant code and tests and record the architecture and focused proof.
- [ ] Implement: make only this task's coherent change and add focused tests with it.
- [ ] Review: obtain architecture/scope and correctness/proof subagent reviews of the actual diff.
- [ ] Resolve: disposition findings and obtain targeted re-review after material design changes.
- [ ] Verify: satisfy every `Done when` item before checking this task.

### 1. The record's new types in contract

Work:

- New in `records.ts`, beside today's types, which stay until their tasks:
  - `RunLine`'s nine kinds, `state` included;
  - `EventLine`, with `source`;
  - `format` and `args` on `RunRecord`;
  - a tier comment on each type.
- `readRun(lines)`, pure: for each stage, `settled`, `last` and its history (every line, with its
  attempt); the redo; races; timers with `due`,
  taken or withdrawn; state; the last wait; sessions. It refuses an unknown kind and drops fenced
  lines.
- ADR 0014, and ADR 0011's "Persistence" paragraph amended.

Done when:

- `readRun` has table tests for every rule in the design's "The rules" and "Redo", including:
  - the three-attempt redo example;
  - the fence;
  - state carried across lines;
- a line of an unknown kind is refused;
- `bun test` and `check-boundaries` pass.

### 2. Operations

Work:

Does not wait for 039's task 10 (decided 2026-11-05, "Decisions at the start"): a key is a name but
for a colon, which stays allowed and deprecated until that task refuses it.

- `ops/{key}.{n}/` replaces `calls/{uuid}/` and `decisions/{n}.json`, for turns, message
  operations, compactions, decisions, and an agent's start that failed.
- Its files are `op.json`, `answers.jsonl`, `result.json`, `decision.json` (written whole,
  named by `DecisionRecord.artifact`), `live.jsonl` and `screen.txt`. `spend.json`'s path is fixed
  here, and task 7 writes it.
- An op id `{agent}.{n}` and the tests' turn names `writer#2` (`during:`) count different things
  (a test's turns count nudges, an op's `n` compactions), so the turn names keep their `#`; the key
  `implementer#2` (`turnsOf`) becomes a name. (Changed in review, 2026-11-05.)
- `n` counts from 1 across attempts: each attempt lists `ops/` as it starts, which task 3 moves into
  the claim.
- An agent or decision key that fails `nameProblem`, a colon aside, or clashes with the other
  namespace, is refused at open or at ask. `implementer#2` in the site sample is renamed.
- `awf logs` shows the op id where it showed the UUID.

Done when:

- a two-attempt test numbers operations without reuse;
- a decision asked in both attempts keeps both files;
- `Reviewer`, `fix tests`, and an agent keyed as an earlier decision are each refused with a message
  naming the rule;
- screen evidence's tests pass at the new path, a failed start's included.

### 3. The claim

Work:

- `previousGone` for every run.
- Truncate `run.jsonl` to its last newline, then append `claimed`, through one fsynced `O_APPEND`
  writer.
- The folder rename and the attempt's `link` fsync their folder.
- Listing `ops/` moves into the claim.

Done when:

- a torn last line is cut, not merged;
- `readRun` drops a fake earlier attempt's line written after `claimed`;
- a run without events also waits for its previous attempt.

### 4. Stages and redo

Work:

- Stage ends are written as `stage` lines.
- The engine's pure policy module is created, and `check-boundaries` lists it.
- The stage plan, `--from-stage` and `attemptRefusal` read through it.
- `stages/`, `replaced/` and `replaceStale` go, with `StageRecord`, `STAGE_RECORD_VERSION`,
  `sessionsOf` and the stage-ledger's session test. Nothing in production reads a stage's sessions.
- `awf runs`' stage list (`run-view.ts:77-102`) stays the current attempt's, one entry per stage
  entered, in order:
  - an entry that ran or was provided takes its outcome and `value` from its own `stage` line, the
    one from this attempt with its name and `started`, ties broken by the order entered, since an
    event run enters a failed stage again in the same attempt (`#enterByContent`); the line's
    `started` must stay the one clock read that `stage-started` logs (`stage-ledger.ts:221`);
  - a reused stage takes `value` from `readRun`'s `settled`, the line it reused;
  - a running stage, and a stage the plan stopped, still come from the log's `stage-started` and
    `stage-ended`, which the design keeps for "the current stage", since `run.jsonl` has no line
    for either;
  - a stage settled earlier and not entered in this attempt is `readRun`'s to show, not this
    list's.

  `RunJson.stages` gains `value` only. Today's `run-view.ts:99` matches an end to the first entry
  of its name, which this fixes.
- `TestRun.stages` becomes stage lines, in place of `StageRecord`s, holding what it holds today:
  each stage this attempt entered, in the order entered. A stage it ran or was provided gives its
  own line; a reused stage gives the `settled` line it reused, with that line's earlier `attempt`.
  A stage the plan stopped writes no line and is absent, as today. The example tests and the two
  site pages in the code map follow (`stage` becomes `name`), and `run-test.ts:452-455`'s comment
  loses "sessions".
- The test option's `earlier.stages` and `TestRun.stages` read and write `stage` lines.

Done when:

- 018's and 039's stage and redo tests keep their outcomes, values and reuse decisions, asserted
  against the stage line where they asserted a `StageRecord`;
- the engine doesn't reuse a fenced `stage` line;
- a stage that failed and then succeeded shows both lines in `readRun`'s history of it, and its
  `last` is the success;
- in one attempt of an event run, a stage that failed and then ran again gives two entries in
  `awf runs --json`, each with its own line's outcome and value;
- every example test passes (`examples/**/*.test.ts`).

### 5. Waits

Does not wait for 039's task 10 (decided 2026-11-05, "Decisions at the start"): `awf send
--event-id`, which gates on the log, is left for that task to remove.

Work:

- `in.jsonl` is written under the lock, and an event that starts a run is written into
  `.new-*/in.jsonl` before the rename.
- The run writes `took`, `wait`, `race`, `timer`, `turn-started` and `turn-ended` lines.
- Timer and time ids are derived, and the run no longer appends `timer:due`, `at:due` or
  `agent:ended`.
- Turn recovery moves into the claim.
- `emit` dedupes against `in.jsonl`.
- `wake` writes `launches/{launch}.log` in place of `process.log`, passes `AWF_LAUNCH`, and links a
  failed launch's attempt file.
- Every reader of the mailbox's wait and timer lines moves with them: `wake`'s readiness
  (`wake.ts:95-98`), `run-state`'s `waiting`, the `unacknowledged` count in `attempt-output.ts`
  (counted from the `took` and `wait` lines until task 7 drops it), and `awf inbox`'s and
  `awf reply`'s wait labels.
- `stuck` reads attempt files only.
- The test option's `earlier.events` and `earlier.run`, and `TestRun`'s, replace `mailbox`;
  `agentswf`'s `testing.typecheck.ts` follows.

Done when:

- 034's, 036's and 037's wait, timer, race and keep-alive tests pass;
- a `.new-*` folder holds the starting event before its rename, so no run exists without it;
- a failed background launch is an attempt file that `stuck` counts;
- a parked run with a due timer is woken by `awf tick`, and a parked run with nothing due is not.

### 6. Sessions and the log

Work:

- `session` lines are written as soon as a session is known, and a kept session is resumed from
  them.
- `turns.jsonl` becomes `log.jsonl`:
  - the log types lose `session-known` and the `sessions` fields;
  - they gain `sandbox-opened`, skills and placement, `kept`, and a decision's `operation`.
- The "interrupted in stage" notice follows the rename.

Done when:

- a test that deletes `log.jsonl` between attempts still continues an event run on its kept
  sessions;
- `awf logs` on a fixture run prints the same text before and after this task, apart from paths.

### 7. Attempt files, spend, views and scratch

Work:

- The attempt record gains `value` and drops `stages`, `accounting` and `unacknowledged`.
- `awf emit` refuses a returned run by reading the attempt file.
- `spend.json` is written with `link`, by the ending attempt, or by the next attempt's claim for an
  interrupted one.
- Cost is priced at read, so `attempt-view.ts` and `awf runs`' cost move here.
- `out.json` (still with `accounting`, for the lab) and `report.md`.
- `work/` holds `skills/`, `agents/`, `staging/` and `forks/`.

Done when:

- an interrupted attempt's spend is settled by the next claim ([[interrupted-accounting-read]]
  folds in);
- deleting `out.json` and `work/` between attempts changes nothing a continue does;
- `awf run --json` keeps its shape for the lab.

### 8. Readers, site and docs

Work:

- `awf logs` and `awf tick` read waits and sessions from `readRun` and the story from
  `log.jsonl`; `awf runs`' stages moved in task 4, cost in task 7, and wait labels and `waiting`
  in task 5.
- `createRun` writes `format: 1` in place of `RUN_RECORD_VERSION`, and the attempt record's own
  `version` goes, covered by `format`.
- The `logs` cursor spans both files.
- `runs-command.ts`'s `records:` line is updated.
- A run without `format`, or with an unknown one, is listed `unreadable`.
- The docs: the site pages, `runs-and-stages.md`, `docs/status.md`, the lab's `reference.md`, the
  comments and messages in the code map, and 039's line 723.
- The todos this story finished are folded in: `run-record-layout`, and the record parts of
  [[non-answered-evidence]] and [[interrupted-accounting-read]].

Done when:

- `git grep -n -E 'output\.json|calls/\{|turns\.jsonl|mailbox\.jsonl|process\.log|liveness\.jsonl|stages/|replaced/|decisions/\{' -- site packages examples`
  finds no reference to a gone file (each hit read; prose like "tool calls/" is not one);
- the site builds;
- every example test passes (`examples/**/*.test.ts`).

## Verification

Automated, on de1b2c1, 2026-11-05:

- [x] `readRun` table tests; claim and fence tests; op numbering and key tests
- [x] `bun test`: 2665 pass, 2 skip, 4 todo, 0 fail (2671 tests, 202 files)
- [x] `bunx tsc --noEmit`
- [x] `bun run scripts/check-boundaries.ts`, with `engine/src/run-policy` listed
- [x] `bun run check`
- [x] `cd site && bun run build`

Manual or live evaluation, 2026-11-05:

- [x] One live event run per harness, not only codex: codex and pi and cursor headless, claude in
  its TUI. Each: `awf emit` starts it, stage `first` answers, a 20 s timer and a race park it,
  `awf tick` wakes it on the timer, stage `second` answers on the same session (`391`, then
  `400`), then `awf run --continue --from-stage second` reruns only `second` (`409`), its line
  `redo: true`. Read by hand: `run.json` has `format: 1`; `run.jsonl` holds `claimed` per attempt,
  `session`, `stage`, `timer`, `wait`, and the `race` whose `took` names the timer; `in.jsonl` the
  starting event; `attempts/2.json` `kind: "attempt"` and the value; `ops/solver.{1,2,3}/` each with
  `op.json` and an unpriced `spend.json`; one `launches/{launch}.log` per background launch;
  `out.json` a view. About $0.25.
- [x] `awf-lab`'s parse: `tests/review-lab.test.ts` runs `awf run --json` and parses it with the
  lab's own `parseRecord` and `summaryOf`. No live lab run.
- [x] The live suite, `bun run eval`, with every harness: 16 of 21 passed (~$3.37). The five that
  failed (`calling-session`, `compaction`, `effort`, `fan-out`, `fork`) were rerun alone, and run
  on f626de4, the commit before this story: all five fail there too, the same way (pi and cursor
  TUI agents timing out, claude prompt delivery unconfirmed or blocked, no `--here` run record
  for claude and cursor). One failure was this story's: task 2's key mapping gave
  `claude>headless` and `claude-headless` the same key in `examples/fork`; de1b2c1 fixes it, and
  the fork eval then opens and forks every case, failing only where f626de4 fails (cursor TUI
  forks timing out) and on pi's cache share, 0.49 under its threshold.

## Review record

### Refinement, 2026-11-04

Round 1, two read-only reviewers:

- **Architecture and scope.** Fixed:
  - task 1 changed types older code still used until tasks 6 and 7: each existing type now
    changes in the task that moves it;
  - `earlier` was declared in task 1 but wired in task 8: it is now wired in tasks 4 and 5, and Q3
    asks about the beta;
  - the dependency on 039's task 10 was unstated: task 5 now names it;
  - task 4 wrote `state`, which nothing produces: dropped;
  - task 3's fence test needed task 4's reader: task 3 now proves it through `readRun`;
  - `via` clashed with 040's `source`: the design and story now say `source`;
  - nits: unmapped "Who changes" rows, `RunRecord.version`, provable Done-when items, and a grep
    matching the scope.
- **Code facts.** Fixed:
  - colon keys are deprecated, not refused, and refusing them is 039's task 10, with its cost
    grouping decision;
  - `runs-and-stages.md` is under `docs/design`;
  - missed callers and paths: message operations' ids, `workflow-runner.ts:633`,
    `run-view.ts:199`, `testing/operation-events.ts`, `inbox-command.ts:708`, `agentswf`'s
    typecheck, the codex home set by the engine, and the `liveness.jsonl` rename;
  - a dead wiki link;
  - a test that killed a process, now done at the file level.

Round 2, one reviewer on both lenses. Fixed:
- task 2 refused colon keys before 039's task 10 does: tasks 2 and 5 now wait for it, and
  `depends_on` says so;
- task 5 moved the wait lines while their readers moved only in tasks 7 and 8: `wake`'s readiness,
  `waiting`, `unacknowledged` and the wait labels now move in task 5;
- no task wrote `format`: task 8 does, and it retires the attempt record's `version`;
- a failed start's op folder was missing from task 2;
- nits: line numbers, unmapped comments and messages, the grep, the policy module's task,
  `spend.json`'s and cost's tasks, and `writer#2` naming.

Round 3, one reviewer on both lenses. Fixed, all in task 4:
- round 2's keeping `sessionsOf` until task 6 was wrong: nothing in production reads a stage's
  sessions, so it goes in task 4 with `StageRecord`;
- its tests can't pass "unchanged": they keep their outcomes, asserted against the stage line;
- its `awf runs --json` check needed task 8's reader: `awf runs`' stages move in task 4.

Round 4, one reviewer on both lenses. Fixed, all in task 4:
- `awf runs`' stages can't come from `readRun` alone, which has no running or reused stage: ended
  stages take `last` from it, the rest stay on the log, as the design says;
- `TestRun.stages` as stage lines broke example tests and two site pages: they are mapped and
  follow in task 4;
- `StageRecord`'s other users are mapped.

Round 5, one reviewer on both lenses. Fixed:
- round 4 had `TestRun.stages` drop reused stages, which today are present (`stage-ledger.ts:346`,
  `run-test.ts:672`) and which three example tests assert: it now holds each stage the attempt
  entered, a reused one by the line it reused, in the order entered; the design's "Who changes" row
  says the same;
- `awf runs` takes `last` only when it is this attempt's line;
- `awf runs --json`'s `value` was listed in task 8 as well as task 4.

Round 6, one reviewer on both lenses. Fixed:
- a reused stage showed no `value` in `awf runs --json`: it takes `value` and `attempt` from
  `readRun`'s `settled`; a settled stage the attempt never entered is `readRun`'s to show, and the
  design's reader table now says `awf runs --json` shows the latest attempt's stages;
- nits: a provided stage's line, and every example test rather than `workflow.test.ts` only.

Round 7, one reviewer on both lenses. Fixed:
- an ended entry took `readRun`'s single `last`, wrong for a stage an event run enters twice in one
  attempt: each entry now takes the k-th line of its name from this attempt, and the Done-when tests
  that case;
- nits: `RunJson.stages` gains `value` only, and the design's "Who changes" row keeps the current
  stage on the log.

Round 8, one reviewer on both lenses. Fixed:
- the design's "The rules" said a stage writes once per attempt, and that `awf runs` shows `last`:
  both now say what task 4 does, and `readRun` publishes a stage's history;
- nits: an entry is paired with its line by `started`, not by counting log lines, which are best
  effort; `RunJson.stages` is in the code map; a line number.

Round 9, one reviewer on both lenses: clean. The pairing by `started` holds, since both records take
one clock read. Its nits are applied: the one clock read is a stated constraint, ties go by the
order entered, and a long line is wrapped.

## Readiness

- [x] Outcome and boundaries are concrete.
- [x] Relevant implementation, callers, and tests are mapped.
- [x] Evidence and research support the proposed design.
- [ ] Expensive interface, record-format, and stage-gate decisions are settled (Q1, Q3, Q4).
- [ ] Tasks are ordered, coherent, and independently verifiable (Q2).
- [ ] Open questions are resolved or explicitly moved out of scope.

## Implementation notes

### Decisions at the start, 2026-11-04

Implementation was asked for with Q1–Q4 open. Taken as follows, each reversible before the story
ends:

- **Q1.** The design is accepted as written.
- **Q2.** One story.
- **Q3.** No beta is cut mid-story; whether 039's beta waits for tasks 4 and 5 stays the human's.
- **Q4.** `returns` and the first-wait rule stay as built.
- Tasks 2 and 5 wait for 039's task 10, so the order is 1, 3, 4, 6, 7, then 2 and 5, then 8. Task
  3 lists `ops/` and task 5 moves turn recovery into the claim when they land.
- **2026-11-05: task 2 no longer waits for 039's task 10**, which waits on a beta. An agent's or
  decision's key must pass `nameProblem`, except that a colon stays allowed, and deprecated (the
  `colon-key` warning), until 039's task 10 refuses it: `triage:42.1` is a valid folder on macOS
  and Linux. So task 2 runs before 7; task 5 still waits.
- **2026-11-05: task 5 no longer waits for 039's task 10 either.** The waits move to `in.jsonl` and
  `run.jsonl` now; `awf send --event-id`, which gates on the log (`holder-command.ts:251`), is
  untouched by this task and stays for 039's task 10 to remove.

### Task 1

- **Module.** The line types, `Taken`, `Saved`, `EventLine` and `RUN_FORMAT` are in `records.ts`;
  `readRun(lines)` is `packages/contract/src/run-lines.ts`, re-exported from `records.ts`, so it is
  in `@agentswf/contract` and `@agentswf/contract/records`. Tests: `run-lines.test.ts`, 54 cases.
- **Result type.** `RunView`: `stages` (per name `{ last, settled?, history }`), `redo?` (`{ attempt,
  stage }`), `races` (latest line per name), `timers` (latest line per name plus `taken`), `state`
  (latest value per name), `wait?` (the latest `wait` line), `sessions` (`{ latest, all }`) and
  `fenced`, a diagnostic count of lines the fence dropped. Records are null-prototype objects.
- **A taken timer carries its name.** `Taken` gains `timer?: string`, set by the engine when a wait
  or race takes a timer, as `branch` and `due` say what a time read from state was; `readRun`
  matches a timer by it, and derives no id. `docs/design/run-record.md`'s `Taken` and its timer
  rule say so.
- **Settled is the latest `succeeded` line.** The engine writes a provided stage as `succeeded`
  with `provided: true` (`stage-ledger.ts`), so `provided` needs no clause of its own, and a
  provided line of another outcome is refused. `records.ts` and the design say so.
- **Refusals** throw `run.jsonl line {n}: …`, `{n}` counting the lines given from 1, for a line
  that: isn't an object; has no `kind`, or an unknown one; has no positive integer `attempt`, or
  no `at`; lacks a string field the view indexes by or returns (stage `name`, `outcome`,
  `started`; race `name`, `branch`; timer `name`, `due`, `when`; session `agent`, `harness`,
  `session`); has an optional field it returns of the wrong type (stage `reason`, `summary`; wait
  `label`, `stage`, `race`, `acks` as strings, `takes` as an array; took `stage`; session
  `operation`, `home`); has a stage `outcome` outside `StageOutcome`; has `provided`, `redo`,
  `cancelled` or `returns` other than `true`, or `provided` on an outcome but `succeeded`; has a
  `took` that isn't an array of objects with a string `id` (string `timer`, `branch`, `due` when
  present; an `awf.timer.` id with its `timer`, an `awf.at.` id with its `branch` and `due`); or
  has a `state` entry without a string `name` and an own `value`. A fenced line is checked too.
- **Deviations from the design.** `turn-ended.end` is contract's `AgentEnded` (`{ turn, meta,
  outcome }`): `TurnEnd` is the engine's own, in `mailbox.ts`. `format` and `args` on `RunRecord`
  are optional and `version` stays until task 8. `turn-started` and `turn-ended` are checked but not
  in the view: "What is published" doesn't list them. Every type in `records.ts` that is a run
  file's content, or part of one, names its tier; `MailboxRecord` and `StageRecord` are marked
  retired by this story. The CLI's JSON documents carry none.
- **ADRs.** 0014 added and indexed; 0011's "Persistence" amended.
- **Review.** Two subagent reviews of the diff, all findings accepted:
  - architecture: `readRun`'s `timerId` parameter pushed a hash onto every reader; replaced by
    `Taken.timer`, the design amended. Tiers were missing on the types inside a record; added.
    `MailboxRecord` and `StageRecord` read as stable; marked retired. `fenced` is diagnostic;
    commented so.
  - correctness: an unknown stage `outcome`, a flag not `true`, a malformed `took` entry, a state
    entry without `value`, and a returned field missing (`session`, `harness`, `branch`, `when`,
    `started`) were accepted; each is refused now. The `|| provided` clause matched nothing the
    engine writes; dropped with its test. Tests added: an out-of-order claim, a state surviving a
    later attempt's stateless wait, `taken: false` and `fenced` each beside the opposite value.
  - round 2: `provided` on an outcome other than `succeeded`, an `awf.timer.` entry without its
    `timer`, an `awf.at.` entry without its `branch` and `due`, and a returned optional field of
    the wrong type were accepted; each is refused now. The stage line's comment in `records.ts`
    and the design's two settled rules now say only `succeeded` settles. Tests added: a fenced
    `took`, `race` and `redo` count for nothing. The refusal reads "without a positive attempt";
    `RunLineKind` is no longer exported.
  - round 3: clean.
- **Verification**, in the worktree, after review round 3: the whole `bun test` 2632 pass, 2 skip,
  4 todo, 0 fail (2638 tests); `bun run check` clean but for the existing Biome info;
  `workflow-runner.test.ts` 10 runs, 9 clean, 1 failing the test above. After review round 2: `bun test packages/contract` 103 pass, 0
  fail; `bunx tsc --noEmit` clean; `bun run scripts/check-boundaries.ts` "boundaries ok"; `bunx
  biome check packages/contract` clean; the whole `bun test` 2585 pass, 2 skip, 4 todo, 0 fail.

### Task 3

- **Module.** `packages/engine/src/run-lines.ts` owns `run.jsonl`: the only code that writes it.
  `claimRunLines(runDir, attempt, at)` cuts the file to its last newline (reading backwards from
  the end, creating it when absent), fsyncs the run folder, appends `claimed` and returns the
  attempt's writer, `RunLines`: `{ attempt; append(line: RunLine) }`. Only a claim makes one, so
  nothing appends before the fence. `append` refuses a line of another attempt; lines are queued by
  the file's resolved path, so they land in call order however the folder is spelled. Each line is
  one write to a file opened `O_APPEND`, then fsync, then close: the file is opened per line, not
  held, so the writer has no lifetime to end. A write that fails part way is cut back to the size
  before it, when the file ends with that write's bytes, so the next line isn't glued to its half. `readRunLines(runDir)` parses each complete
  line, ignores text after the last newline (torn, or still being written, which the next claim
  cuts), refuses a complete line that isn't JSON (`run.jsonl line {n}: not JSON`), and returns `{
  lines, view }`: `readRun`'s check of every line, and its view.
- **The writer is on the attempt.** `runs.ts`'s `Attempt` is `AttemptFile & { lines: RunLines }`;
  `AttemptFile` (`{ run, file, record }`) is what `claimAttempt` returns and what `endAttempt` and
  `discardRun` take. `claimNext` returns the `Attempt`, so tasks 4–6 append through
  `attempt.lines`, which the claim produced.
- **The claim** (`run-prepare.ts`, `claimNext`): `claimAttempt`, then `previousGone` for every
  run, then `claimRunLines`, then today's `attempt-started` event as before. A claim whose
  `run.jsonl` write fails unlinks its attempt file and refuses, as a refused claim does.
- **`previousGone` skips an attempt of this process.** Waiting for every run made an in-process
  continue (`run-panes.test.ts`, a workflow's tests) wait five minutes for itself and then
  `SIGTERM` itself. An attempt whose `pid` is this process's has ended, since `attemptRefusal`
  refuses a live one. Known, unchanged: an in-process attempt that ended but is still closing its
  agents isn't waited for, so a continue in the same process could overlap its close.
- **Folders.** `files.ts`'s `syncDir(dir)` opens the folder and fsyncs it. `claimRun` syncs the
  `.new-*` folder after `run.json` and before the rename, and the parent after it; `claimAttempt`
  syncs `attempts/` after its `link`, before it reads the others; the claim syncs the run folder
  for `run.jsonl`'s entry. The parent's sync after the rename is best-effort: the run is in place
  and this call holds its id, so a failed sync must not refuse it and strand the id. Only a machine
  crash could then lose the folder's entry.
- **fsync, not `F_FULLFSYNC`**, until Q5 says otherwise; Q5 has the measurements. The design's
  "Whole lines, durably" says so.
- **Known edge.** A process thought killed that finishes a short-written line after a claim cut its
  start leaves a complete line that isn't JSON after the `claimed`. `readRunLines` refuses it, and
  the run is unreadable until it is removed by hand. Telling it from corruption would mean guessing
  at a line no attempt is known to have written; a short write on a local file is near impossible
  outside a full disk. The design's "The fence" says so.
- **Not done here.** Listing `ops/` moves into the claim with task 2, which waits for 039's task
  10: `ops/` doesn't exist yet. Turn recovery moves into the claim with task 5. Nothing else
  writes `run.jsonl` yet; `stages/`, the mailbox and the log write as before.
- **Tests**, `packages/engine/src/run-lines.test.ts`, 12, all at the file level: a claim creates
  the file; a torn last line is cut, not merged (the file is byte-for-byte the whole lines, then
  `claimed`); a torn tail of 200 KB, past the 64 KiB read-back chunk, is cut whole; a file holding
  only a torn line is emptied; a fake attempt 1 appending after attempt 2's `claimed` is fenced
  (`view.fenced` 1, its stage absent); concurrent appends keep call order; a writer refuses another
  attempt's line; two spellings of a folder are one file; a missing file reads empty; a trailing
  partial line is not read; a complete non-JSON line is refused; and a run without events waits in
  `claimNext` for its previous attempt's process (a `sleep 0.4` recorded as a failed attempt 1:
  `claimNext` resolves no earlier than the process's exit, `run.jsonl` holds attempt 2's `claimed`,
  and `attempt.lines` appends attempt 2's lines). That last test fails with the old `if
  (run.record.events)` guard put back. A write failing part way is not tested: it needs a fault
  injected into the file handle.
- **Review.** Subagent review of the diff, round 1; all findings accepted:
  - the writer was reachable without a claim (`runLines` exported) and not threaded: it is now
    module-private, and `claimNext` returns it as `attempt.lines`. The queue was keyed by the path as
    spelled; it is the resolved path now.
  - the non-event wait test asserted a wall-clock threshold; it now asserts `claimNext` resolved at
    or after the previous process's exit.
  - `run-panes.test.ts` faked the parked attempt's `processStart` so the continue wouldn't wait for
    this process; redundant with the same-process skip, removed.
  - `F_FULLFSYNC` was decided inside the task: raised as Q5, and the design says plain `fsync` until
    it settles.
  - nits: a torn tail past 64 KiB is tested; `createRun` no longer fails with the run already in
    place when the parent's sync fails; the non-JSON line a late short write can leave is a recorded
    edge, refused, in the design and here; the in-process "still closing" risk is recorded. Beyond
    the findings: an append that fails part way is cut back, so the writer can't make a non-JSON line
    itself.
  - round 2: clean, two nits applied. The cut-back on a failed append truncates only when the file
    is exactly its size before the write plus this write's bytes, so a stale writer can never cut a
    later attempt's `claimed`; the design's "Whole lines, durably" is rewrapped. After them: `bun
    test packages/engine/src/run-lines.test.ts` 12 pass, 0 fail; `bunx tsc --noEmit` clean; `bunx
    biome check` on `run-lines.ts` clean.
- **Review, round 2.** Clean. Nits applied: `flushed()` tries once more any session a failed
  write dropped and nothing has seen since, so a failure during close gets a second try, and a
  second failure stays a warning (two `session-lines.test.ts` cases); `data.md` says a wake
  reopens an agent on its latest session where it can be (skills, a sandbox or another harness
  start it anew), names `sandbox` and `domains` on `agent-opened`, and its log paragraph is
  rewrapped. After them: `session-lines.test.ts` 4 pass, 0 fail; the whole `bun test` 2624 pass,
  2 skip, 4 todo, 0 fail (2630 tests, 199 files); `bun run check` clean but for the existing Biome
  info; the site builds, every link resolving.
- **Verification**, in the worktree, after review round 1: `bun test
  packages/engine/src/run-lines.test.ts packages/engine/src/run-panes.test.ts
  packages/engine/src/runs.test.ts packages/engine/src/inbox-command.test.ts` 55 pass, 0 fail;
  `bunx tsc --noEmit` clean; `bun run scripts/check-boundaries.ts` "boundaries ok"; `bunx biome check
  packages/engine packages/contract` clean (217 files); the whole `bun test` 2597 pass, 2 skip, 4 todo, 0 fail (2603 tests, 197 files).

### Task 4

- **The policy module** is `packages/engine/src/run-policy/`, checked by `check-boundaries` as
  `engine/src/accounting` is: pure, contract only. It holds `stages.ts`, reuse, and `stage-plan.ts`,
  the stage plan, moved in whole (it was already pure). The waits, the held batch and turn ends go
  beside them in later tasks.

  ```ts
  type StageRedo = { stage: string; attempt: number };
  class StageReuse {
    constructor(view: Pick<RunView, "stages" | "redo">, attempt: number);
    /** The line `name` stands for as entered now, of any outcome; undefined when none, or outdated by the redo. */
    enter(name: string): StageLine | undefined;
    /** This attempt starts at `name`: a later stage with an older line runs again. */
    redoFrom(name: string): void;
    /** A line this attempt wrote, which later entries see. */
    wrote(line: StageLine): void;
  }
  /** Each stage's latest line, in the order they started: what a stage not reached names. */
  function recordedStages(view: Pick<RunView, "stages">): StageLine[];
  /** Those a continue may still come to: none the redo's attempt left behind, by its attempt file. */
  function upcomingStages(view: Pick<RunView, "stages" | "redo">, redoEntered?: readonly string[]): StageLine[];
  /** The `--from-stage` of a last attempt with no ending that wrote no line for its stage. */
  function crashedRedo(attempts: readonly Pick<AttemptRecord, "attempt" | "ended" | "flags">[], view: Pick<RunView, "stages">): string | undefined;
  ```

  The stage plan decides from the line `StageReuse.enter` gives, as it did from
  `stages/{stage}.json`: `StagePlanState` takes `line`, `lineVersion` and the names `recorded`, in
  place of `records`, and a reuse carries its `line`. `lastRedo` is gone: the redo is `readRun`'s.
- **`StageLine`** is defined in contract's `run-lines.ts`, used there for every stage line, and
  re-exported from `records.ts`, tier public, stable: `TestRun.stages`' type, "a new type" as the
  design's table says.
- **The writer is threaded** through `RunWorkflowOptions.run.lines`, which replaces `run.attempt`:
  the attempt is `lines.attempt`. `operator-cli.ts` passes `claimNext`'s `attempt.lines`; every test
  entry claims its own (`runAttempt`, `startNew`, `runTest`, and `testing.ts`'s `claimLines`).
  `StageLedger` takes `lines`, `run` (`readRunLines`' view as the attempt began), `versions` and
  `redoEntered`, and no longer `runDir`, `attempt`, `records`, `redo` or `turns`. A ran stage's line
  is `{ name, outcome, reason?, started, summary?, value?, redo? }`, `started` the one clock read the
  log's `stage-started` carries and `at` its end; a provided one is `succeeded` with `provided`,
  `started` and `at` its entry.
- **The reuse rule.** A stage stands for its latest line, as `stages/{stage}.json` held the latest
  record, and is reused only when that line succeeded: a continue reuses `settled` only when it is
  also `last`, so a stage rerun after a redo that then failed runs again on the next wake, as 039
  built it. After the redo's stage, a line older than the redo stands for nothing.
- **Decision for human review: `redo` means the stage the attempt started at.** It is written on
  every start point: the stage `--from-stage` named, or a plain run's first stage not reused. That
  is what `replaceStale` did at any start point: in a run where b's failure was caught, c succeeded
  and d failed, a continue starts at b and dies in c, and the next continue must not reuse attempt
  1's c. The design ("Its lines", "The rules", "Redo", "What is published", "Reading it") and
  `records.ts`' field comment say so. A plain run's first attempt writes `redo` on its first stage.
- **A crash inside a plain run's `--from-stage` stage** writes no line, so `prepareRun` restores
  018's promise: when the last attempt has no ending (its process gone, which the refusal already
  checked), has `flags.fromStage` S, and wrote no line for S, the continue runs as `--from-stage S`
  and says so (`awf: attempt {n} of {id} ended without an ending inside --from-stage {S}; this
  attempt starts there again`; `crashedRedo`; `PreparedRun.resumes`, which `loadAndPrepare` puts on
  the command). The resumed attempt carries no `--values`: the attempt file doesn't keep them, so a
  stage before S with no line to reuse stops for its value, and the go-on names `--values`. An
  event run's wakes carry no flag, so there the redo is lost, as the design's "Redo" now says for
  both kinds of run.
- **Removed stages.** A completed run's refusal offers the stages its completed attempt entered (its
  attempt file's `stages`), each by its latest line; without them, every recorded stage.
  `progress().upcoming` leaves out a stage whose latest line is older than the redo's attempt and
  which that attempt never entered (its attempt file's `stages`); with no such list, as after a
  crash, it leaves out none. A stage reused before the redo's stage keeps an older line, so the line
  alone can't tell it from a removed one: hence the attempt file. "Recorded and not reached" still
  names every stage with a line. The two attempt-file reads move with task 7, which drops
  `stages` from it.
- **Deviations.**
  - *The version a line was written under* is its attempt's `workflowVersion`, read from
    `attempts/{n}.json`: the stage line has no version field, and the attempt's is the one the old
    record copied. `runAttempt` (`testing.ts`) writes an ended attempt file for this.
  - *`awf runs`* reads `run.jsonl` and, when it doesn't parse, shows the stages from the log and
    one line, `awf: run.jsonl could not be read, so stages show no values: {why}`; `--json` has no
    values then. There is no `format` to check yet (task 8). Values are masked as reasons are.
  - *Messages* say a stage's "line" where they said its "record" (`'s line no longer fits its
    result schema`); `docs/design/runs-and-stages.md`'s table follows.
  - Not touched here: `site/guide/durability.md`, `site/reference/data.md` and
    `site/reference/workflow-api.md:708` still name `stages/` and `replaced/`; task 8 owns them.
    Those pages must say that a plain run's first stage line carries `redo` (every start point
    does), and that an attempt resumed after a crash inside its `--from-stage` stage doesn't carry
    `--values`.
- **`awf runs`' stage list** (`run-view.ts`): an end pairs with the latest running entry of its
  name; a ran or provided entry takes its outcome (a provided one stays `provided`), value, and its
  end when the log lost it, from this attempt's line with its name and `started`, each line used
  once, in order; a reused entry takes `settled`'s value, which for the latest attempt is the line
  it reused; a running or plan-stopped entry keeps the log's. `RunJson.stages` gains `value`.
  `TestRun.stages` reads the run's summaries, which hold one entry per stage name, so a stage by
  content that failed and ran again in one attempt is one entry, its latest line.
- **Tests added:** `run-policy/stages.test.ts`; in `stage-ledger.test.ts`, a line's `started` is the
  clock read `stage-started` logs, failed then succeeded keeps both lines with `last` the success,
  another major version stops by its attempt's version, a fenced line isn't reused, a plain run's
  redo carries to a later continue, every start point is a redo (the caught-failure case), and a
  by-content `--from-stage` stage that fails and runs again writes `redo` once; the in-memory writer
  refuses another attempt's line. `runs-command.test.ts`: two entries of one stage in an attempt,
  ties by order, a provided entry, masking, and an unreadable `run.jsonl`. `continue.test.ts`: 018's
  "after a crash mid-stage, a continue starts at that stage" restored with its outcome, and a crash
  past the redo's stage. `runs.test.ts`: a completed run's choices leave a removed stage out.
  `tests/operator-cli.test.ts`: a continue after a `--from-stage` that died inside its stage starts
  there and says so; its three stage tests read `run.jsonl` where they read `stages/` and
  `replaced/`. Removed with what they tested: the stage-ledger's session test, the "start point
  can't move" test and `runs.test.ts`' `replaceStale` test.
- **Review, round 1.**
  - correctness: nothing material.
  - architecture, three regressions for plain runs, all accepted: an implicit start point outdated
    nothing (now every start point writes `redo`); a crash inside a `--from-stage` stage lost the
    redo (now `crashedRedo`); removed stages stayed in the refusal's choices and in `upcoming` (now
    from the attempt file). Also accepted: design text that a continue reuses `settled` only when it
    is `last`; `awf runs` saying when values are omitted; `stage-plan.ts` moved into `run-policy/`;
    `StageLine` defined once in `run-lines.ts`; `run.attempt` derived from `run.lines`, its
    reconciling check dropped.
  - nits, all applied: `StageReuse` keeps a map of latest lines; `run-test.ts`' one-entry-per-stage
    reading documented; the reused value documented as the latest attempt's; "line" in the plan's
    messages; the `runs-command` tests above; `awf runs` takes a lost end from the line; the
    by-content redo-once test; the in-memory writer's attempt check; `runTest` cleans its temp dirs
    if writing the earlier attempt fails.
- **Review, round 2.** Clean on both lenses. Nits applied: a test that the runner passes
  `redoEntered` (`tests/run-progress.test.ts`: a stage the last redo's attempt never entered isn't
  upcoming; it fails with the option dropped); the resumed attempt's notice reworded; the
  operator-cli crash test asserts the outcome through `prepareRun` (implement and qa rerun in
  attempt 3, which is the redo); task 8's two page notes above.
  After them: focused (`run-policy`, `stage-ledger`, `continue`, `runs-command`,
  `tests/operator-cli`, `tests/run-progress`) 230 pass, 0 fail; `bun run check` clean but for the
  existing Biome info; the whole `bun test` 2616 pass, 2 skip, 4 todo, 0 fail (2622 tests).
- **Review, round 2.** Clean. Nits applied: `flushed()` tries once more any session a failed
  write dropped and nothing has seen since, so a failure during close gets a second try, and a
  second failure stays a warning (two `session-lines.test.ts` cases); `data.md` says a wake
  reopens an agent on its latest session where it can be (skills, a sandbox or another harness
  start it anew), names `sandbox` and `domains` on `agent-opened`, and its log paragraph is
  rewrapped. After them: `session-lines.test.ts` 4 pass, 0 fail; the whole `bun test` 2624 pass,
  2 skip, 4 todo, 0 fail (2630 tests, 199 files); `bun run check` clean but for the existing Biome
  info; the site builds, every link resolving.
- **Verification**, in the worktree, after review round 1: focused (`run-policy`, `stage-ledger`,
  `continue`, `stages`, `receive`, `runs-command`, `runs`, `emit-e2e`, `tests/operator-cli`,
  `tests/run-progress`) 310 pass, 0 fail; `bun test examples` 179 pass, 4 todo, 0 fail; `bun run
  check` clean (Biome, `tsc --noEmit`, "boundaries ok"), but for an existing Biome info in
  `experiments/e9-messaging-protocol`; the whole `bun test` 2615 pass, 2 skip, 4 todo, 0 fail (2621
  tests, 198 files).

### Task 6

- **Sessions are `run.jsonl`'s.** `engine/src/session-lines.ts`, `SessionLines`, writes an
  attempt's `session` lines through its writer, `run.lines`:

  ```ts
  class SessionLines {
    constructor(options: { lines: RunLines; failed(message: string): void });
    /** `operation`: the operation they were seen in; `home`: a sandboxed agent's own. */
    known(agent: string, sessions: readonly NativeSessionRef[], fields?: { operation?: string; home?: string }): void;
    /** Once every line asked for is written, or has failed. */
    flushed(): Promise<void>;
  }
  ```

  A session is written once per agent per attempt, the first time the attempt sees it, so a later
  attempt writes the sessions it resumes again. It is called where the log named sessions until
  now: an operation's delivery and failure (its agent's sessions as of then, `operation` its id),
  a session the harness names mid-operation, a turn's or compaction's settling, and a fork's
  opening (no `operation`); and, after review, an agent's `wfa` reporting one, and every agent's
  sessions once the owner has closed them. A line that fails to write is a warning, and it is
  tried again when the session is next seen; meanwhile a continue reopens the agent on its last
  session recorded, or anew if none was. The run awaits `flushed()` after the close-time sweep,
  before its stage lines close and the attempt ends.
- **The writer while closing.** `RunLines` has no lifetime: it opens `run.jsonl` per line and
  refuses only another attempt's line, so a `session` line an agent's close produces after the
  attempt's ending is still appended, until the next claim's fence. Nothing else changed in it.
- **Resuming** reads `readRun`'s `sessions.latest`, each agent's latest line, from the view the
  attempt reads as it starts (after its claim): `keptSessionsOf(view.sessions)`, never the log.
  Before, it was the last session on each root agent's last turn line; the two differ only where an
  agent's newest-seen session isn't last in `reportedSessions`' order (launcher reports, then the
  harness's), and the newest seen is the one it moved to. `callPath` isn't on a `session` line:
  `wf.call` is unbuilt.
- **The log is `log.jsonl`** (`runs.ts` `logFile`; `endTurnsLine` is `endLogLine`). Its types:
  `session-known` and `TURN_OPERATION_FIELDS`' `sessions` go, so turn, compaction,
  `operation-started` and `operation-failed` lines carry none; new, `sandbox-opened`
  (`{ kind } & SandboxRecord`); `agent-opened` gains `skills` (`Pick<AgentSkillsRecord, "skills" |
  "home">`) and `pane` (`Omit<AgentPaneRecord, "callPath" | "agent">`); `agent-stopped` gains
  `kept` and `notKept`, read from the session's `pane()` once its close settled; `decision-asked`
  and `decision-ended` gain `operation`. After review, `agent-opened` also gains `sandbox` (the key
  it was admitted to) and `domains` (its harness's model domains), so the log alone says what
  `output.json`'s `sandboxes` do.
- **Readers.** `run-read.ts` numbers native sessions from `run.jsonl`'s `session` lines, in order,
  each with its line's agent (and `home`, used when the log lost the agent's opening); the agents'
  operations and windows still come from the log. `awf runs`' agent sessions read it through
  `run-read.ts`. When `run.jsonl` can't be read, `awf logs` still reads the log and says `note:
  run.jsonl could not be read, so no agent's activity shows: {why}`. The interrupted-in-stage notice
  reads `log.jsonl` (`readTurns`). Accounting reads no session from any file: the ledger counts
  each agent's sessions in the process, and `output.json`'s `usage[].sessions` is unchanged, so
  accounting's results are identical by construction. No reader yet needs an operation's own
  sessions from the record; the design's rule (the agent's line current at the operation's start,
  plus every line naming it) is what such a reader computes.
- **Turn recovery** (`recoverTurns`) reads the mailbox, not the log, so deleting `log.jsonl` doesn't
  touch it; it moves into the claim with task 5.
- **Deviations, for review.**
  - *A decision's `operation` is a UUID* minted as it is asked, the scheme turns use today; task 2
    makes it `{decision}.{n}`.
  - *`sandbox-opened` is the record as the sandbox opened*: `agents` empty and `domains` the
    spec's `network`. Each admitted agent's `agent-opened` carries its `home`, `sandbox` and
    `domains`, which together give the record.
  - *No version changed*: `RUN_EVENT_VERSIONS` and `TURN_RECORD_VERSION` keep their numbers for
    the kinds whose shape changed (`sessions` removed; `skills`, `pane`, `kept`, `notKept` and
    `operation` added), since task 8's `format` makes a run before this story `unreadable`.
    `awf logs --json` stops carrying `sessions` and `session-known` events at `v: 1`.
  - *`awf logs` no longer prints a session line*: a fork's `session-known` line was shown as
    `@e{n} … {agent}  session {harness} {id}`, and the handles after it were one higher. Its
    `session` line is in `run.jsonl`, which task 8's cursor spans.
- **Event runs parked before this change** have no `session` lines, so their agents start new
  sessions at the next wake. No compatibility is kept (beta).
- **Left for task 8**, naming `turns.jsonl` or `session-known`: `docs/design/runs-and-stages.md` (`:190`, `:208`, `:242-244`,
  `:472`); `docs/design/messaging.md:829`; `docs/status.md:33`; ADR 0012's context line
  (`docs/adr/0012-a-kept-session-and-its-window.md:11`, a continue reopens from `turns.jsonl`).
  Stories and findings record history and stay. `awf logs` showing `session` lines, with handles
  over both files, is task 8's cursor.
- **Tests.**
  - `receive.test.ts`: an event run whose turn names its session parks; `log.jsonl` is deleted; the
    continue opens the agent on its `session` line (`activations[0].continues`). It fails with
    `keptSessions` emptied, as reading the deleted log would leave it. `keptSessionsOf` is tested
    over `readRun`: the latest line per agent, a fenced line ignored.
  - `logs-command.test.ts`: a fake-harness run of two attempts (stages, turns, a compaction, a
    fork, a session named mid-turn, a log line, a `--from-stage` continue). Its `awf logs` text was
    captured from the engine before this task and is asserted after it: the same text, times and
    the fork's id masked, but for the fork's session line and the handles after it, which the test
    derives. `awf runs --json`'s agent sessions are the same as before (`named-session`,
    `fake-named`, in that order); `run.jsonl` holds each attempt's lines. Every existing `awf logs`
    and `run-read` test keeps its expected text with its sessions moved to `run.jsonl` lines
    (`run-read.test.ts`'s `writeLog` writes a line's `sessions` as `session` lines). New: a session
    named mid-turn reads its activity under `--agent`; an unreadable `run.jsonl` is said once and
    the log still reads.
  - `run-event-log.test.ts`: no log line has `sessions`; a fork's and a worker's `session` lines,
    the worker's naming its first operation; a session named mid-turn names its operation; a
    decision's two lines share `operation`; `agent-opened` carries `skills`.
  - `sandboxes.test.ts`: `sandbox-opened` is the run sandbox's record as opened, and each
    `agent-opened` names its home. `workflow-runner.test.ts`: `agent-opened` carries the pane as
    written and placed, `agent-stopped` `kept`.
- **Review, round 1.** Two reviews; all findings accepted.
  - A session that moved at close, or that the agent reported after its last turn, was never
    recorded, so a continue resumed an older one: the owner now records every agent's sessions
    once it has closed them, before `flushed()`, and a `wfa` session report is recorded as it
    arrives (`launcherReported`, filtered through `reportedSessions` as accounting is). The
    ledger's read at settle (`run-usage.ts`) learns no session the close-time sweep misses: it
    reads the same `reportedSessions`. Test (`receive.test.ts`): a session the agent reports after
    its turn settled is the one the continue resumes; it fails with both paths removed.
  - A failed session write was never retried: it, and every session written after it for that
    agent, is now dropped from the written set, so the next sighting writes them again in order
    and the latest line stays the newest. The doc comment and this note say what a continue does
    meanwhile. Tests (`session-lines.test.ts`): once per attempt with `operation` and `home`; a
    failure is warned of and retried in order.
  - `agent-opened` lacked what a sandbox's record says of its agents: `sandbox` and `domains`
    added (`RunSandboxes.admitted`). Test (`sandboxes.test.ts`): the openings' homes and sandbox
    match the record's agents, and network plus their domains is the record's `domains`.
  - The site described `stages/`, `replaced/` and `turns.jsonl`, and is deployed from main:
    `site/reference/data.md` (`run.jsonl` with its `claimed`, `stage` and `session` lines, every
    start point a redo; `log.jsonl` without sessions, with `sandbox-opened`),
    `site/guide/durability.md` (old lines stay in `run.jsonl`; a crash inside a `--from-stage`
    stage starts there again, without `--values`) and `site/reference/workflow-api.md`'s
    `--from-stage` paragraph. Task 8 still owns the pages naming files not yet moved (`calls/`,
    `mailbox.jsonl`, `output.json`, `process.log`, `decisions/`): `site/guide/cost.md`,
    `decisions.md`, `following-runs.md`, `harnesses.md`, `how-it-works.md`, `quick-start.md`,
    `runs.md`, `sandboxes.md`, `workflows.md`, `site/reference/configuration.md`, `data.md` and
    `workflow-api.md`.
  - Nits, all applied: `agent-stopped` `notKept` tested; `agent-opened`'s `placed` has no `kept`;
    a session named mid-turn is the worker's only line and is written before its turn settles;
    `continues` pinned to `fake-worker`; a fork's `home` comes from `homeOf`, as every other
    session line's; the note on parked event runs above.
- **Review, round 2.** Clean. Nits applied: `flushed()` tries once more any session a failed
  write dropped and nothing has seen since, so a failure during close gets a second try, and a
  second failure stays a warning (two `session-lines.test.ts` cases); `data.md` says a wake
  reopens an agent on its latest session where it can be (skills, a sandbox or another harness
  start it anew), names `sandbox` and `domains` on `agent-opened`, and its log paragraph is
  rewrapped. After them: `session-lines.test.ts` 4 pass, 0 fail; the whole `bun test` 2624 pass,
  2 skip, 4 todo, 0 fail (2630 tests, 199 files); `bun run check` clean but for the existing Biome
  info; the site builds, every link resolving.
- **Verification**, in the worktree, after review round 1: focused (`session-lines`, `receive`,
  `run-event-log`, `logs-command`, `run-read`, `runs-command`, `sandboxes`, `workflow-runner`,
  `fork`, `run-usage`) 260 pass, 0 fail; the whole `bun test` 2622 pass, 2 skip, 4 todo, 0 fail
  (2628 tests, 199 files); `bun test examples` 179 pass, 4 todo, 0 fail; `bun run check` clean
  (Biome, `tsc --noEmit`, "boundaries ok") but for the existing Biome info in
  `experiments/e9-messaging-protocol`; `cd site && bun run build` passes, every link resolving. The
  live evals that read the log (`tests/coordinator.eval.ts`, `tests/messaging.eval.ts`) follow the
  rename and were not run.

### Task 2

- **Module.** `packages/engine/src/ops.ts` owns `ops/`, as `run-lines.ts` owns `run.jsonl`: the
  paths (`opDir`, `opFile`, `spendFile`, `liveFile`, `screenFile`, `decisionArtifact`), the writers
  and readers moved out of `runs.ts` (`writeCall` is gone; `recordAnswer`/`readAnswers`, were
  `recordCandidate`/`readCandidates`; `writeAcceptedExclusive`, `readAccepted`, `writeScreen`), the
  claim's listing and the numbering:

  ```ts
  type EarlierOps = ReadonlyMap<string, { last: number; of?: "agent" | "decision" }>;
  function listOps(runDir: string): Promise<EarlierOps>;
  function keyProblem(key: string): string | undefined; // nameProblem, a colon allowed
  class OpIds {
    constructor(runDir: string, attempt: number, earlier: EarlierOps);
    claim(key: string, as: "agent" | "decision"): void; // the name rule and the one namespace
    draw(key: string, what: OpStart): { id: string; lost?: string }; // writes ops/{id}/op.json
  }
  ```

  `contract`'s `CallSpec` is gone for `OpRecord`, `op.json`, tier public, stable: `{ id, attempt,
  stage? }` and, by `kind`, a turn's `agent`, `question` and `schema?`; a message's or
  compaction's `agent`; a decision's nothing more, its key being the id's.
- **The listing is the claim's.** `claimNext` lists `ops/` after `previousGone` and before
  `claimRunLines`, so nothing earlier still writes, and a failed listing unlinks the attempt file
  as a failed `run.jsonl` claim does, before any `claimed` line exists. `Attempt` gains `ops`, and
  `RunWorkflowOptions.run.ops` (required) takes it; the test entries (`claimLines`, `runAttempt`,
  `startNew`, `runTest`) list it too. `n` is the digits after a folder's last `.`; whose a key is
  comes from the `kind` of its highest-numbered `op.json` that can be read, walking down, and a key
  with none is in neither namespace.
- **Numbering.** One `OpIds` per attempt, shared by the agents and `RunDecisions`. `draw` is
  synchronous, drawn where the UUID was (a turn's queue body, a compaction's, a message operation's
  start, a decision's `#run`): an await there let a run's close miss an operation that had not yet
  registered its cancellation (`turns.test.ts`' cancel tests hung). A nudge, a continuation within
  an operation, takes no id. `executeSet`'s ledger entry keeps a UUID: a `set` is not an operation
  in the design, writes no folder, and a number for it would be reused by the next attempt.
- **Who writes `op.json`.** Only `draw`, as it draws the id (`mkdirSync`, then `files.ts`'
  `writeWholeSync`: a temp file, fsynced, renamed into place, `0600`), before any log line names
  the operation, so a number is never used again however the operation ends, a crash included. A
  turn's carries its question and its schema (`resultSchema(spec.schema)`); `call.json`'s write by
  the result slot is gone, with its persistence tests. A `lost` write fails the operation: a turn
  as a failed slot opening did (`superviseOperation`'s `unrecorded`: outcome `failed`, the agent
  closed, its usage row settled), a compaction and a message operation by throwing inside their
  failure handling, a decision as `failed`, its `error` naming it beside a lost `decision.json`.
  `decision.json` is written whole (`writeJson`, temp and rename, `0600`). A message operation
  whose message is withdrawn before it opens keeps its folder and `op.json`: numbers may skip.
- **Keys.** `OpIds.claim` is called after `#assertFreeKey` and the "is the calling session"
  refusal for an agent (open, caller, fork), and last in `RunDecisions.#prepare`, so a call refused
  for anything else holds no key. Refusals: `agent key Reviewer is not a name: lowercase letters,
  digits, …`; `triage is a decision's key: agents and decisions share one set of names, as each
  operation's folder is ops/{key}.{n}; an agent takes another key`, and the converse. The colon is
  allowed by checking `key` with each `:` as `-`, so a leading colon is still refused. Participants'
  keys are unchanged: they have no operations.
- **Turn names in tests** stay `"{agent}#{n}"` (`during`, `after`). Their `n` is the agent's nth
  harness turn in the test, a nudge's included and its compactions not (those are `compactionsOf`),
  which `TestTurn.n` and `turnsOf` publish and tests assert; an op's `n` counts each operation
  once, a compaction's included. Making them one would change what `TestTurn.n` means, so they keep
  apart in spelling: `run-test.ts` and `site/reference/testing-api.md` say how they differ. The
  keys `implementer#2` and `reviewer#{n}` (`review-on-event.ts`) became `implementer-2` and
  `reviewer-{n}`.
- **Deviations, for review.**
  - *The lab's keys.* `judge1:codex/gpt-6-sol`, `{by}#fresh`, `key:{id}` and `vote:{id}:{by}`
    hold `/`, `#` or capitals, and a `/` would nest folders. `agentKeyOf` (`lab/src/review/format/
    runtime.ts`) maps anything but a name's characters and `:` to `-` for the agent key; the vote's
    `by` in the lab's records is unchanged. Two names differing only in case or those characters
    map to one key, whose second open with another runtime throws; nothing is overwritten. 039's
    task 10 still owns the lab's colons.
  - *Examples' keys.* `meteredClaude` (`examples/site/guide/harnesses.ts`) is `"metered-claude"`;
    the fork example's `worker-claude>headless+sandbox` keys map `:`, `>` and `+` to `-`.
  - *Log lines.* `awf logs` needed no code change: its `screen:` path comes from `screenFile`, and
    its lines' `operation`/`operationId` are the op id because the engine writes them so.
  - *`spend.json`* has its path (`spendFile`); nothing writes it yet (task 7).
- **Site.** `reference/data.md` lists `ops/{key}.{n}/` with its files and how ids count (anchor
  `#ops`), drops `calls/` and `decisions/`; `guide/decisions.md` names `decision.json`;
  `reference/workflow-api.md` gives the key rule on `open`'s and `decide`'s `key`;
  `reference/testing-api.md` how a test's turn `n` differs from an op's; `guide/parallel-and-loops.md` and
  `patterns/review-on-event.md` the renamed keys. `docs/design/run-record.md`'s "Op ids" says the
  listing follows the previous attempt's end, the folder appears with `op.json`, the colon
  exception, and where a key's kind is read.
- **Tests added.** `ops.test.ts`: two attempts (the second `--from-stage`) number `worker.1`–`.6`
  and `triage.1`–`.2` without reuse, each `op.json` with its attempt, stage and kind, both
  `decision.json` files kept and named by their records, the log's `operationId`s and decision
  `operation`s the same ids; `Reviewer`, `fix tests` and `a/b` refused at open, `Triage` at ask,
  each naming the rule; an agent keyed as an earlier attempt's decision refused, and a decision
  keyed as an open agent; `triage:42` opens and writes `ops/triage:42.1/`; `listOps` on dotted keys,
  `n` past 9, a folder without `op.json` and one not an op. `screen-evidence.test.ts`:
  the existing test at `ops/worker.{1,2}/`, its `op.json` checked, and a failed start (a first turn
  that fails with a screen) keeps `ops/worker.1/screen.txt`. The colon's warning stays covered by
  `deprecations.test.ts`.
- **Review, round 1.** Two reviews; all findings accepted but one, taken by its alternative.
  - An id could be reused when an operation failed before its folder existed or the process died:
    `draw` now writes the folder and `op.json` synchronously as it draws (above). Tests: a turn
    that fails and a decision that fails keep `op.json`, and attempt 2 numbers `worker.2`,
    `triage.2`; a draw that can't write says why and numbers on; the failed start's `op.json`.
  - `listOps` took a key's kind from its last folder only: it walks down to a readable `op.json`.
    Test: `judge.2` without one, `judge.1` a decision's.
  - Test turn names: making `TestTurn.n` the op's `n` would change a published field's meaning
    (nudges are turns there, compactions aren't), so they went back to `{agent}#{n}`, the
    alternative the review allowed; the comment and the site say how they differ.
  - `OpRecord` is a union on `kind`.
  - Nits: key claims moved last; with `draw` synchronous the compaction's and message's awaited
    `op.json` writes and their closing re-checks are gone, so a compaction closed meanwhile ends
    `cancelled` as before, and a decision's loop is `while (true)` again, its attempts counted as
    before; `docs/design/runs-and-stages.md` names `ops/` and `answers.jsonl`; `agentKeyOf`'s
    collisions noted; the `match` comment reads `{index}.{n}`; `data.md` says `op.json` is written
    as the operation starts. Runner-level tests in `messaging-runner.test.ts`: a message
    operation's `op.json` is `kind: "message"` beside the sender's `turn`; a question withdrawn
    while its peer compacts leaves no operation.
  - Round 2, all accepted: a compaction's and a message operation's `lost` draw fails them, and
    `next` is gone (tests: a turn and a compaction in `ops.test.ts`, a message operation in
    `messaging-runner.test.ts`, each failing with `op.json` named); `unused` is gone, so a withdrawn
    message operation keeps its folder and numbers may skip (`data.md`, the design's "Op ids"); a
    turn's `op.json` has one writer, `draw`, schema included, the slot no longer writing it and a
    `lost` draw failing the turn as a failed slot opening did; `writeWholeSync` is in `files.ts`,
    fsynced. A schema `resultSchema` refuses is left out of the drawn `op.json`, so the turn still
    throws under its id and is written as failed (`run-event-log.test.ts`).
  - Round 3, clean but for a flaky `workflow-runner.test.ts` test, "a nudged operation is timed
    from first delivery through natural answer release". `writeWholeSync` no longer fsyncs:
    `op.json` needs only to exist and be whole, and a file fsync without its folder's bought
    nothing. The flake persisted: 2 failures in 120 runs of the file, against 0 in 60 of the
    task 6 commit, a gap the samples don't settle. Each time `deliveredAt <= first.began` missed by
    1 ms: without delivery evidence (the fake confirms none unless it supports waiting),
    `superviseOperation` takes `deliver(now())` once the turn is acquired, while the fake's script
    has already read `began` inside `execute`, so a millisecond tick between the two fails it. The
    race is the test's assumption, and the draw does not sit between the two reads; the test is
    left as it is, for the human.
- **Verification**, in the worktree, after review round 3: the whole `bun test` 2632 pass, 2 skip,
  4 todo, 0 fail (2638 tests); `bun run check` clean but for the existing Biome info;
  `workflow-runner.test.ts` 10 runs, 9 clean, 1 failing the test above. After review round 2: focused (`ops`, `screen-evidence`,
  `decisions`, `turns`, `messaging-runner`, `result-slots`, `workflow-runner`, `operation-liveness`,
  `operation-liveness-races`, `run-event-log`) pass, 0 fail; the whole `bun test` 2632 pass, 2 skip,
  4 todo, 0 fail (2638 tests, 200 files); `bun run check` clean (Biome, `tsc --noEmit`, "boundaries
  ok") but for the existing Biome info in `experiments/e9-messaging-protocol`; `cd site && bun run
  build` passes, every link and anchor resolving. One earlier full run had `a nudged operation is
  timed from first delivery through natural answer release` fail on timing; it passes alone, in its
  file and in the full rerun. The live evals that read `ops/` (`tests/turn-liveness.eval.ts`,
  `tests/tools.eval.ts`) follow the rename and were not run.

### Task 5

- **The policy** is `packages/engine/src/run-policy/waits.ts`, beside `stages.ts`: pure, contract
  only. It folds the lines and the events into what a wait can take, and decides the first wait,
  the held batch, a wake's cause and which turns need an end. The ids it can't derive without a
  hash are given to it:

  ```ts
  type DerivedIds = { timer(name: string): string; at(branch: string, due: string): string };
  type Origin = "timer" | "end" | "event" | "time";
  type WaitEvent = { id; name; data; from; at; origin: Origin; starts?: true; began?: number };
  type TimerState = { name; due; when; cancelled: boolean; taken: boolean; fired: boolean };
  type WaitState = {
    events: ReadonlyMap<string, WaitEvent>; unacknowledged: string[]; held?: string[];
    heldTakes?: WaitTake[]; lastWait?: WaitLine & { waiting: boolean };
    batches: ReadonlyMap<string, string[]>; turns: readonly TurnStartedLine[];
    timers: ReadonlyMap<string, TimerState>; races: ReadonlyMap<string, { branch: string; ids: string[] }>;
    started?: WaitEvent;
    now: number;      // the clock it was folded at
    ids: DerivedIds;  // so later calls don't pass either again
  };
  /** The lines a reader acts on: one of an attempt before the latest `claimed` is dropped. */
  function unfenced(lines: readonly RunLine[]): RunLine[];
  /** in.jsonl's events, the turns' ends and the timers due by `now`, and what the waits did with them. */
  function foldWaits(given: { lines: readonly RunLine[]; events: readonly EventLine[]; now: number; ids: DerivedIds }): WaitState;
  function readyFor(state: WaitState, takes: readonly WaitTake[] | undefined): string[];
  function pendingTimes(state, takes): { branch: string; due: string }[];
  function nextTimer(state, takes): number | undefined;
  function hasWork(state, takes): boolean;
  function wakeCause(state, takes): "event" | "timer" | undefined;
  function firstReceive(state: WaitState): string[] | undefined;
  function firstSelect(state: WaitState, takes: readonly WaitTake[]): { event: WaitEvent } | { returns: boolean };
  function acksOf(state: WaitState): string[] | undefined;
  function untakenAtReturn(state: WaitState): number;
  function unendedTurns(lines: readonly RunLine[]): TurnStartedLine[]; // matched on (agent, turn, began)
  function restoredTurns(state: WaitState): Map<string, RestoredTurn>;
  function waitLabels(lines: readonly RunLine[]): Map<number, string>;
  function recordName, matches, wouldTake, branchOf; // moved from sources.ts, which imports them
  ```

  No new field was needed: a wait outside a stage and a race writes the held batch as `acks`
  (`acksOf`) and clears the held batch, a `took` with `stage` and a `race` line acknowledge their
  own, a cancelled timer's line acknowledges its derived id, and a taken timer or time is resolved
  from its `took` entry's `timer` or `branch` and `due`.
- **The shell.** `mailbox.ts` is `waits.ts`; `RunMailbox` is `RunWaits`, built on the attempt's
  writer, `RunWaits({ runDir, lines: RunLines, locked, parking?, now? })`, the attempt being
  `lines.attempt`. `readWaits(runDir, now)` reads `run.jsonl` and `in.jsonl` and folds them. It
  writes `wait` (with `acks`, `returns`), `took`, `race`, `timer` (again with `cancelled`),
  `turn-started` and `turn-ended` through `attempt.lines`; nothing is appended as an event, so
  `timer:due`, `at:due` and `agent:ended` exist only as what a wait hands the code. Its own lines
  need no lock: only parking's last look takes it, as senders append to `in.jsonl` under it. A turn
  begun twice and an end written twice are refused or skipped from the attempt's own sets, since
  only the attempt writes either. The poll watches `in.jsonl`'s size. `in-lines.ts` owns
  `in.jsonl` (`inFile`, `readIn`, `appendIn`, `inSize`); `event-ids.ts` the three hashes,
  `DERIVED_IDS` and `endIdOf`. The runner's owner option `mailbox` is `eventWaits`.
- **Turn recovery is the claim's.** `claimRunLines` appends `claimed`, then a `turn-ended` for each
  `unendedTurns` line, failed (`crashedEnd`), at the claim's time, before anything else of the
  attempt can write or wait; every claim site gets it. `recoverTurns` is gone; the runner reads the
  restored turns from `RunWaits.open()` (`restored`).
- **Senders.** `emit` dedupes against `in.jsonl`'s ids and appends there under the lock; a starting
  event is written into `.new-*/in.jsonl` (`createRun`'s `first`, written whole and synced before
  the folder's sync and rename). `awf.` ids are still refused from a sender.
- **Launches.** `wake` makes a launch id (`generateId` with six hex digits), and the detached launch
  writes `launches/{launch}.log` and passes `AWF_LAUNCH`, which `claimNext` records as the attempt's
  `launch` (`operator-cli` reads it from the environment). A launch that throws, the detached one
  once its child exited or was given up on, is linked as attempt `n`, the number the child would
  have claimed, by `recordFailedLaunch` (`runs.ts`); a failed `link` means the child claimed it.
  `stuckOf(attempts)` reads attempt files only.
- **Readers.** `wake`'s readiness and cause, `run-state`'s `waiting`, `attempt-output.ts`'s
  `unacknowledged` (`untakenAtReturn`), and `awf inbox`'s labels read the lines. `awf inbox` and
  `awf reply` otherwise read the log as before.
- **Contract.** `MailboxRecord` and `MAILBOX_RECORD_VERSION` are gone. `AttemptRecord` gains
  `launch`, and is the union of a claimed attempt and a failed launch (review, round 1, below). Author-facing doc
  comments that described the mailbox's mechanics name `in.jsonl` or the wait instead.
- **The test option.** `earlier: { stages, events, run }`: `events` are `in.jsonl` lines, written
  before the starting event; `run` are `run.jsonl` lines, written as given after `stages`' lines,
  checked by `readRun` first (`earlier.run: run.jsonl line {n}: …`). The test's attempt is the one
  after the latest its lines name, 2 when they name none later than 1, so a parked test's
  `run.run` and `run.events` continue it. `TestRun.events` and `TestRun.run` replace `mailbox`;
  `TestRun.timers` reads the lines, a timer `fired` when taken, or due by the run's clock and not
  cancelled. `agentswf`'s typecheck uses the new shape and refuses `earlier.mailbox`.
- **Deviations, for review.**
  - *Merge order.* The design said `(at, origin, id)`; ties within one origin go by arrival (the
    order written in `in.jsonl`, or in `run.jsonl`), as the mailbox's did, so a sender's order wins
    over random ids. The design says so now.
  - *A failed launch's file* also carries `version` (until task 8's `format`), `kind: "failed-launch"`
    and the `file` it tried. Everything but `stuck`, the next number and `awf runs`' attempt list
    reads the attempts that claimed their number (review, round 1), so a parked run stays parked
    and the next launch runs the last claimed attempt's file, as before; `awf runs` lists the failed
    launch among the attempts, "failed to launch", which it didn't before. The design says so.
  - *Wait labels* for `awf inbox` are each attempt's last `wait` label (`waitLabels`), not
    `readRun`'s last wait only: a parked attempt before the latest keeps its label. A `run.jsonl`
    that can't be read gives none.
  - *The deprecated top-level `mailbox` test option and its `test-mailbox` deprecation* are gone
    with `MailboxRecord`: they typed it (039's task 10 would have removed them).
  - *`unacknowledged`* counts a timer due by the time the run returned and never taken; before, only
    a timer some wait had fired into the mailbox.
  - *No compatibility.* The legacy `answered` back-fill on old turn ends is gone; a run parked
    before this has no `in.jsonl` and its waits start empty (beta, task 8 makes it `unreadable`).
  - *Not done here.* The guides' and `workflow-api.md`'s word "mailbox" for the events a run waits
    on is left for task 8; only pages naming `mailbox.jsonl` or `process.log`, and the test API,
    changed. `awf send --event-id` is 039's task 10.
- **Tests.** `run-policy/waits.test.ts` (12): the merge order; a timer due only by the fold's
  clock and never again once taken; a cancelled timer withdrawn; a duplicate id; held, `acks` and
  `returns`; a stage's and a race's own; a held time read from state for `receive` and `select`;
  `wakeCause`; the fence; turns matched on (agent, turn, began), a stale end fenced; restored
  turns. `waits.test.ts` (was `mailbox.test.ts`) keeps every case on the new files: a timer's
  `took` names it and nothing is written as an event; parking takes the lock only for its last
  look. `time-read.test.ts`: the torn `at:due` case is gone with the event, and "a time moved while
  the take read the lines isn't taken" replaces the lock one. `turns.test.ts`: the claim writes the
  failed end right after `claimed`, once ever, and restores the untaken turn; the crash cases run
  on `earlier: { events, run }`. `runs.test.ts`: a `.new-*` folder holds `in.jsonl` before the
  rename and no run folder is ever seen without it (fails with the write moved after the rename);
  a failed launch's file, and a launcher's link refused when the child claimed. `emit.test.ts`:
  three failed launches are three attempt files with `launch` and no `pid`, and the run is `stuck`;
  `awf tick` wakes a parked run whose timer is due and leaves one with nothing due (the wait's
  `acks` now say what was acknowledged). `emit-e2e.test.ts`: each background launch has its own
  `launches/{launch}.log`, named by its attempt.
- **Review, round 1.** Two reviews; all findings accepted.
  - *A failed launch hid the attempt before it* (both reviews): `previousGone` waited on `n-1`,
    and the continue's `previous`, `resumeSessions`, `statusOf` and `waiting`, and `emit`'s reply
    check read the last attempt file. One rule now: `readAttempts(run)` returns the attempts that
    claimed their number (`isClaimed`, `claimedOf`), and `readAttemptFiles(run)` every file, which
    only `stuck`, the next number (`claimAttempt`, `recordFailedLaunch`'s) and `awf runs`' attempt
    list read. `RunStatus` has `attempts` (claimed) and `files` (all); `statusOf` takes the files
    and decides from the claimed. `previousGone` waits on the last claimed attempt below `n`. Test
    (`run-lines.test.ts`): attempt 3 parked with its process still closing and a failed launch file
    4, the run shows `parked` and claim 5 waits for 3's process (it doesn't with the old `n-1`); a
    crashed attempt 3 with a failed launch 4 is the continue's `previous`, without an ending, so it
    is stopped and its sessions not reopened, and the run is `interrupted`.
  - *`AttemptRecord` is a union*: `ClaimedAttempt` (`kind: "attempt"`, `pid` and `processStart`
    required) and `FailedLaunch` (`{ version, attempt, kind: "failed-launch", launch, file, started,
    ended, outcome: "failed", reason }`), told apart by `kind` (round 2; round 1 had `unclaimed`). Engine readers that act on an attempt
    take `ClaimedAttempt`. The union and its discriminant are meant to be final; `ClaimedAttempt`'s
    fields are reshaped by task 7 (`value` in, `stages`, `accounting`, `unacknowledged` out) and both
    lose `version` to task 8's `format`.
  - *`AWF_LAUNCH`*: `runOperatorCli` reads it once (`OperatorEnvironment.launchId`, else the
    environment's) and deletes it from `process.env` before anything spawns, and `claimNext` records
    a launch only when `launches/{launch}.log` is in this run. Tests: a claim given another run's
    launch records none, one given this run's records it; `runOperatorCli` leaves no
    `AWF_LAUNCH`. A run an agent starts with a copied environment (a test's `environment`) is not
    covered by the delete, but the log check still refuses it.
  - *A launch given up at 60 s* now kills the child's process group (`SIGKILL` alone, round 2:
    `awf run` takes a `SIGTERM` as a cancel, which ends an event run for good) and waits for it before the failed file is linked; one that claimed meanwhile goes
    on. A link refused because the child claimed first reports the launch as started, not
    `launch-failed`. Test (`emit.test.ts`): a launch that claims and then throws is `started`, its
    one attempt file claimed. The 60 s give-up itself is not unit-tested.
  - Nits, all applied: a wait computes its `acks` and appends its line in one step, on a chain
    shared with every took and race this attempt writes (`#serial`), so a wait in a parallel branch
    can't hold a batch in between; `unacknowledged` counts due timers by the run's clock
    (`keepRecords`' `now`); the cancel test cancels a due, untaken timer and checks it withdrawn;
    `workflow-api.md`'s timer no longer "fires into the mailbox"; `WaitState` carries `now` and
    `ids`, so `pendingTimes`, `nextTimer`, `hasWork` and `wakeCause` take only the state and the
    takes; `takenOf` moved into `waits.ts`, and `unrunUsage` and `crashedEnd` (which now builds the
    whole `turn-ended` line, id included) into `turn-ends.ts`. The design's "attempts/" paragraph
    and `data.md` say all this.
- **Review, round 2.** All accepted: a given-up launch gets `SIGKILL` alone; the attempt
  record's discriminant is a required positive tag, `kind: "attempt" | "failed-launch"` (design,
  `data.md` and tests follow); `takeLaunch` (`operator-cli.ts`) drops `AWF_LAUNCH` from an injected
  environment's copy too (test); a wait's take reads readiness again on the shared chain before it
  writes, so two waits in parallel branches can't take one event (`waits.test.ts`, which fails
  with the take outside the chain), and a time read from state is taken the same way.
- **Review, round 3.** One finding, accepted: `RunWaits` kept one waker, so of two waits idle at
  once a nudge from a turn's end woke only the last to start, and the poll watched only `in.jsonl`.
  A plain run can't wait on an agent's end (`#checkSources` refuses it), and every event run that
  awf or a test starts can park, so no path was found that hangs; it is fixed regardless. The waker
  is a set, a nudge wakes every wait idle, each pass removes its own, and the poll watches
  `in.jsonl`'s and `run.jsonl`'s sizes together. Test (`waits.test.ts`): two selects on two agents'
  ends with no parking, the first to start ending second, are both woken by their nudge within
  500 ms; it fails when a finished wait clears the others' wakers, as the single one did. After it:
  `waits`, `keep-alive`, `receive`, `turns`, `time-read` 92 pass, 0 fail; the whole `bun test` 2650
  pass, 2 skip, 4 todo, 0 fail; `bun run check` clean but for the existing Biome info.
- **Verification**, after review round 2: the whole `bun test` 2649 pass, 2 skip, 4 todo, 0 fail
  (2655 tests, 201 files); focused
  (`waits`, `run-lines`, `emit`, `runs`, `time-read`, `turns`, `run-policy`) 167 pass, 0 fail;
  `bun run check` clean but for the existing Biome info; the site builds, every link resolving.
- **Review, round 2.** Nothing material; four findings, all applied. `estimateOf` doesn't count a
  running attempt's operations without `spend.json` as unknown (test: a running run with a settled
  and an unsettled operation lists `$2.00`, no `?`). `settleEarlier` reads only agents with an
  operation to settle, so a slow settled one can't use up the deadline; the window's `from` keeps a
  fork's copied rows out (the fork test logs the parent's row before the fork's first operation).
  `SessionAccounting` gains optional `canRead(execution)` (the harness table's: a harness with a
  session reader), and `keepSpend` takes `reads(execution)`: an unread operation whose harness can
  never be read is written without `spend` at once, not left to every continue (tests: `canRead`
  for claude and an unknown harness; `keepSpend` with `reads: () => false`). `money` prints nothing
  when nothing is known, never a bare `?` (test: a finished run whose only spend is unknown).
- **Verification**, after review round 2: the whole `bun test` 2662 pass, 2 skip, 4 todo, 0 fail
  (2668 tests, 202 files); `spend`, `runs-command`, `run-usage` 57 pass, 0 fail; `bun run check`
  clean but for the existing Biome info.
- **Verification**, after review round 1: the whole `bun test` 2648 pass, 2 skip, 4 todo, 0 fail
  (2654 tests, 201 files); `bun test examples` 179 pass, 4 todo, 0 fail; `bun run check` clean but
  for the existing Biome info; `cd site && bun run build` passes, every link and anchor resolving;
  focused (`run-lines`, `emit`, `runs`, `waits`, `run-policy`, `time-read`, `turns`) pass, 0 fail.
- **Verification**, before review: the whole `bun test` 2644 pass, 2 skip, 4 todo, 0 fail (2650
  tests, 201 files); `bun test examples` 179 pass, 4 todo, 0 fail; `bun run check` clean (Biome,
  `tsc --noEmit`, "boundaries ok") but for the existing Biome info in
  `experiments/e9-messaging-protocol`; `cd site && bun run build` passes, every link and anchor
  resolving; `workflow-runner.test.ts` 6 runs, all clean (the known 1 ms race didn't show). After
  the last edit (`runStatus` shows no wait when `run.jsonl` can't be read): `run-state`,
  `runs-command`, `emit`, `inbox-command` 76 pass. No subagent review was run in this task's pass:
  that and the live evals are the reviewer's.

### Task 7

- **The attempt file.** `ClaimedAttempt` gains `value` (a completed attempt's return value, which
  `endAttempt` writes) and loses `stages`, `accounting` and `unacknowledged`. `AttemptAccounting`
  and `AttemptStage` stay, as what a run's total sums and what `out.json` shows. `awf emit`
  already refused a returned run from the attempt file's `outcome` (task 5); nothing there changed.
- **Readers moved off the attempt file.**
  - *Removed stages* (task 4's two reads): `upcomingStages(view)` (`run-policy/stages.ts`) takes no
    list. A stage the last redo left behind is one whose latest line is older than the redo's
    attempt and which started after the redo stage in the attempt that wrote it: the redo's attempt
    runs every stage after its start point again, so it wrote such a stage no line. A stage reused
    before the redo point has no line from that attempt either, so lines alone can't tell it from
    a stage dropped from before the redo point: that one is kept. The completed run's
    `--from-stage` choices are `upcomingStages(view)` too (`attemptRefusal`). `StageLedger` loses
    `redoEntered`. The design's "Redo" says so.
  - *`unacknowledged`*: `runStatus` counts it for a completed run with events, `untakenAtReturn`
    over `readWaits` at the attempt's `ended`, as `RunStatus.unacknowledged`; `awf runs` reads it
    there.
- **`spend.json`** (`contract`'s `SpendRecord`): `{ billing, spend?, charged?, deliveredAt?,
  settledAt?, settledBy? }`, unpriced. `engine/src/spend.ts` owns it:

  ```ts
  function writeSpend(runDir: string, op: string, record: SpendRecord): Promise<boolean>; // linkNew
  function keepSpend(runDir: string, attempt: number, usage: readonly SettledOperation[]): Promise<string[]>;
  function settleEarlier(runDir: string, options: { attempt; attempts; lines; accounting; now }): Promise<{ settled: number; failed: string[] }>;
  function readOps(runDir: string): Promise<RecordedOp[]>;   // op.json, spend.json, a decision's record
  function readSpent(runDir: string, attempts: readonly ClaimedAttempt[]): Promise<AttemptSpent[]>;
  ```

  - *As an attempt ends*, `runWorkflow` writes one per agent operation it drew, after
    `ledger.settle`: the settled record's usage, or `spend: []` for one that never reached its agent
    (a message withdrawn before it opened). When the read was cut (`reading` aborted: a second stop
    during the read), it writes none, and the next attempt reads them ([[interrupted-accounting-read]]
    folded in: a Ctrl-C during the read no longer loses the spend for good).
  - *As the next attempt starts*, `settleEarlier` settles every earlier agent operation still
    without one. Per attempt and agent: the agent's `session` lines of that attempt plus its latest
    line before it (a resumed session a crash kept it from writing again), its `home` from them;
    `accounting.read(op.execution, ids, op.cwd, home)` once; records between the attempt's
    `started` and its `ended`, the next claimed attempt's `started` or now; a request claimed once
    across the attempt's agents; billing asked once; shared by `op.json`'s `at`, each operation
    owning what came from its start to the next's, the first what came before. Written with
    `settledBy`. A runtime with no session reader writes `{ billing: "unknown", settledBy }`, as an
    ending attempt without one writes `unknown`. Failures are said through `onLog` and fail nothing.
  - *Decisions* have no `spend.json`: their usage is already their `decision.json` record
    (`SettledDecision`: tokens, `charged`), which readers sum.
- **Priced at read.** `engine/src/accounting/spent.ts`, pure: `attemptsSpent(ops, attempts,
  prices)` builds each attempt's `SettledOperation`s from `op.json` and `spend.json` and its
  decisions from `decision.json`, and prices them with `summarizeRun`; `earlierSpent` sums the
  attempts before one for the closing line's `run:` total, counting one with an operation still
  unsettled as of unknown cost (interrupted or not); `runEstimate` is `awf runs`' figure. Readers:
  `printEnding`'s run total (`operator-cli.ts` reads `readSpent` in `close`, as `spentBefore`),
  `awf runs`' list and `--json` estimate and the single run's (`estimateOf(status)`, now async).
  An attempt still running, or one with no `ended`, is timed to its last settled operation.
- **`out.json`** is `output.json` renamed (`outFile`), its shape and `OUTPUT_RECORD_VERSION` (5)
  unchanged, `accounting` priced with the table the attempt ran with, for the lab. `report.md` as
  before. `keepRecords` writes the views, then the ending with `value`.
- **`work/`** (`runs.ts`' `workDir`): `RunSkills`' root is `work/skills`; a host agent's bundle
  `work/agents/{uuid}` (so a codex agent's own home, which its `session` lines' `home` name, and
  which `awf logs` and accounting read from there as task 6 left them); `work/staging/{uuid}`;
  `work/forks/{uuid}`.
- **Deviations, for review.**
  - *`op.json` gains `at`, and an agent's operation `execution` and `cwd`* (`AgentOp`): the next
    attempt reads an interrupted operation's spend with them, since nothing else on record says
    which harness, model and folder it ran at, or when it started. `draw` stamps `at`; `opWhere`
    gives the agent's current settings and `AgentLedger.cwd()` (its sandbox's folder once seated).
  - *Settled at the attempt's start, not inside `claimNext`*: the session reader is the runtime's
    (`options.runtime.host.accounting`), which isn't installed when the claim runs. `runWorkflow`
    calls `settleEarlier` first, after reading `run.jsonl` and before its clock starts or any agent
    opens; every claim path reaches it. The design's "Its files" and "Who changes" say so.
  - *Removed stages before the redo point* now stay in `upcoming` and the completed run's choices
    (above).
  - *`describeAttempts`' "cost unknown" counts* now only an attempt whose operations couldn't be
    settled (a failed write), since the next attempt settles the rest.
  - *Comments and the CLI's help* naming `output.json` follow the rename now (`help/run.txt`,
    `index.ts`, `runs-command.ts`' `records:` line, `decisions.ts`, the lab's typecheck comment,
    the live evals' globs), since the file is renamed here; task 8 keeps the rest of the list.
- **Site.** `reference/data.md`: the folder lists `spend.json`, `out.json` and `work/` with its four
  folders; the attempt file's `value`, and where its stages, unacknowledged and cost went; `op.json`'s
  new fields; `spend.json`; `out.json` as a view, deletable; `work/` among what is safe to delete.
  `guide/cost.md`: spend kept unpriced and priced when shown, an interrupted attempt read by the
  next. `guide/how-it-works.md`: `out.json` and `report.md` are views. Every other page naming
  `output.json` says `out.json` (`decisions`, `following-runs`, `harnesses`, `quick-start`, `runs`,
  `sandboxes`, `workflows`, `reference/configuration`, `reference/workflow-api`, `site/AGENTS.md`).
- **Tests.**
  - `spend.test.ts`: an ending attempt writes `worker.1/spend.json`, unpriced, with its times and
    no `settledBy`, and a second `writeSpend` doesn't land; priced at read to $0.01. An interrupted
    attempt 1 (two drawn turns, a `session` line, no ending, no spend) is settled by attempt 2:
    each turn's share by its `at` (100 and 200 output tokens), a request from before attempt 1
    began left out, `settledBy: 2`, its cost then known; attempt 3 reads nothing again. A stop
    during the end-of-run read writes no `spend.json`, and the next attempt settles it.
  - `tests/operator-cli.test.ts`: "deleting out.json and work/ between attempts changes nothing a
    continue does": two runs of a two-stage workflow whose first stage opens a pi agent with a
    skill (so `work/skills` and `work/agents` exist), failed in the second; one has `out.json` and
    `work/` deleted; both continues complete with the same value, the first stage reused with no
    agent asked again, the same stages and the same `run:` total (attempt 1 priced from
    `spend.json`). "A later attempt totals the run": an interrupted attempt's `op.json` without
    `spend.json` is settled by the third attempt (`billing: unknown`, `settledBy: 3`, the runtime
    reading no sessions) and the total counts no attempt unknown. The attempt file has no
    `stages`, `accounting`, `unacknowledged` or (when failed) `value`.
  - `tests/review-lab.test.ts`: "awf run --json, as the lab parses it": a one-agent run through
    `runOperatorCli --json`; the lab's `parseRecord` takes it (version 5, completed), `summaryOf`
    gives `models: ["gpt-6-sol"]`, `estimate: 2` (1M input tokens at $2/M), `subscription`,
    complete; `out.json` equals the printed record.
  - Changed: `run-policy/stages.test.ts` (the ordering rule, a stage dropped before the redo point
    kept), `runs.test.ts` (the completed run's choices from lines), `tests/run-progress.test.ts`
    (no attempt-file stages), `runs-command.test.ts` (the estimate from a `spend.json`; "never
    taken" from `in.jsonl` and `run.jsonl`), `emit-e2e.test.ts` (`unacknowledged` from
    `runStatus`, `value` on the attempt file), `ops.test.ts` (`op.json`'s new fields), and every
    test naming `output.json`.
- **Review, round 1.** Two reviews; all findings accepted.
  - *`settleEarlier`'s windows*: an agent's records count from its first operation's `at`, which
    keeps a fork's copied rows out; a calling session (`execution.caller`) isn't read, and its
    operations are written `{ billing: "unknown", settledBy }`, since nothing on record bounds its
    run's turns; agents are read in the order of their first operation, not `readdir`'s; a request
    is claimed by the first agent to log it, an agent whose operations were already settled
    included, so a fork never takes its settled parent's rows. The upper bound stays the earliest
    of the attempt's `ended`, the next claim and now (safe: nothing of the settling attempt has
    opened). Each operation is read with its own `execution` and `cwd` (one read per distinct
    pair, records merged by key), billing asked per distinct `execution`; `home` also from the
    latest `session` line before the attempt; lines go through `unfenced`. Tests: the fork case,
    the caller, the window's edges (a record 1 ms before the first operation is out, one at it the
    first's, one at the attempt's end the second's, one after out).
  - *An interrupted metered operation's charge*: charges are reported as a turn ends and can't be
    read later, so `attemptsSpent` marks a `settledBy` metered record `chargeUnread`, and
    `summarizeRun`'s `figuresOf` counts its agent not billed (`PricedOperation`, internal to
    `accounting`). Test: two metered operations, one charged as it ended and one settled by the
    next attempt, give `billed: 1` of 2.
  - *Unknown cost*: an operation whose `spend.json` has no `spend` counts as unknown
    (`AttemptSpent.unread`), as one with no `spend.json` does; the closing line's `run:` total
    says "(1 interrupted, cost unknown)" again (`tests/operator-cli.test.ts` asserts it), and
    every earlier attempt's known part is now summed into it. `awf runs` marks a floor with `?`
    after the estimate (`$6.10?`), in the list and a single run's line (`unknownOps`;
    `RunView.unknownCost`); `--json`'s `estimate` is unchanged, with no new field. Test in
    `runs-command.test.ts`.
  - *`upcomingStages`*: where the line's attempt reused the redo stage (no line of it there), the
    redo stage's latest line from before that attempt stands in. The reviewer's case (a, b, c failed;
    attempt 2 reuses a and b, redoes c, runs d; attempt 3 `--from-stage b` without d) leaves d out
    (`run-policy/stages.test.ts`). The trade-off left, a stage first run before the redo stage in
    an attempt that reused the redo stage is taken for one after it and left out, is in the
    design's "Redo"; both remaining cases change only what is shown.
  - *A read that timed out or failed*: `keepSpend` takes `{ reader }` and, when a reader exists,
    writes no `spend.json` for a settled operation without `spend`, leaving it for the next
    attempt; with no reader it writes `unknown`, as before. It now runs on a cut read too, so a
    withdrawn message's `spend: []` is still written. Test: a failed read leaves no file, a
    withdrawn message gets `{ billing: "unknown", spend: [] }`, and with no reader the unread one
    is written `unknown`.
  - *A bound*: `settleEarlier` takes `signal` (the run's) and a deadline of the end-of-run read's
    grace, `statusMs` and its slack (`ACCOUNTING_GRACE_MILLISECONDS`, `STATUS_SLACK_MILLISECONDS`
    exported from `run-usage.ts`); a read or billing call past it stops the settling, and what isn't
    written is left. Test: an aborted signal writes nothing; a later settle writes it.
  - Nits, all applied: `run:` is still printed, every earlier attempt of unknown cost, when
    `readSpent` fails (`unreadEarlier`); an attempt with no `ended` is timed to the last of its
    operations' `at`s and settle times; the design says totals are summed from `spend.json` "or a
    decision's `decision.json`"; `awf runs` reads no `decision.json` (`readOps(dir, { decisions:
    false })`), since its estimate counts agents only. Parallel operations of one agent share by
    `at` as sequential ones do; the window test covers the boundary between two.
- **Verification**, after review round 1: the whole `bun test` 2661 pass, 2 skip, 4 todo, 0 fail
  (2667 tests, 202 files); focused (`spend`, `runs-command`, `run-policy`, `tests/operator-cli`,
  `tests/review-lab`) pass, 0 fail; `bun test examples` 179 pass, 4 todo, 0 fail; `bun test
  packages/lab` 146 pass, 0 fail; `bun run check` clean but for the existing Biome info; `cd site
  && bun run build` passes, every link and anchor resolving. In `tests/operator-cli.test.ts`, the
  continue's `fixed.js` is now written before the run's first attempt: written after it, Bun's
  loader failed to find it when the test ran alone.
- **Verification**, in the worktree, before review: the whole `bun test` 2655 pass, 2 skip, 4 todo,
  0 fail (2661 tests, 202 files); `bun test examples` 179 pass, 4 todo, 0 fail; `bun test
  packages/lab` 146 pass, 0 fail; `bun run check` clean (Biome, `tsc --noEmit`, "boundaries ok")
  but for the existing Biome info in `experiments/e9-messaging-protocol`; `cd site && bun run build`
  passes, every link and anchor resolving. No subagent review was run in this pass, and no live
  eval: the evals that glob `out.json` (`tests/calling-session.eval.ts`, `failed-run.eval.ts`,
  `skills.eval.ts`, `run-sandbox.ts`) follow the rename and were not run.

### Task 8

- **`format`.** `createRun` writes `format: 1` (`RUN_FORMAT`); `RunRecord.format` is required and
  `version` is gone, with `RUN_RECORD_VERSION`. `ClaimedAttempt` and `FailedLaunch` lose `version`,
  with `ATTEMPT_RECORD_VERSION`: `run.json`'s `format` covers them. `runs.ts`' `readRecord` checks
  only that a file parses to an object.
- **Unreadable runs.** `openRun` refuses a `run.json` whose `format` isn't 1 with `RunUnreadable`
  (a `RunRefused`, carrying `ref`, `why`, `created` and whether it has `events`): `{ref} is
  unreadable: an earlier awf made it, before run.json had a format; this awf does not read it`, or
  `its run.json is format {n}; this awf reads format 1 only`. Nothing else of the run is read.
  `listRunEntries` (`run-state.ts`) lists runs and unreadable ones, by `created`; `listRuns` filters
  them out, as it passed over a `run.json` that didn't read before. Who says what:
  - `awf runs` lists it `{ref}  unreadable: {why}`, and `--json` as `{ ref, unreadable }`, the
    shape a run whose status couldn't be read already had;
  - `awf runs {ref}`, `awf logs {ref}` (by `{workflow}/{id}` or a bare id) and `awf emit` print
    the message, as for a run whose files can't be read (exit 3, 3 and 1);
  - a continue refuses it, exit 2, before claiming anything;
  - `awf tick` names those with `events` in one line, `awf: {n} runs with events can't be read and
    are not woken; awf runs says why` (worded so in round 2), and in `--json` as `unreadable`, and still exits 0 (review, round
    1); one without events it never woke, so it says nothing of it.
- **`awf logs`' cursor spans both files.** `Cursor` is `{ log, run, files }`, encoded `c2.`; a `c1.`
  cursor no longer fits ("start again"), as does one past either file's end, unless `run.jsonl`
  can't be read. `run-read.ts` reads `run.jsonl`'s lines with the log's: each `session` line that
  first names a session (the fence applied, so the one `NativeSession.n` counts) is an event, handle
  `@r{n}`, `{n}` its line in `run.jsonl`, merged by time like the log's lines, which keep their
  `@e{n}`. Its text is `session {harness} {id}` under its stage (by its operation) and agent, as
  `session-known`'s was; `--agent` and `--stage` filter it; `@r{n} --full` prints the line, and
  `--json` publishes it as the line (`LogEventJson` gains the `session` line). `awf runs`' `next:`
  carries the new cursor. Waits and sessions were already `readRun`'s in `awf logs`, `awf runs` and
  `awf tick` (tasks 5 and 6); this task changed none of their reads.
- **Which session lines text shows** (review, round 1): a fork's session, and one that isn't its
  agent's first, a session it moved to. An agent's first session is left out of text, as its
  opening and first turn stand for it; `--json` and `@r{n}` keep every first-naming line. Before
  task 6 the log had `session-known` only for a fork's session and one named after delivery;
  `run.jsonl` doesn't tell the second from one named at delivery, so the rule is by agent instead.
- **Records line.** `awf runs {ref}`' is `records: {dir} (run.jsonl, log.jsonl, ops/, out.json,
  report.md)`.
- **Docs.** The site: `reference/data.md` (`format`, what is versioned and what a run without it
  gets, a new run's first stage line carrying `redo`); `guide/following-runs.md` (the `@r` handle in
  the sample and its prose, the `c2.` cursor, `unreadable` in `awf runs`); `guide/runs.md` (a run
  with events redoes as a plain run does: no records move); the word "mailbox" for the events a run
  waits on, in `guide/events.md`, `guide/timers.md`, `guide/hosting-events.md` and
  `reference/workflow-api.md`, said as events kept for a wait, and a due timer as one a wait takes,
  not one that lands anywhere. Task 4's two notes were already on the site from task 6
  (`durability.md`: the resumed attempt doesn't carry `--values`; `data.md`: every start point a
  redo), and `data.md` now says a new run's first stage is one. `docs/design/runs-and-stages.md`:
  "The files", "Why it is shaped like this", "Reading it", the stage plan, `--values`, the breakage
  list and "Where things are deliberately simple" describe `run.jsonl` and the redo line, not
  `stages/`, `replaced/` or `turns.jsonl`; `format` replaces "`version` in every file".
  `docs/design/run-record.md` says it is built, by this story. `docs/status.md`: what 041 built, and
  that it awaits human review, with the paths and words of earlier entries brought up to date.
  ADR 0012's session line names `run.jsonl`'s `session` lines (ADR 0014); `messaging.md:829`
  `log.jsonl`; 039's line ("the mailbox's record names") the event names awf records; the lab's
  `reference.md:528` `out.json`; `foundation.md`'s link to the todo now the design's. The code
  map's comments and messages were already current (tasks 5–7). Three test names that said
  "mailbox" say what is kept instead.
- **Todos.** `run-record-layout` is deleted, as the todo README says of a todo a story took up;
  its drift list is this story's Outcome, and links to it in the design, the foundation, the todo
  README and this story now point here or are plain text. `non-answered-evidence` keeps M1 and M2,
  its screen now `ops/{key}.{n}/screen.txt`; `interrupted-accounting-read` keeps what is left, the
  cut attempt still showing its spend unknown until a continue, with what 041 built. The links in
  `038:900` and `040:193`, `:581` point at `[[run-record]]` (review, round 1).
- **Tests added.** `runs.test.ts`: a `run.json` with `version` and no `format`, one with `format:
  2`, and one that isn't an object: the first two `RunUnreadable` with their messages, the third a
  plain refusal; `run.json` has `format: 1` and no `version`, an attempt file no `version`.
  `emit.test.ts`: an event run made before format 1, beside a current one: `awf tick` says it isn't
  woken and exits 1 while waking the other, `emit` refuses it, `awf runs --json` and the text list
  it `unreadable` after the current run, and `awf runs` and `awf logs` by ref and by bare id print
  the message. `tests/operator-cli.test.ts`: a continue of such a run exits 2 with the message and
  claims no attempt. `logs-command.test.ts`: a session named mid-turn shows as `@r2` under
  `--agent`, `@r2 --full` and `--json` give the line, `@r3` is no event; cursors past either file
  and a `c1.` one don't fit, one at the end does; the fake-harness run's log lines read as before
  and its four session lines in order, the fork's after the fork. `run-read.test.ts`: the merge
  holds the session lines, `c2.` round-trips, `c1.` and negative fields are refused, `r{n}`
  handles round-trip. Changed for the new events: the page counts and the first page's lines in
  `logs-command.test.ts`, the cursor prefix in `runs-command.test.ts`.
- **The grep.** `git grep -n -E 'output\.json|calls/\{|turns\.jsonl|mailbox\.jsonl|process\.log|liveness\.jsonl|stages/|replaced/|decisions/\{' -- site packages examples`
  finds nothing. Words that remain and are not files: `mailbox` in `earlier.mailbox`'s refusal and
  `agentswf`'s typecheck that it is refused.
- **Verification**, before review: the whole `bun test` 2663 pass, 2 skip, 4 todo, 0 fail (2669 tests, 202 files), run before the last edit (the cursor check skipped when `run.jsonl` can't be read, and its test), after which the six files it touches (`logs-command`, `run-read`, `runs`, `runs-command`, `emit`, `tests/operator-cli`) pass 229, 0 fail; `bun test examples` 179 pass, 4
  todo, 0 fail; `bun test packages/lab` 146 pass, 0 fail; `bun run check` clean (Biome, `tsc
  --noEmit`, "boundaries ok") but for the existing Biome info in `experiments/e9-messaging-protocol`;
  `cd site && bun run build` passes, every link and anchor resolving. No subagent review and no live
  eval was run in this pass.
- **Review, round 1.** Two reviews, code and docs; all findings accepted.
  - *`awf tick`* failed for good while an old event run was there: it now names them in one line
    and in `--json`'s `unreadable` (a new optional `TickResultJson` field), exit 0; 1 stays for a
    run that couldn't be woken. Test (`emit.test.ts`), text and `--json`.
  - *`findRunByRef`* threw an old run found here before looking in the projects: it now remembers
    it and throws it only when no run that reads has the ref. Test: an old `dd-case/shared` under
    the shell's folder and a current one in a known project; `awf runs` by both refs shows the
    current one, and with no project the old one's message.
  - *Attempt files and `run.json`*: an attempt file is refused (`could not be read: no positive
    attempt`, `kind "…" is unknown`) unless `attempt` is a safe positive integer and `kind` is
    `attempt` or `failed-launch`; a format-1 `run.json` missing `id`, `workflow`, `cwd`,
    `created`, `argv` or `sandbox` is unreadable (`its run.json has no {field} of the right
    type`), listed as such, not sorted on. Test (`runs.test.ts`). Test fixtures that wrote attempt
    files without `kind` now write it.
  - *Session lines in text*: an agent's first session left out, above. The fake-harness test's
    text is the pre-task-6 text but for one line: its log lines as before, and of `run.jsonl`'s
    the fork's (`@r3`, where `@e9` was) and the named agent's `fake-named` (`@r6`), a session the
    fake reports as it closes, which the log never recorded. So "the text before task 6, exactly"
    doesn't hold; `--json` has all four first-naming lines. Earlier test counts went back to their
    values before this task. The site's `following-runs.md` sample drops the reviewer's first
    session and says what `@r` shows. Nit: a session line an earlier attempt wrote after a later
    one's `claimed` isn't shown in text or `--json`, and its handle is no event (test).
  - *Docs*: `durability.md` says the next attempt reads an interrupted attempt's usage, linking
    Cost; `data.md` says the first-stage-not-reused redo is a run without events', words the
    events no wait took, and lists `turn-started`'s and `turn-ended`'s fields and `spend.json`'s
    `deliveredAt` and `settledAt`; `run-record.md` reads as built: no `label`/`until`/`needs` on the
    attempt file (the code writes none), no `version` on a failed launch, the entries only a run
    with events has (`in.jsonl`, `launches/`, the lock), "before 041" where it described older
    code and as the reading table's column, `AgentEnded` for `TurnEnd`, `args` and `source` typed
    for 040 and not yet written; ADR 0011's `replaced/` bullet has an amended-by note; the links in
    `038:900` and `040:193`, `:581` point at `[[run-record]]`.
- **Review, round 2.** Wording only, applied: `awf tick`'s line and `TickResultJson.unreadable`'s
  doc say a run can't be read, not who made it, since a format-1 run missing a field is one too;
  `help/tick.txt` says what the line and `--json`'s `unreadable` are; `data.md` names a format-1
  `run.json` missing a required field as unreadable. `quietSessions` stays as it is. It assumes
  `run.jsonl`'s session lines come in file order, so an agent's first is the first of its lines
  read; a line a fence drops is never its first, and handles count lines, not sessions.
- **Verification**, after review round 2: the whole `bun test` 2665 pass, 2 skip, 4 todo, 0 fail (2671 tests, 202 files); `emit.test.ts` 47 pass, 0 fail; `bun run check` clean but for the existing Biome info; `cd site && bun run build` passes, every link and anchor resolving.
- **Verification**, after review round 1: the whole `bun test` 2665 pass, 2 skip, 4 todo, 0 fail (2671 tests, 202 files); focused (`logs-command`,
  `run-read`, `runs`, `runs-command`, `emit`, `continue`, `tests/operator-cli`) 260 pass, 0 fail;
  `bun test examples` 179 pass, 4 todo, 0 fail; `bun test packages/lab` 146 pass, 0 fail; `bun run
  check` clean but for the existing Biome info; `cd site && bun run build` passes, every link and
  anchor resolving; the Done-when grep finds nothing.

## Human review

- [x] Every task is complete and story-level verification passes.
- [x] Set the story status to `awaiting-human-review` and present the outcome, architecture
  decisions, task-level subagent findings and dispositions, exact verification results, deviations,
  and remaining risks.
- [x] Record the human's explicit approval or requested changes here. Accepted 2026-11-05.
- [x] If changes are requested, return to the affected task and repeat its review and verification.
- [x] Only after explicit approval, mark the story `done` and update `Stories at a glance`.
