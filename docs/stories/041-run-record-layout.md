---
id: "041"
title: "A run's records, one home per fact"
summary: "A run's folder gets the layout of docs/design/run-record.md: run.json, run.jsonl with a published readRun, in.jsonl, attempts/, log.jsonl, ops/{agent}.{n}/, out.json and work/, before agents.wf leaves evaluation."
type: story
status: in-progress
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
[[run-record-layout]] measured seven places where it has drifted, on 2026-11-04:

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
  `docs/design/run-record.md`. The drift list is [[run-record-layout]].
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
- [ ] 2. Operations: `ops/{key}.{n}/`, keys as names in one namespace, decisions written whole
- [x] 3. The claim: wait for every previous attempt, truncate, `claimed`, the fence
- [x] 4. Stages and redo from `run.jsonl`; `stages/` and `replaced/` go; `earlier.stages`
- [ ] 5. Waits: `in.jsonl` and the run's own lines; timers and turn ends stop being events; `launches/`; `earlier.events` and `earlier.run`
- [x] 6. Sessions as `session` lines; the log is `log.jsonl` and nothing acts on it
- [ ] 7. Attempt files keep `value`; `spend.json` priced at read; `out.json`; `work/`
- [ ] 8. Readers, site and docs; old runs are `unreadable`

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

Depends on 039's task 10, which refuses a colon in a key first.

- `ops/{key}.{n}/` replaces `calls/{uuid}/` and `decisions/{n}.json`, for turns, message
  operations, compactions, decisions, and an agent's start that failed.
- Its files are `op.json`, `answers.jsonl`, `result.json`, `decision.json` (written whole,
  named by `DecisionRecord.artifact`), `live.jsonl` and `screen.txt`. `spend.json`'s path is fixed
  here, and task 7 writes it.
- An op id `{agent}.{n}` and the tests' turn names `writer#2`, `implementer#2` (`during:`,
  `turnsOf`) say the same thing two ways: the tests move to `.` here.
- `n` counts from 1 across attempts: each attempt lists `ops/` as it starts, which task 3 moves into
  the claim.
- An agent or decision key that fails `nameProblem`, or clashes with the other namespace, is
  refused at open or at ask. `implementer#2` in the site sample is renamed.
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

Depends on 039's task 10, which removes `awf send --event-id`, the last thing that gates on the log.

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
- The todos this story finished are folded in: [[run-record-layout]], and the record parts of
  [[non-answered-evidence]] and [[interrupted-accounting-read]].

Done when:

- `git grep -n -E 'output\.json|calls/\{|turns\.jsonl|mailbox\.jsonl|process\.log|liveness\.jsonl|stages/|replaced/|decisions/\{' -- site packages examples`
  finds no reference to a gone file (each hit read; prose like "tool calls/" is not one);
- the site builds;
- every example test passes (`examples/**/*.test.ts`).

## Verification

Automated:

- [ ] `readRun` table tests; claim and fence tests; op numbering and key tests
- [ ] `bun test`
- [ ] `bunx tsc --noEmit`
- [ ] `bun run scripts/check-boundaries.ts`, with the new pure policy module listed
- [ ] `bun run check`
- [ ] `cd site && bun run build`

Manual or live evaluation:

- [ ] One live event run on codex: emit, a timer, a park and a wake, then a continue with
  `--from-stage`. Read the folder by hand with `cat` and check that each fact sits where the design
  says. Cheap models, under a dollar.
- [ ] `awf-lab` on one case: its `awf run --json` parse is unchanged.

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
- **Verification**, in the worktree, after review round 2: `bun test packages/contract` 103 pass, 0
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

## Human review

- [ ] Every task is complete and story-level verification passes.
- [ ] Set the story status to `awaiting-human-review` and present the outcome, architecture
  decisions, task-level subagent findings and dispositions, exact verification results, deviations,
  and remaining risks.
- [ ] Record the human's explicit approval or requested changes here.
- [ ] If changes are requested, return to the affected task and repeat its review and verification.
- [ ] Only after explicit approval, mark the story `done` and update `Stories at a glance`.
