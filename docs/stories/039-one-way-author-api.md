---
id: "039"
title: "An author learns one way to do each thing"
summary: "One context type for every workflow, participants routed to the code declared in events, one duration grammar, one testWorkflow signature, one word per state, and what is unbuilt or unused removed, each through a deprecation that ends before 0.1.0."
type: story
status: ready
priority: P0
epic: authoring
discovered_in: "a review of the workflow API while running the Datadog watcher, 2026-10-26"
depends_on: ["034"]
---

# An author learns one way to do each thing

## Outcome

awf is a framework for building workflows, and what an author has to learn is its cost. Today the
author API often offers two ways to do one thing: two context types, two ways to wait on a started
turn, five ways to write a time, two `testWorkflow` signatures, two words for one state. After this
story there is one way for each. Every old form that works today is deprecated for one beta, naming
its replacement, then removed before 0.1.0; names that are unbuilt or unused go at once. It matters now because every beta that ships adds
workflows written against the old forms.

The design, with a today/after example for every change, is
[[design/api-consolidation|design/api-consolidation.md]]. This story owns the scope, the order and
the tasks; the design owns what each change is and why.

## How it works

```
  defineWorkflow({ meta, events?, starts?, file?, run })
            │
            ▼
  WorkflowContext<Events = {}>          one type; race, select, sleep, at, after for every run
    ├─ agents.open / fork / caller ─▶ AgentRef / CallerRef
    │     run()   wait here for the end
    │     start() hear the end at a wait, as {key}:ended
    ├─ participants.connect ─▶ ParticipantRef
    │     a message reaches the code only if {key}:reply is in events
    └─ waits take a declared name; time is a Duration ("90s", "14d") or a Date
```

Three ideas carry the change:

- **What a workflow declares is what it gets.** `events` lists everything that can wake the run,
  including participants and agents (`{key}:reply`, `{key}:ended`). Declaring events no longer
  changes the context type, so a workflow that only wants a `race` against a deadline doesn't have
  to declare a `file` and an id.
- **One spelling for each thing.** Time is one grammar, a decimal and `s`, `m`, `h` or `d`, in the
  API and on the CLI. A bound on a call is `timeout`. A state has one word in `wfa`, `awf` and the
  records.
- **Choices the operator owns move to the operator.** Which terminal workspace an agent's pane goes
  to, and whether panes stay after the run, become flags recorded in `run.json`. The workflow keeps
  which agents share a tab and which one the operator should see.

`run` and `start` stay two calls. They take the same spec. The engine records a started turn so it
survives a crash or a park, and doesn't record an awaited one, so it must know which kind a turn is
when the turn begins. `caller` and `forkCaller` also stay two calls: only `caller` needs `--here`.
Agents follow the same declaration rule as participants: `start()` for a key whose `{key}:ended`
isn't declared throws, as [[034-event-driven-runs|story 034]]'s Q19 decided.

## Scope

In scope, by the design's sections:

- §1 one context type; `--from-stage` for every run.
- §2 agents: wait on the agent rather than its turn; `CallerRef`; `runtime` on fork;
  `agent.close()`; the per-call `id` deprecated; `agents.attach` removed; panes.
- §3 participants declared in `events`, one `ParticipantRef`, a `timeout` on any route.
- §4 one duration grammar and `timeout` in the API and on the CLI.
- §5 one `testWorkflow` signature and testing's renames.
- §6 removals, deprecations, explicit exports, `ref` in `output.json`.
- §7 `awf emit` for a reply to the code; one word per state.
- The examples, `site/reference/` and `docs/status.md` follow each task.

Out of scope:

- Parking a run without events. It still sleeps in its process
  ([[037-workflow-timers|story 037]] task 4).
- Stage reuse by content for every run. Runs without events keep ordered reuse (ADR 0011).
- `--id` meaning "start or go on". `--continue` stays.
- Model and effort in three places, the four meanings of "label", `wf.decisions` on the core
  context, and `wf.usage()` beside `wf.allowance()` (candidates 6 and 8 below). Each was weighed and
  left as it is.
- Whether the operator can refuse `metered: true` in a workflow installed from npm.

### The candidates and what became of each

These are the candidates of the former todo `api-consolidation`, numbered as other stories cite
them.

| # | Candidate | Outcome |
| --- | --- | --- |
| 1 | Two kinds of workflow | one flat `defineWorkflow` ([[034-event-driven-runs\|034]] task 11); one context type, task 3 |
| 2 | `run` and `start` | names kept; wait on the agent, tasks 1 and 4 |
| 3 | Three ways to talk | participants declared in `events`, task 7 |
| 4 | Five calls for the calling session | `attach` removed (task 1); `CallerRef`, task 4; `caller` and `forkCaller` stay |
| 5 | Panes in the author API | the word is done (`tui`, 0.1.0-beta.5); workspace and keeping panes move to the operator, task 9 |
| 6 | Model and effort in three places | kept: `runtime` on fork (task 4) is the only change |
| 7 | `testWorkflow` | one signature, task 6 |
| 8 | Labels, `wf.decisions`, `usage`/`allowance` | kept; one `WaitOptions`, task 1 |
| 9 | Testing's `reply` | `noAnswer.*`, task 2 |
| 10 | Two words for one state | task 8 |
| 11 | `awf send --event-id` | `awf emit`, task 7 |
| 12 | `--continue` beside `--id` | kept |
| 13 | Event runs differ beyond `receive` | `--from-stage` and route `timeout` follow, tasks 3 and 7; where runs live and stage reuse are kept |
| 14 | Stopping an agent is two calls | the ref had no stop; `agent.close()` replaces `agents.stop(key)`, task 4 |
| 15 | Time has several shapes | task 5 and task 8 |
| 16 | Smaller still | `ref` in `output.json` (task 1), `eventId` (task 2); records keep `version` and command JSON `v` |

The run's id is `--id` on the CLI and `runId` in records. That was settled before this story and is
not a candidate.

## Context and evidence

- Constraint: published types, record formats and the wire are expensive (AGENTS.md). Tasks 3, 7,
  8 and 9 change behaviour or a record and are marked **structural** in the design.
- Constraint: unbuilt interface leaves the surface (ADR 0001). That is why `steps`, `call`,
  `receive({ take })` and `timers()` are removed rather than deprecated.
- Fact: today a workflow with events refuses `--from-stage` (`run-prepare.ts:164`,
  `workflow-runner.ts:460`), because every attempt after the first is started by a wake, which
  passes on no flags (`run-prepare.ts:159`). Such a run reuses stages by content
  ([[034-event-driven-runs|034]] task 2), a plain run in order (ADR 0011).
- Fact: `agents.attach` throws for every key but the caller's (`workflow-runner.ts:1017`). `steps`
  (`:1094`) and `call` (`:1132`) throw as unavailable.
- Fact: a nudge's deadline "can shorten the operation, never extend it"
  (`contract/src/workflow/agents.ts:305`). `timeout` already does that, so `nudge.deadline` adds
  nothing.
- Fact: `wfa peers` reports `awaiting` and `outside` (`wire.ts:711`); records say `awaiting-reply`.
- Dependency: this story builds on [[034-event-driven-runs|story 034]] tasks 1–12. Its task 13
  (every wake source declared, Q19) moved here as task 7, without the `*:reply` and `*:ended`
  wildcards, and with `to: "code"` deprecated rather than removed outright.
- Related: [[stopped-run-recovery]]'s debug mode may extend `--keep-panes on-failure` later. Task 9
  carries over what `keepPane: "on-failure"` means today.

## Code map

### contract

- `workflow/workflow.ts` holds `WorkflowContext` and `EventWorkflowContext`; they become one
  context (task 3).
- `workflow/agents.ts` holds `AgentRef`, `EventAgentRef`, `attach`, `stop`, `caller`, `forkCaller`,
  fork's options, `layout` and `keepPane` (tasks 1, 4, 9).
- `workflow/executable.ts` holds `defineWorkflow` (task 3) and the `defineExecutableWorkflow`
  shim, deprecated in task 1.
- `workflow/waits.ts` and `events.ts` hold the options for `race`, `select` and `receive`,
  `Duration` and `When`, and the event names (tasks 1, 3, 5, 7).
- `workflow/participants.ts` holds `connect`, `to: "code"` and `CodeParticipant*` (task 7).
- `workflow/messaging.ts` holds `allow` and `timeoutMs` (tasks 5, 7).
- `workflow/timing.ts` holds `AbsoluteDeadline`, `{ unixMilliseconds }` (task 5).
- `wire.ts` holds `WIRE_VERSION` 5 and `PEER_STATES` (task 8).
- `records.ts` holds the output record, `awaiting-reply` and `keepPane` (tasks 1, 8, 9).

### agentswf

- `src/workflow.ts` is `export *` of contract's workflow; it becomes an explicit list (task 1).

### engine

- `workflow-runner.ts` holds the unavailable stubs, the `--from-stage` refusal and the
  agent/participant wiring (tasks 1, 3, 4, 7).
- `run-prepare.ts` holds the `--from-stage` refusal and the operator flags (tasks 3, 9).
- `duration.ts` and `deadlines.ts` turn times into deadlines (tasks 5, 8).
- `pane-layout.ts` and `herdr-placement.ts` place panes (task 9).
- `holder-command.ts` handles `awf send --event-id`; `emit-command.ts` handles `awf emit`
  (task 7).
- `agent-cli/cli.ts`, `runs-command.ts` and `run-view.ts` name states (task 8).
- `workflow-testing/index.ts` and `script.ts` hold `testWorkflow` and `reply.*` (tasks 2, 6).

### Callers

- `examples/` (each workflow and its `*.test.ts`) and `site/reference/` (`workflow-api.md`,
  `testing-api.md`, `awf.md`, `wfa.md`) change with each task.
- The Datadog watcher, outside this repository, migrates on the deprecation warnings.

## Proposed design

[[design/api-consolidation|The design]], §1–§7. Its decisions for review 1–4 are accepted: no
`*:reply` wildcard; grouping and `front` stay the workflow's while workspace and keeping panes move
to the operator; `--from-stage` for every run; no colon in an agent's or participant's key, since
`{key}:ended` and `{key}:reply` must split at one colon.

Rejected:

- One turn API, and folding `forkCaller` into `caller()?.fork` (see "How it works").
- Stage reuse by content and parking for every run. They change the run's record and where a run
  lives, for no author-visible gain this story needs.
- A `*:reply` wildcard. It silently routes a coordinator's messages to the code.
- One `--id` meaning start or go on. It risks continuing by accident a run meant to be new.

Deprecation rule: a deprecated name lives one beta after the beta that deprecates it, is logged
once per attempt with its replacement, and none survives into 0.1.0.

## Tasks at a glance

Betas from the design's §8 in brackets.

- [x] 1. Unbuilt and unused names out, old forms deprecated, waits name the agent, `agentswf/workflow` an explicit list (A)
- [x] 2. Testing's renames: `noAnswer`, `run.ending`, `eventId`, `TestTurn` (A)
- [x] 3. One context type, and `--from-stage` for every run (B)
- [x] 4. Agents: `CallerRef`, `runtime` on fork, `agent.close()` (B)
- [x] 5. One duration and `timeout` in the API (B)
- [x] 6. One `testWorkflow` signature (B)
- [x] 7. Participants routed to the code declared in `events`; a reply to the code by `awf emit` (C)
- [x] 8. Durations and one word per state on the CLI and the wire (D)
- [ ] 9. Pane workspace and keeping panes move to the operator (E)
- [ ] 10. What tasks 1–9 deprecated is removed (F)

## Open questions

None. Whether the operator can refuse `metered: true` (an author's consent to per-token billing)
in a workflow installed from npm is out of scope: task 4 only moves where `metered` is written.

## Task execution rule

Process one task at a time. Every task repeats the checklist shown under its details. Do not begin
the next task because the current implementation merely compiles: its design must be recorded, its
diff reviewed by subagents, findings resolved, and focused verification complete. Each task updates
the examples, `site/reference/` and `docs/status.md` for what it changed.

After all tasks are complete, run story-level verification and request human review of the complete
deliverable.

## Task details

### 1. Unbuilt and unused names out, old forms deprecated, an explicit export list

Outcome: an author sees only names that work, every deprecated name says what replaces it, and a
wait names the agent rather than its turn.

Execution:

- [x] Plan: inspect the relevant code and tests and record the architecture and focused proof.
- [x] Implement: make only this task's coherent change and add focused tests with it.
- [x] Review: obtain architecture/scope and correctness/proof subagent reviews of the actual diff.
- [x] Resolve: disposition findings and obtain targeted re-review after material design changes.
- [x] Verify: satisfy every `Done when` item before checking this task.

Work:

- Remove `wf.steps`, `wf.call`, `receive({ take })`, `wf.timers()`, `WorkflowDefinition`,
  `agents.attach` and `participants.get` (design §6).
- Deprecate agent `labels`, `meta.whenToUse`, a stage around `receive`, `isAnswered` and
  `defineExecutableWorkflow`, and the per-call `id` on `run`, `start`, `compact` and `set` (§2;
  the design gives this no beta, so it goes with the others here). Each logs once per attempt, naming
  its replacement.
- A wait names the agent; a turn passed to `race`, `select` or `receive` is deprecated, and the
  turn keeps `id` and `cancel()` (§2).
- One `WaitOptions` for `race`, `select` and `receive`, with `label?: string | (() => string)`.
- `agentswf/workflow` exports an explicit list of the names an author uses. The examples import it
  instead of `@agentswf/contract/workflow`.
- `output.json` gains `ref`.

Done when:

- A typecheck fixture shows each removed name fails to compile and each deprecated one compiles.
- A run test shows each deprecated name logs its replacement once per attempt, a turn in `race`
  included.
- An engine test reads `ref` from a finished run's `output.json`.
- `eventWorkflowProblem` and `placementOf` are not importable from `agentswf/workflow`.
- `bun test`, `bunx tsc --noEmit` and the boundaries pass. `examples/` import only
  `agentswf/workflow` and `agentswf/testing`.

### 2. Testing's renames

Outcome: in a test, `reply` only ever means answering.

Execution:

- [x] Plan: inspect the relevant code and tests and record the architecture and focused proof.
- [x] Implement: make only this task's coherent change and add focused tests with it.
- [x] Review: obtain architecture/scope and correctness/proof subagent reviews of the actual diff.
- [x] Resolve: disposition findings and obtain targeted re-review after material design changes.
- [x] Verify: satisfy every `Done when` item before checking this task.

Work:

- `reply.*` becomes `noAnswer.*`, and `message.silent()`/`fail()` become returning nothing, or
  returning `noAnswer.failed(reason)` (§5). A throw stays a script error that fails the test, so
  a failing `expect` in a message script can't become a failed turn the workflow tolerates.
- `run.ending` replaces `run.stopped` and its sibling accessors.
- An event's id is `eventId`, in test options and in scripted events.
- `TestTurn` and `TestTurnOutcome` replace testing's `TurnRecord` and `TurnOutcome`, and record the
  engine's outcome.
- The unscripted-participant error names `participants`.
- `awaitReply` and `reply.waiting` leave the published surface.

Done when:

- The renamed names compile, deprecated, and log once; `awaitReply` and `reply.waiting` are gone.
  Every example test uses the new names.
- A test asserting `run.ending` passes for a completed, a stopped and a failed attempt.

### 3. One context type, and `--from-stage` for every run

Outcome: any workflow can `race`, `select`, `sleep` and use timers, and a workflow with events
redoes from a stage like any other.

Execution:

- [x] Plan: inspect the relevant code and tests, settle the cleanest module, interface, seam,
  invariants, failure behavior, and focused proof, and record material alternatives before coding.
- [x] Implement: make only this task's coherent change and add focused tests with it.
- [x] Review: have two read-only subagents review this task's actual diff and test output—one for
  architecture and scope, one for correctness and proof.
- [x] Resolve: fix or explicitly disposition every material finding; request targeted re-review
  when a fix changes the selected architecture.
- [x] Verify: run this task's focused checks and satisfy every `Done when` item before checking the
  task in `Tasks at a glance` or starting the next task.

Work:

- One `WorkflowContext<Events = {}>` and one `AgentRef`. `EventWorkflowContext` and
  `EventAgentRef` become deprecated aliases.
- `signal`, `started` and `receive` take only declared names.
- `file` and a run id are required only with `starts`.
- **Structural:** `--from-stage` for a run with events reruns that stage and every later one; their
  earlier results move to `replaced/` as in a plain run.
- An agent's or participant's key with a colon is deprecated: it logs once, naming the key with
  `-` in place of each colon. The examples move to `-` (`reviewer-${lens}`, `worker-${name}`).

Done when:

- A workflow with `events` but no `file`, `starts` or id races an agent against `"14d"`, and one
  with no `events` races a timer; both typecheck. A misspelled signal name is a type error. (An
  agent's end reaches only a run with events, so a run without them refuses an agent as a wait's
  branch.)
- An engine test continues a run with events `--from-stage {stage}`. It reruns that stage and the
  ones after it, keeps the earlier ones, and its record reads as a plain run's does.
- A run test shows `open({ key: "reviewer:security" })` logs the deprecation once, and no example
  uses a colon in a key.
- The 034 and 037 example tests pass unchanged apart from the type names.

### 4. Agents

Outcome: an agent's ref is the one handle for its turn, its runtime and its end.

Execution:

- [x] Plan: inspect the relevant code and tests and record the architecture and focused proof.
- [x] Implement: make only this task's coherent change and add focused tests with it.
- [x] Review: obtain architecture/scope and correctness/proof subagent reviews of the actual diff.
- [x] Resolve: disposition findings and obtain targeted re-review after material design changes.
- [x] Verify: satisfy every `Done when` item before checking this task.

Work:

- The caller's ref is `CallerRef`: no `set` or `compact`, and no `tools` on its fork.
- `fork` and `forkCaller` take `runtime`. The flat `placement`, `metered` and `effort` are
  deprecated.
- `agent.close()` replaces `wf.agents.stop(key)`, which is deprecated.

Done when:

- A typecheck fixture shows `me.set` on a caller is a type error.
- An engine test closes an agent by its ref and sees its pane or process ended, as `stop` did.
- A fork with `runtime: { placement: "headless", metered: true }` runs as the flat form did.

### 5. One duration and `timeout` in the API

Outcome: every time in the API is a `Duration` or a `Date`, and every bound on a call is
`timeout`.

Execution:

- [x] Plan: inspect the relevant code and tests and record the architecture and focused proof.
- [x] Implement: make only this task's coherent change and add focused tests with it.
- [x] Review: obtain architecture/scope and correctness/proof subagent reviews of the actual diff.
- [x] Resolve: disposition findings and obtain targeted re-review after material design changes.
- [x] Verify: satisfy every `Done when` item before checking this task.

Work:

- One grammar, a decimal and `s`, `m`, `h` or `d`, shared by timers and `timeout`. `duration()`
  validates a string read from data.
- `timeout?: Duration | Date | false` replaces `timeoutMs` and `deadline` on `open`, `fork`,
  `forkCaller`, `run`, `start`, `compact`, `set`, `parallel`, `decide` and tools. It can't reach past
  the stage, `parallel` or run around it.
- `nudge.deadline` is deprecated. `keepAlive.timeoutMs` becomes `window`. `wf.deadline` is a `Date`.
- Testing: `timeoutMs`, `stallMs` and `SendOptions.timeoutMs` become `timeout`, `stall` and
  `SendOptions.timeout`.
- Records keep milliseconds.

Done when:

- A typecheck fixture shows `"10x"` fails, and `"1.5h"`, `"90s"` and a `Date` pass.
- An engine test shows a `timeout` longer than its stage's is cut to the stage's, as `deadline`
  was.
- The old fields compile, deprecated, and resolve to the same deadline.

### 6. One `testWorkflow` signature

Outcome: `testWorkflow(workflow, options?)` for every workflow.

Execution:

- [x] Plan: inspect the relevant code and tests and record the architecture and focused proof.
- [x] Implement: make only this task's coherent change and add focused tests with it.
- [x] Review: obtain architecture/scope and correctness/proof subagent reviews of the actual diff.
- [x] Resolve: disposition findings and obtain targeted re-review after material design changes.
- [x] Verify: satisfy every `Done when` item before checking this task.

Work:

- `args` becomes an option, required by type when the workflow takes args. `id` defaults to
  `"test"`.
- `earlier: { stages, mailbox }` replaces `recorded` and `mailbox`.
- `maxTurns` applies to every workflow.
- Unknown option keys are refused.
- The three-argument form is deprecated. With it goes the last published signature naming the
  engine's `RunnableWorkflow`, which took `WorkflowDefinition`'s place in task 1.
- `agentswf/testing` exports an explicit list, as task 1 made `agentswf/workflow`'s.

Done when:

- Every example test uses the one signature.
- A test continues with `earlier: { stages, mailbox }` and reuses both; `maxTurns` fails a run
  without events that starts one turn too many.
- A typecheck fixture shows a missing `args` for a workflow that takes them is a type error, and
  a misspelled option fails at run time with the key named.

### 7. Participants routed to the code declared in `events`

Outcome: a reader of a workflow's definition sees everything that can wake its run. This is
[[034-event-driven-runs|story 034]]'s task 13, moved here.

Execution:

- [x] Plan: inspect the relevant code and tests, settle the cleanest module, interface, seam,
  invariants, failure behavior, and focused proof, and record material alternatives before coding.
- [x] Implement: make only this task's coherent change and add focused tests with it.
- [x] Review: have two read-only subagents review this task's actual diff and test output—one for
  architecture and scope, one for correctness and proof.
- [x] Resolve: fix or explicitly disposition every material finding; request targeted re-review
  when a fix changes the selected architecture.
- [x] Verify: run this task's focused checks and satisfy every `Done when` item before checking the
  task in `Tasks at a glance` or starting the next task.

Work:

- **Structural:** a participant's message reaches the code only when `{key}:reply` is declared.
  `start()` for a key whose `{key}:ended` isn't declared throws. Both are checked when sent; there
  are no wildcards. `participant:reply` and `agent:ended` are deprecated.
- `connect` returns one `ParticipantRef` (`post`, `release`). `to: "code"` and `CodeParticipant*`
  are deprecated.
- `AgentEnded` and `ParticipantReply` are exported as schemas.
- `is(e)` stays on timers and agents only.
- A route's `timeout` works on any route.
- **Structural:** `awf emit {ref} {key}:reply '{json}' --event-id {id}` replaces
  `awf send --event-id`, which is deprecated and forwards to it.
- Scripted events use the declared name: `thread:reply`.

Done when:

- An e2e test: a participant declared as `thread:reply` replies, and the code receives it under
  that name. An undeclared participant's message goes to its agents, never to the code.
- `awf emit` of an undeclared `{key}:reply` is refused with the declared names listed, and so is
  data that doesn't fit its schema.
- `agent.start()` for a key without `{key}:ended` declared throws, in the engine and in
  workflow-testing; with it declared, the end is received under that name.
- `awf send --event-id` still delivers, through `awf emit`, and logs its replacement.
- `examples/` with a participant routed to the code run under the new form, and the Datadog sketch
  is updated.

### 8. Durations and one word per state on the CLI and the wire

Outcome: a script written against `wfa` reads `awf` the same way, and every CLI time takes the
same grammar.

Execution:

- [x] Plan: inspect the relevant code and tests and record the architecture and focused proof.
- [x] Implement: make only this task's coherent change and add focused tests with it.
- [x] Review: obtain architecture/scope and correctness/proof subagent reviews of the actual diff.
- [x] Resolve: disposition findings and obtain targeted re-review after material design changes.
- [x] Verify: satisfy every `Done when` item before checking this task.

Work:

- `--timeout` and `--wait` take a `Duration`. A bare number for `--wait` still means seconds
  until 0.1.0. The CLI's `parseDuration` (`engine/src/duration.ts`) and `wfa`'s own parser
  (`agent-cli/cli.ts`) move to contract's one grammar, `durationMilliseconds`.
- **Structural:** wire version 6 and JSON `v` 2 with the state table in design §7:
  `peer-stopped`, `awaiting-reply`, `already-awaiting`, `kind: "participant"`, and a fixed set of
  agent states in `awf runs --json`.
- An old `wfa` against a new engine fails with a version error that names both versions.

Done when:

- `awf run --timeout 1d` and `awf logs --wait 90s` work, and `--wait 90` still does.
- Wire tests cover every state in the table, and a version-5 client is refused with a clear error.

### 9. Pane workspace and keeping panes move to the operator

Outcome: the operator decides where a run's panes go and whether they stay. The workflow decides
which agents share a tab and which one comes to the front.

Execution:

- [ ] Plan: inspect the relevant code and tests, settle the cleanest module, interface, seam,
  invariants, failure behavior, and focused proof, and record material alternatives before coding.
- [ ] Implement: make only this task's coherent change and add focused tests with it.
- [ ] Review: have two read-only subagents review this task's actual diff and test output—one for
  architecture and scope, one for correctness and proof.
- [ ] Resolve: fix or explicitly disposition every material finding; request targeted re-review
  when a fix changes the selected architecture.
- [ ] Verify: run this task's focused checks and satisfy every `Done when` item before checking the
  task in `Tasks at a glance` or starting the next task.

Work:

- `pane: { tab?, front? }` on `open`, `fork` and `forkCaller`. `layout` and `keepPane` are
  deprecated.
- **Structural:** `awf run --workspace {name}` and `--keep-panes {never|on-failure|always}`, both
  recorded in `run.json`, so a run that wakes later keeps them.
- `on-failure` keeps what `keepPane: "on-failure"` means today; [[stopped-run-recovery]] may
  extend it later.

Done when:

- An engine test: a run started with `--keep-panes on-failure` that parks and wakes keeps the
  setting, and a failed agent's pane stays.
- A Herdr live check (cost: one cheap TUI agent) opens a pane in a named workspace and tab.

### 10. What tasks 1–9 deprecated is removed

Outcome: no deprecated name ships in 0.1.0.

Execution:

- [ ] Plan: inspect the relevant code and tests and record the architecture and focused proof.
- [ ] Implement: make only this task's coherent change and add focused tests with it.
- [ ] Review: obtain architecture/scope and correctness/proof subagent reviews of the actual diff.
- [ ] Resolve: disposition findings and obtain targeted re-review after material design changes.
- [ ] Verify: satisfy every `Done when` item before checking this task.

Work:

- Remove every deprecated name, each at least one beta after the beta that deprecated it.
- Remove `awf send --event-id`, and the bare-number `--wait`.
- A key with a colon is refused when the agent or participant opens, with the reason.
- Agent keys made at run time: `site/patterns/review-on-event` opens `reviewer#2`, `reviewer#3`
  after a failed turn, and no fixed `events` declares their `{key}:ended` without the wildcard 034
  dropped. Decide before the refusal lands: a pattern that doesn't start a new key, or a declared
  name a family of keys shares. **Needs the human's decision.**
- Cost grouping: a run without stages groups agents by the key's part before a colon (`grouping:
  "prefix"`, a record value). With colons refused, decide whether it groups at `-`, which regroups
  existing hyphenated keys, or becomes one row per agent under a new value.

Done when:

- A typecheck fixture shows each removed name, a turn passed to `race` included, fails to
  compile; `awf send --event-id`, `--wait 90` and a key with a colon are refused with the
  replacement named.
- `site/reference/` documents only the new forms.

Tasks are checkpoints, not a file-by-file edit script. The implementation agent may adjust the
implementation without changing their outcomes, order, or the story's scope.

## Verification

Automated:

- [ ] Each task's typecheck fixtures and engine tests above.
- [ ] Every example's test passes on the new forms.
- [ ] `bun test`
- [ ] `bunx tsc --noEmit`
- [ ] `bun run scripts/check-boundaries.ts`

Manual or live evaluation:

- [ ] Task 9's Herdr check.
- [ ] One live run of an example with a participant routed to the code (task 7). Cost: one cheap
  model turn.

## Review record

Record reviews under the task they cover.

### Task 1

Architecture and scope review: no blocking findings.
- Deprecations log once per attempt, not once per run: a parked run logs again on every wake.
  Kept per attempt, which needs no record; the story, design, site and code now say so.
- `isAnswered` reports through a function the engine attaches, non-enumerable, to each outcome it
  hands the workflow. Accepted as the seam a pure contract allows, best effort, commented as such.
- `testWorkflow`'s second overload now names the engine's `RunnableWorkflow`; `agentswf/testing` is
  still `export *`. Both moved to task 6.
- `author.ts` exported names only signatures need; trimmed to what an author writes or annotates.
- `ref` added to `output.json` without a version bump, as data.md allows; made optional for files
  written before it.

Correctness and proof review:
- A race whose function label threw had already burned its name; fixed, with a test.
- Several deprecation sites were unproven, each masked by an earlier use logging first; each now has
  a run of its own, the stage-around-`receive` replay and a continued attempt included.
- `receive({ take: "all" })`, the old default, is accepted; only `"oldest"` is refused.
- The reporter does nothing once the attempt has ended.

### Task 2

Architecture and scope review:
- A throwing message script failed the turn, so a failing `expect` in one became a failed agent a
  workflow could tolerate. Reversed: a throw fails the test; `return noAnswer.failed(reason)`
  fails the turn. The design's §5 example and task 2's Work say so.
- A `listenDeprecations` seam in the runner was unneeded: the test owns one `RunDeprecations`.
- The recorded outcome was re-derived from the script, and a hung turn the engine timed out read
  `cancelled`. Turns now take the engine's recorded outcome, matched by operation id.
- `needs` had no home on `run.ending`: added to the contract's `Ending`, from the stop, so `report`
  sees it too; the on-disk records are unchanged.
- `awaitReply` was taken off the surface through a symbol key on `TestOptions`; an internal
  `runTest` that `testWorkflow` wraps replaced it.

Correctness and proof review: the hung-turn outcome and the weakened `needs` assertion above, and a
cast that could build an invalid ending, now an explicit narrow. A targeted re-review of the fixes
found the records unchanged and asked for a test pinning `needs` in `output.json` (added), and a
throw after a suspended turn reported as the throw (fixed). Compactions are still matched to the
engine's records by position: the harness's `compact` carries no operation id.

### Task 3

Architecture and scope review:
- `WorkflowContext<Events>` is invariant, so a helper typed `(wf: WorkflowContext)` broke for a
  workflow with events, with no deprecation possible. The bare type now defaults to `any`, while
  `defineWorkflow` hands a plain workflow `WorkflowContext<NoEvents>`. Accepted cost: a bare
  annotation takes any `signal` name, which the run-time check refuses.
- A plain workflow's race on an agent typechecked but couldn't be won: an agent's end reaches only
  a run with events. Such a run now refuses an agent or participant branch at once. The Done-when
  was corrected to match.
- The docs claimed a redo replays the same events; only a race's answer is recorded. Corrected.
- Cost grouping by the part before a colon becomes one row per agent once keys use `-`: a
  decision added to task 10.
- The colon deprecation's reason named events that arrive only in task 7; reworded.

Correctness and proof review, and two targeted re-reviews of `--from-stage` on a run with events:
- Moving every record not yet entered moved per-event stages before the start stage too, losing
  their run-once reuse. Ordering by `started` then let a later stage that predated the start
  stage's record escape the redo (a caught failure, a new version), and ties misordered. Reading the
  event log was rejected: `--continue` never reads it (ADR 0011). As built, the redo is carried by
  attempt numbers the records already hold. A stage entered after the start stage, in the redo
  attempt or a later one, reruns if its record predates the redo.
- The last re-review found three bugs, each fixed with a test:
  - A crash while the start stage ran lost the redo. The old record now moves only as the new one
    is written.
  - A "never reached" attempt counted as a redo. A redo is now marked by the attempt's own
    `stages`.
  - A stage entered both before and after the start stage ran twice in one attempt.
- The colon-key deprecation now names each key once per attempt.

### Task 4

Architecture and scope review: nothing blocking. Internal fork specs were retyped
`CallerForkSpec`, `ForkRuntime` left the author surface (only `CallerRef` and `CallerForkSpec` are
new names), and the refused flat-beside-`runtime` fork no longer logs a deprecation first. Accepted:
a helper typed `(a: AgentRef)` no longer takes the caller, as the design intends.

Correctness and proof review: no defect. `close()`'s doc claimed `false` for an agent a failed turn
had closed; the code, like `stop`, resolves `true` there, and the doc now says so. Tests were added
for the fork forms in both orders, `runtime: {}`, a TUI fork dropping `metered`, and effort
inherited. A fork's identity lives in memory only, so no recorded spec changed.

### Task 5

Architecture and scope review: nothing blocking.
- A tool's `timeout` took a `Date`, which on a reusable `tool()` fails every later call; it is a
  per-call budget, so it takes `Duration | false`, as a route's does.
- `RunDeadline` was exported only to carry a deprecated property; it is written inline instead.
- Five positive-duration checks became one, `positiveDurationMilliseconds`, and the test host's
  send now refuses `"0s"`.
- `timeout-ms` and `deadline-option` name the call each was used on.
- The docs' `timeout: wf.deadline` example was wrong in a stage or `parallel`, and was dropped.
- `wfa`'s own duration parser went to task 8.

Correctness and proof review: no defect for typed callers. For untyped ones:
- `deadline: null` now reads as absent, as before.
- `parallel` no longer honours a `timeoutMs` it never had.
- An invalid old form throws without warning first.

The "cut to the stage's" proof was really the run's: a stage has no deadline of its own, so the
test cuts a timeout to a `parallel`'s inside a stage, and a past `Date` is shown to fail `open` and
`decide`.

### Task 6

Architecture and scope review: nothing blocking.
- Telling the forms apart by argument count, then by the kind of the second argument, was upheld.
  Matching by keys would misread args silently; the one break, object args given second with no
  options, fails `tsc` and at run time, and is documented.
- `agentswf/testing` had re-listed the engine's curated list; it is `export *` of that one list
  again, as `agentswf/workflow` is of contract's.
- `maxTurns` reaching plain workflows is listed with the changes made without a deprecation.

Correctness and proof review:
- Args `prepare` made of no argv skipped `awf run`'s JSON check, so a test passed a `Date` or a
  `Promise` that a run refuses. Now checked.
- `earlier: {}` wasn't a continue; any given `earlier` is now.
- Options must be a plain object; the key check runs before the `kind` check, naming the key.

Engine tests that still call the deprecated forms move with task 10.

### Task 7

Transition, decided: throwing at once in `start()` without a declared `{key}:ended` would break
every workflow with events that starts a turn today, with no beta between. It throws only in a
workflow that declares some `{key}:ended`, which no workflow before this task could; elsewhere it
is deprecated and logged, and task 10 makes it throw. `to: "code"` follows the same rule.

Architecture and scope review:
- The shipped coordinator skill still taught `awf send --event-id`; it teaches `awf emit` now.
- Accepting awf's two event names only when their schema equals the engine's literal tied every
  workflow to one version of it. They are recognised by `$id` instead, and a reply is checked
  against the engine's own schema.
- `awf send --event-id` stopped working without the run's file; a participant connected to the
  code is again delivered without loading it.
- The `awf emit {ref}` form had grown to take any event: it takes only `{key}:reply`, and the
  `--target` form refuses one.
- A misspelled `{key}:ended` type-checked; it no longer does.
- `wf.signal` on an agent's end, a second way to wait on it, is refused.
- The mailbox's record names are documented as permanent.

Correctness and proof review:
- A reused stage around a wait handed back awf's record names where attempt 1 handed out the
  declared ones; every path now presents the declared name.
- `start()`'s error for a colon key now says to rename it.

A targeted re-review found:
- A compile break: a `to: "code"` spec held in a variable matched the plain `connect` overload.
  The deprecated overload now comes first.
- `agent.is` narrowed a loosely typed event wider than before; it narrows as it did.
- `awf send --event-id` exited 3 where it had refused with exit 1; it refuses again.

Not run: the live check of a participant routed to the code (one cheap model turn). Its commands
are in the task 7 notes.

### Task 8

Architecture and scope review: nothing blocking.
- `awf runs {run} --json` still said `working` for an agent that `wfa peers` and the human line
  called `awaiting-reply`. With `v` 2 unpublished, the state is now one word everywhere, `waiting`
  and `awaiting-reply` included.
- The agent states are tied to `TurnOutcome` both ways, and stage states got a closed type too.
- A missing answer is "most likely" an older awf, not certainly.

Correctness and proof review: durations were checked against HEAD's parser on edge inputs; nothing
that worked changes meaning, and the forms that only worked by accident (`1e2`, `.5`, `''`) are
usage errors. A blank `--as` or agent now fails as a usage error rather than reaching the socket.
`wfa` prints the `ms` deprecation only when it accepted the value. A version-5 decoder taken from
git history accepts the engine's refusal.

Not run: a real harness's `wfa` in a pane across a reinstall mid-run.

## Readiness

- [x] Outcome and boundaries are concrete.
- [x] Relevant implementation, callers, and tests are mapped.
- [x] Evidence and research support the proposed design.
- [x] Expensive interface, record-format, and stage-gate decisions are settled.
- [x] Tasks are ordered, coherent, and independently verifiable.
- [x] Open questions are resolved or explicitly moved out of scope.

## Implementation notes

### Task 1

- The explicit list is `@agentswf/contract/author`, which `agentswf/workflow` re-exports and the
  engine's loader serves; the engine can't import `agentswf`, so one list lives where both reach.
- `WorkflowDefinition` became the engine's internal `RunnableWorkflow`.
- `SelectOptions` and `ReceiveOptions` were removed outright: one `WaitOptions` is one type.
- Deprecations: one list, `engine/src/deprecations.ts`, which task 10 deletes with its uses.
- A test that set a 10 ms nudge deadline before its agent opened failed under load, on `main` too;
  it now sets the deadline after the open.

### Task 2

- A test logs its own deprecated forms through a `RunDeprecations` of its own, made before the
  run, whose lines go into `run.logs` as the runner's warnings do, `{ message }`. It is told an
  event's `id` from the options; a `reply.…()` value, built before any run, carries its
  deprecated name, which the scripted host reports when it consumes the entry, as do
  `message.silent()` and `fail()`; and `run.stopped` and `run.parked` report on first read. Those
  two are not enumerable, so spreading a run reads neither. The runner's own instance keeps task
  1's names; the two sets don't overlap, and the runner gained no seam.
- A turn's `outcome` is the engine's: once the run has ended, each operation's last turn takes the
  outcome its line in the run's turns records, matched by operation id, and each compaction the
  agent's compaction line in order (its operation id is the engine's own). A turn before that keeps
  the host's word: `unanswered` when a nudge followed, `waiting`, or `awaiting-reply`. This is a
  value change, not a name, so it can't be deprecated: `silent` is now `unanswered`; `needsLogin`
  `failed`; `interrupted` `cancelled`; `hang` `timed-out` past a deadline, else `cancelled`; a
  silent compaction `failed`. `tsc` flags a test comparing the old word, and the testing reference
  says so beside its deprecated table. In flight, a turn is known by the host's open set.
- `TurnRecord` and `TurnOutcome` were never exported from `agentswf/testing`, so they get no
  deprecated aliases: `TestTurn` and `TestTurnOutcome` are simply exported.
- A message script that throws fails the test, as a throwing `answer(fn)` does, so a failing
  `expect` inside one can't pass as a failed turn the workflow catches. Failing the turn on purpose
  is `return noAnswer.failed(reason)`; `message.fail()` is deprecated in favour of it. This departs
  from the design's "or throwing".
- `testWorkflow` wraps `runTest(workflow, args, options, engine?)` in `run-test.ts`, which
  `index.ts` doesn't export; the engine's own tests call it with `{ awaitReply: "anywhere" }`.
  `waiting` stays in `script.ts`, likewise unexported.
- `run.ending` is `decideEnding`'s, as `awf run` decides it. Its `continue` names the workflow's
  file where it has one, a workflow with events, and its name otherwise: a plain workflow carries
  no path. An attempt the test ended because everything waited on a participant is `cancelled`
  with that reason, or `completed` if the workflow returned.
- `Ending`'s unfinished kinds gained `needs?: StageNeed[]`, as the attempt record already had, so
  `present`, `report` and `run.ending` see what a stop for `--values` needs; `StageNeed` moved to
  the contract's `workflow/executable.ts`, re-exported from records, and `AttemptEnd.needs` went,
  its readers taking the ending's.

### Task 3

Plan, settled before coding:

- **One context.** `WorkflowContext<Events extends EventSchemas = Record<never, never>>` carries
  what `EventWorkflowContext` added: `receive`, `race`, `select`, `timer`, `at`, `after`, `signal`,
  `started`, and the deprecated stage-around-`receive` overload. `Record<never, never>` is `{}`
  spelled so Biome accepts it: `keyof` it is `never`, so a workflow without events can `signal`
  nothing, and a misspelled name fails `tsc` in one with events. `AgentRef` takes `turn`, `start`
  and `is` and is a source; `AgentOpenSpec` takes `keepAlive`; the directories are one
  `AgentDirectory` and the one `participants` directory, `CodeParticipantDirectory`, until task 7
  replaces `to: "code"`. `EventWorkflowContext<E>`, `EventAgentRef`, `EventAgentOpenSpec` and
  `EventAgentDirectory` stay as `@deprecated` aliases; a type can't log.
- **The engine already builds one context and one agent class**; only the typing differed. The time
  calls move from "with a mailbox" to every run, over the `waits` mailbox every run has (story 037).
  A plain run has no `park`, so a wait waits in its process, as `sleep` does today: parking a plain
  run stays out of scope. What a plain run still can't do throws with why: `start()` (its end
  arrives as an event, which needs events declared; task 7 narrows that to `{key}:ended`),
  `keepAlive`, `to: "code"`. `signal` checks its name against `events` at run time too, for a
  workflow `tsc` never saw.
- **`file` and the id.** The engine needs `file` only where a sender holds the workflow object and
  not a path: `wf.emit(target, …)` finds the target's project and launches its run by it. `awf run`
  and `awf emit --target` loaded the file from a path, and wakes run the file recorded with the run.
  So `file` is required by type only with `starts`, and checked at run time only where it is used:
  `wf.emit` to a target without one throws, naming `import.meta.path`; the loader still checks a
  `file` given is the file loaded. A workflow with events and no `starts` gets a generated id from
  `awf run` as a plain run does; with `starts` the id stays required, since senders name it.
  `starts` absent still means every event starts a run (no behaviour change; `awf emit --target`
  does it by path).
- **`--from-stage` for a run with events (structural).** The ledger keeps reuse by content, with a
  start point: until the attempt enters `--from-stage`'s stage, stages are reused by content as on
  any wake (one with no record or a failed one runs, as it would on a wake); entering it, it runs,
  and every record not entered so far in this attempt moves to `replaced/`, through the plain run's
  `replaceStale`, so later stages run again. After that, by content again, now over the records
  this attempt kept and wrote. Nothing new is recorded: the attempt's `flags.fromStage`, the stage
  records, `replaced/` and the summaries read as a plain run's do. Waits are not stage results: a
  race keeps its recorded answer, and the mailbox is untouched, so the redone stages run on the same
  events. The attempt is an ordinary hand continue; the wakes after it carry no flag and reuse by
  content what it wrote. If it would park, or return, before reaching the stage, it stops "never
  reached" instead, as a plain run does at its end: parking would silently drop the redo, since no
  wake carries the flag. `--values`, and `--from-stage` on a new run, stay refused for a run with
  events: before the start point a stage with no record simply runs.
- **Keys with a colon.** `#assertFreeKey`, which every agent open, fork, caller and participant
  passes, logs `colon-key` once per attempt, naming the key with `-` for each colon. A deprecation
  may take the subject it names. The examples move to `-`.

Rejected:

- Switching a `--from-stage` attempt to ordered reuse (`planStage`): it refuses a stage entered
  twice, which runs with events do by design, and needs `--values` for a per-event stage it hasn't
  seen.
- Recording the start point in `run.json` so later wakes keep redoing until it is reached: a new
  record field, for the case of a stage the replay never reaches (one per event, behind an
  acknowledged `receive`), where stopping says so plainly.
- Parking before the start point with a warning: the redo the operator asked for would be lost
  without a stop to show it.
- Generic `WorkflowContext<Events = never>`: every string would extend `keyof never`.
- Splitting the `-` keys for cost grouping: a run without stages groups agents by the key's part
  before a colon (`accounting/summary.ts`); with `-`, each key is its own group. Splitting at `-`
  would regroup every existing hyphenated key, so the grouping is left as it is and noted.

Caveats: agents in a redo reopen on their kept sessions, as on any wake, so an agent that ran the
stage before remembers it; a deprecated stage around `receive` after the start point waits for new
events. Testing a workflow with events from a stage is task 6's options.

As built, after review:

- **Typing.** `WorkflowContext<E>` is invariant in `E`: `receive` returns `E`'s events and
  `signal` takes its names. Bare, `WorkflowContext` defaults `Events` to `any`, so a helper typed
  `(wf: WorkflowContext)` takes any workflow's context, with events or without, as it took an
  `EventWorkflowContext` before; `signal` in such a helper is checked when it runs. A workflow's
  own `run` is typed exactly: `defineWorkflow`'s overload without events passes
  `WorkflowContext<NoEvents>` (`Record<never, never>`), so `wf.signal("x")` there fails `tsc`, and
  one with events rejects a misspelled name. `NoEvents` stays out of `agentswf/workflow`. Accepted
  trade-off: an explicitly annotated `run(wf: WorkflowContext)`, or a helper typed with it, accepts
  any `signal` name; the run-time check catches it.
- **Checks moved from compile time to run time** for a workflow without events, accepted under one
  `AgentRef` and one context: `agent.start()`, `keepAlive` and `to: "code"` throw, saying why; a
  `race` or `select` with an agent's end (or a participant routed to the code) among its branches
  is refused at once, since a run without events hears neither; `signal` of an undeclared name
  throws. A plain workflow races and selects on timers and durations, and `receive` takes a due
  timer, all in its process (`timers.test.ts`, through `runNew` without `park`).
- **`file`.** The loader gives a workflow with events and no `file` the path it loaded it from, so
  `awf run`, `awf emit --target` and the run's record have it; `wf.emit` to a target without one
  throws an `EmitError` naming `file: import.meta.path`. `eventWorkflowProblem` requires `file`
  only with `starts`.
- **`--from-stage` by content: later records move as they are reached.** On entering S, attempt N
  runs it, and S's old record moves to `replaced/` only as its new one is written, as a failed
  record's does: an attempt that dies while S runs leaves the old record and no redo, which the
  operator issues again. Every attempt then finds the last redo, `lastRedo` in `stage-plan.ts`: the
  latest earlier attempt N with `flags.fromStage` S that ran S, which its attempt record's `stages`
  says (`source: "ran"`), or, for one that died after S's record was written, S's record being N's
  own. A stop for a stage never reached, a refused attempt and one that died while S ran have
  neither, so none is a redo; no reason text is matched. A redo whose S failed and ran again on a
  wake is still the redo. In N and every later attempt, a stage first entered after S, in that
  attempt's own program order, whose record has `attempt < N`, reruns, its record replaced as
  `#opened` replaces a failed one; a stage already entered in the attempt, before S or after,
  keeps the value it had there. A record never entered after S keeps its reuse: a stage per event
  behind an acknowledged `receive` is not redone, and S's earlier stages stay. A later redo
  supersedes an earlier one. Only stage records (`attempt` is the attempt that ran the stage, and a
  reuse never rewrites it) and attempt records, which a continue reads already, decide it.
  Rejected: ordering by `started` (it orders by when a record was written, not where the stage sits
  in the program: a caught failure rerun on a wake, or a version adding S before X, makes a later X
  look earlier; same-millisecond records tie; clocks skew between hosts), and reading the event log
  (it is observation only, which `--continue` never reads, and its writes may fail unsaid). Proof:
  `stage-ledger.test.ts` (a caught failure, a new version, a same-millisecond tie, a redo that
  parks after S and is finished by the next wake, per-event stages kept, a later redo superseding,
  a death while S runs and after its record, a never-reached stop, a stage entered before and after
  S), `receive.test.ts` (a stage behind an acknowledged batch keeps its record), `emit-e2e.test.ts`
  (the redo's attempt record, and the park hook stopping "never reached").
- Accepted residual: a later wake that never enters S (a conditional branch, or S behind an
  acknowledged `receive`) reuses the records after S's position, and only the latest redo is kept.
- **Deprecations.** `RunDeprecations.used(name, subject?)` says each subject once per attempt, so
  each key with a colon is named; a deprecation's `instead` may be a function of the subject, and
  reads whole without one. The reason given is that a colon is kept for awf's own event names.
- **Cost grouping.** A run without stages groups agents' cost by the key's part before a colon,
  recorded as `grouping: "prefix"`. With `-` keys that grouping is per agent
  (`tests/operator-cli.test.ts` now expects a row per agent). Task 10, which refuses the colon,
  must decide what `"prefix"` groups by, or drop it.
- The `--from-stage` e2e test (`emit-e2e.test.ts`) runs each hand continue in a process of its
  own: an attempt waits for the one before it to exit, so two in the test's process would wait on
  each other.

### Task 4

- **`CallerRef` is the narrower interface, and `AgentRef extends CallerRef`**, adding `compact`,
  `set`, and a `fork` that also takes `tools`. `CallerRef` keeps `key`, `execution`, `run`,
  `fork(CallerForkSpec)`, `turn`, `start`, `is` and `close`, and is a `PeerRef` and a source, so
  the caller works as a wait's branch, with `is(e)`, and in `messages.allow`, as before. An
  `AgentRef` is assignable to a `CallerRef`, not the reverse: a helper for any agent, the caller
  included, takes a `CallerRef`. Accepted cost: a helper typed `(a: AgentRef)` that was passed the
  caller stops compiling, with no deprecation possible; that is the point of the type. The runtime
  refusals stay for a JavaScript caller: `set` throws, `compact` ends `failed`, a fork's `tools`
  throws. Rejected: a third, neutral base name (one more name to learn), and `CallerRef` as an
  unrelated interface (helpers would need a union).
- **A fork's runtime** is `PlacementChoice & { effort? }`, `ForkRuntime` in the contract but not
  in `agentswf/workflow`: no harness, model or alias, since a fork continues its parent's session on them; a JavaScript caller naming one is refused,
  not ignored. `CallerForkSpec` is what `forkCaller` and the caller's `fork` take, replacing
  `Omit<AgentForkSpec, "tools">`; `AgentForkSpec` extends it with `tools`. **Flat and `runtime`
  together are refused** whenever any flat field is given beside `runtime`, not merged by field: one
  rule to state, and nothing to unpick in task 10. The flat form is rewritten into `runtime` before
  the spec is kept, so a repeat in either form is the same fork. One deprecation, `fork-runtime`,
  for all three fields, not logged when refused beside `runtime`.
- **`close(reason?)` on the caller hands the session back to the operator**, as
  `agents.stop(callerKey)` did: its running turn is cancelled, `onCallerStopped` runs, later
  `caller`/`forkCaller` reject. It resolves false when already closed. `close` is the runner's
  `stopAgent`, so both forms share every rule: stage ownership, the scope's deadline, the refusal
  in the agent's own tool handler (now naming `close()`), a retry after a failed teardown. The
  runner's internal teardown, which `LogicalAgent` called `close`, is now `terminate`.
  `wf.agents.stop` alone still answers false for a key never opened or that failed to open; a ref
  exists only for an agent that opened.
- Tests: `workflow-runner.test.ts`'s `agent.close()` block is the old `agents.stop` block on the ref
  (pane kept or closed per `keepPane`, socket revoked, key not reopened, caller handed back,
  concurrent closes, retry); `deprecations.test.ts` shows a fork's `runtime` executes as the flat
  form (headless, metered, effort), the two forms are one fork, both together and a `model` are
  refused, and `fork-runtime` and `agents-stop` each log once; the typecheck fixture is
  `packages/agentswf/src/workflow.typecheck.ts` (`me.set`, `me.compact`, `me.fork({ tools })`,
  `runtime: { model }`, a `CallerRef` as an `AgentRef`).
- Unverified, a live check to return to: that `close()` on a real TUI agent closes its Herdr pane,
  and keeps it per `keepPane`, and that it hands a real `--here` session back. The code path is
  `stop`'s unchanged, and the fake adapter's close is what the tests observe.

### Task 5

- **One parser, in the contract.** `Duration` gains `s`; `durationMilliseconds(text)` (pure, in
  `contract/src/workflow/waits.ts`) is the one grammar, a decimal and `s`, `m`, `h` or `d`, read by
  timers (`parseWhen`, `wf.after`), every `timeout`, `keepAlive.window`, a route's `timeout` and a
  test's options. `duration(text)` checks a string read from data and returns it as a `Duration`;
  it and the `Timeout` type (`Duration | Date | false`) are on the author list; `wf.deadline`'s
  type is written inline, not exported. `positiveDurationMilliseconds(text, what)` beside it is the
  one check for a length that must be longer than none, with one message, `{what} is a positive
  duration: …`: every `timeout`, `keepAlive.window`, a route's, a tool's, a test's options and a
  script's send. `"0s"` parses, as `"0m"` did for a timer; a bound refuses it. The CLI's
  `parseDuration` (whole numbers, `ms`) is untouched: task 8. The engine's formatter of
  milliseconds is `formatDuration`, so it doesn't share `duration`'s name.
- **One resolver in the engine.** `boundedDeadline(given, ceiling, deprecated)` in `deadlines.ts`
  turns `timeout`, or the deprecated `deadline` or `timeoutMs`, into a deadline cut to the bound
  around the call; `false` and nothing are the bound around it. `open`, `fork`/`forkCaller`,
  `run`/`start`, `compact`, `set`, `parallel` and `decide` (in the decisions directory, which owns a
  call's deadline) all go through it, so the old forms resolve to the deadline the new one does.
  An untyped caller's `null` is no bound, as the old truthy checks had it, and an invalid old form
  throws without being logged. `parallel` reads only `timeout` and `deadline`, never a
  `timeoutMs` it never took.
- **A tool's `timeout` is `Duration | false`**, as a route's is a `Duration`: each is a budget per
  call or question, and a `Date` on a reusable `tool()` would fail every later call.
  `false` leaves the turn's deadline alone.
- **Old and new together are refused**, as task 4 refused flat beside `runtime`: `timeout` beside
  `deadline` or `timeoutMs`, `window` beside `keepAlive.timeoutMs`, a route's, a tool's and a
  test's `timeout` beside their `timeoutMs`, `stall` beside `stallMs`. Nothing is logged then.
  `nudge.deadline` is not a form of `timeout`, so beside it it still shortens the turn, logged.
- **`fork` and `forkCaller` gained `timeout`**, which had no bound: it bounds taking the copy (still
  within 60 s) and opening the fork. It is the call's, so it is left out of the spec a repeat is
  compared by.
- **`wf.deadline` is a `Date`** that still answers `unixMilliseconds`, a non-enumerable getter that
  logs `run-deadline-ms` and returns `getTime()`: typed inline as `Date & { readonly
  unixMilliseconds }`, the property `@deprecated`. Code that reads `wf.deadline?.unixMilliseconds`
  keeps working, logged once; code that passes it as a deprecated `deadline` keeps compiling and
  works, since a deprecated `deadline` or `nudge.deadline` is copied to a plain object first (which
  reads the getter, so it logs). Each read of `wf.deadline` is a new `Date`, so changing one moves
  nothing. Rejected: a new name (`wf.endsAt`), which would leave `wf.deadline` an old shape to remove
  and a second name to learn; and a plain `Date`, which would break `.unixMilliseconds` silently,
  as `undefined`, with no log. What breaks with no log: code that compared `wf.deadline` with
  `toEqual({ unixMilliseconds })`, or put it in a JSON value (a `Date` is not one); `tsc` flags
  the second.
- **A route's `timeout` is a `Duration` only**: it is how long each question waits, not a time.
  Route records keep `timeoutMs`, and a route granted with either form compares equal. That a
  route's timeout works on any route is still task 7's; the refusal now says `timeout`.
- **Records keep milliseconds**: no record or wire field changed (`route-opened.timeoutMs`, the
  inbox's `route.timeoutMs`, `wfa`'s `timeoutMs`). A timer's record keeps `when` as written, so a
  `"90s"` timer records `"90s"`.
- Deprecations added to the one list: `timeout-ms` (every `timeoutMs`, a test's and a send's
  included), `deadline-option`, `nudge-deadline`, `keep-alive-timeout-ms`, `run-deadline-ms`,
  `stall-ms`. `timeout-ms` and `deadline-option` name the call as their subject (`on run`, `on a
  tool`, `on a route`, `on parallel`, `in testWorkflow's options`, …), so each call's old form is
  said once an attempt. Testing logs its three through its own instance; a send's through the host's
  `onDeprecated`.
- `DeadlineExceededError.deadline` stays `{ unixMilliseconds }`, as does `AbsoluteDeadline` on the
  author list: the deprecated fields name it. Task 10 decides whether the error carries a `Date`.
- Proof: `packages/agentswf/src/workflow.typecheck.ts` (`"10x"` and a number fail as a `timeout`
  and a timer; `"1.5h"`, `"90s"`, a `Date` and `false` pass on the calls; a route and a tool
  refuse a `Date`; every old form compiles); `engine/src/timeouts.test.ts` (an hour's `timeout`,
  `Date`, `deadline` or `timeoutMs` in a `parallel` in a stage is cut to the parallel's; one in a
  stage to the run's, and `timeout: wf.deadline` is the run's; the old fields resolve to the new
  one's deadline; each family's old forms work and log once per call: agent calls, nudge,
  parallel, decide, tool, keepAlive, route, `wf.deadline`, a test's options and a send; both forms
  refused; a tool's `timeout: false` at run time; a `Date` already past fails `open` and `decide`
  with `DeadlineExceededError`); `decisions.test.ts` (a decision's `timeout` times out as a
  `deadline` did). A stage has no deadline of its own (it takes the run's), so "cut to the
  stage's" is proved through a `parallel` inside one.
- Unverified: a fork's `timeout` cutting a slow native fork short (the code passes the bound to the
  same `deadlineWithin(FORK_TIMEOUT_MS, …)`; no test makes a fork slow); `keepAlive.window` is
  proved through `checkedKeepAlive` and the window `timeoutMs` already had, not a live check.

### Task 6

- **How the two forms are told apart.** By the count of arguments, then by the second's kind,
  never by its keys. Three arguments are always the deprecated `(workflow, args, options)`. With
  two, the second is the options when it is an object (not `null`, not an array), and args
  otherwise: `null`, a string, a number, a boolean or an array, the deprecated
  `(workflow, args)`. So a workflow's object args are never guessed at: given second they are the
  options, and refused by their first key. The types say the same: the one form's overloads take an
  object; the deprecated three-argument overload takes any args; the deprecated two-argument one
  takes only `Args extends null | string | number | boolean | JsonValue[]`, so object args there
  fail `tsc` instead of compiling into a run-time refusal. Rejected: telling options from args by
  their keys, which a workflow's args can share (`feature-delivery`'s args have `runtimes`, a test
  option, and its test spread them with it).
- **Changed without a deprecation:** `testWorkflow(workflow, args)` with object args and no
  options. It was the one call the two forms can't both mean; it now fails `tsc` and is refused
  at run time naming the key, and the testing reference says so beside its deprecated table.
- **`args`** is required by type where the workflow has no events and `null` is not among its
  args; with events it stays optional, as a run an event starts has no argv. Absent, the run gets
  what `prepare` makes of no argv, for every workflow, as `awf run` given none; a `prepare` that
  throws then fails the test, saying to give `args`. `id` is `"test"` unless given, for every
  workflow, checked as `awf run --id` checks it.
- **One options type.** `TestOptions<Args, Events>`: bare (`Args = never`) it is what any test may
  share, with no `args`, so a helper's `const shared: TestOptions` is passed or spread into any
  test, which adds its own `args`. `event` and `events` are typed only with events and refused at
  run time without. `EventTestOptions<Events, Args>` is a deprecated alias; a type can't log.
  `EarlierAttempt` is the new published name for `earlier`'s shape.
- **Unknown keys** are refused before anything runs, naming the key and the options there are;
  the deprecated keys are taken, never suggested. `earlier`'s own keys are checked too.
- **`earlier: { stages, mailbox }`** for every workflow, both making the attempt the continue,
  attempt 2. `recorded` and `mailbox` are deprecated (`test-recorded`, `test-mailbox`), logged
  once, and refused beside their `earlier` form. A workflow with events now takes `fromStage`
  with `earlier`, as `awf run` takes `--from-stage` with `--continue`, and redoes the stage (task
  3 left this to these options); without `earlier`, and `values`, are refused with `awf run`'s
  reasons.
- **`maxTurns`** counts every run's started turns (not nudges or wakes) in the test's own
  `onTurnStarted`, out of `ScriptedEvents`; 20 by default, so a plain loop past 20 turns now fails
  where it ran to `awf test`'s timeout.
- **Bare `{ meta, run }`.** The one form takes only what `defineWorkflow` made, checked at run
  time by `kind` too, so no published signature names the engine's `RunnableWorkflow`. The
  deprecated forms still take `meta` and `run` alone, typed inline from the contract's `Workflow`,
  as they did; that goes with them in task 10. `minimum-review`'s `createMinimumReview` now returns
  a workflow `defineWorkflow` made, with a `prepare` of its own; `catalogue-review`'s tests already
  went through `defineCatalogueReview`, so its body stays a `Pick`, spread into `defineWorkflow`.
- **The engine's own tests** build bare `{ meta, run }` workflows throughout, so they call the
  internal `runTest(workflow, options, engine?)`, which keeps taking them; `testWorkflow` is
  `testCall` (the form, the `kind` check, the deprecation) then `runTest`. Tests of the call itself
  are `workflow-testing/test-options.test.ts` and `deprecations.test.ts`.
- **Where testing's list lives.** One list, the engine's `workflow-testing/index.ts`, which
  `awf test`'s preload serves and the engine can reach; `agentswf/testing` is `export *` of it, as
  `agentswf/workflow` is of the contract's `author.ts`. A second, hand-kept list in `agentswf`
  was rejected: two lists drift, and types can't be compared by name.
- **The options are an object literal** (its prototype `Object.prototype` or `null`); a `Date`,
  an array or a class's instance is refused, named. Their keys are checked before whether the
  workflow is what `defineWorkflow` made, so object args given second are named by their key
  whatever the workflow, and the message adds that args are given as `{ args }`.
- **Args `prepare` makes** for a test that gives none are checked as `awf run` checks them
  (`assertJsonValue`, `{name} arguments must contain only JSON values`): a `Date` or a `Promise`
  is refused, and that or a throw fails the test saying to give `args`.
- **A given `earlier` is always the continue**, attempt 2, even `{}` or with only `undefined`
  fields, as the docs say.
- **What the run-time rule lets through:** object args whose keys are all option names (`{ id }`)
  are read as options; `tsc` catches the missing `args` unless `null` is among the workflow's
  args. And `testWorkflow(wf, undefined, options)`, the deprecated form with `undefined` args,
  now gives the run what `prepare` makes of no argv, where it gave `undefined`.
- Proof: `test-options.test.ts` (args as an option and from `prepare`, `id`, a misspelled option
  and `earlier`'s, object args given second, `event` without events, bare `{ meta, run }`,
  `maxTurns` at and past its bound on a plain run, `earlier: { stages, mailbox }` reused on a run
  with events, `fromStage` redoing a stage of one, both forms refused, `earlier: {}` with
  `fromStage` on a run with events and `earlier.stages` on a plain one as attempt 2, `values`
  refused with events, `fromStage` and `values` alone on a plain run, `prepare`'s `Date`,
  `Promise` and throw refused saying to give `args`, a `Date` or class instance as options, object
  args given second to bare `{ meta, run }` named by key); `deprecations.test.ts` (the
  three- and two-argument forms and bare `{ meta, run }` work and log `test-args` once, `args`
  given twice refused, `recorded` and `mailbox` work and log once each);
  `packages/agentswf/src/testing.typecheck.ts` (missing `args` is a type error, as are object args
  second, a misspelled option, `event` without events, bare `{ meta, run }` in the one form; args
  of `null | { x }` optional, array args required, and given second in the deprecated form; the
  deprecated forms compile). Every example test, the `awf init` template's and the site's samples
  use the one form, rewritten by a codemod and checked by `tsc`.

### Task 7

Plan, settled before coding:

- **The mailbox keeps awf's record names; the runner presents the declared one.** A reply is
  still appended as `participant:reply` and an end as `agent:ended`, each `from` its key, and every
  take and match works on those, as today. What the code is handed, by `receive`, `race`, `select`
  and a stage's batch, is the event under `{from}:reply` or `{from}:ended` when the workflow
  declares that name, and under the old name otherwise. `matches` reads a presented name as its
  record name, so `agent.is(e)`, a turn's `is` and `branchOf` work on either. No record changes,
  and a run parked across the upgrade, or an end a later attempt recovers, has one spelling.
  Rejected: appending the declared name. Each writer (the CLI, recovery, a test) would read the
  definition to choose it, and a reply or end appended under the old name before the code
  declared the new one would be under the other: two spellings of one event in one record, which
  the matching would have to fold anyway.
- **Declaring.** `events` takes `{key}:reply: ParticipantReply` and `{key}:ended: AgentEnded`,
  split at the one colon, the key without one. `ParticipantReply` and `AgentEnded` are values in
  the contract, plain JSON Schema object literals (pure; no TypeBox), each with a type-only brand,
  and still the types they were. `DeclaredEvents<Events>` replaces `NoColonNames` in
  `defineWorkflow`: any other colon name, or an awf name with another schema, is `never`, so `tsc`
  refuses it. At load, `eventWorkflowProblem` refuses the same for a file `tsc` never saw (the
  schema compared by `canonicalSchema`), and an awf name in `starts`. `starts`, `wf.emit` and
  `started` take only the workflow's own names. `wf.signal("thread:reply")` is a source of that
  participant's replies, the way to race one now that a `ParticipantRef` is not a source; like any
  signal it hands back the whole event.
- **`ParticipantRef` is `post` and `release`** for every participant. `CodeParticipantSpec`,
  `CodeParticipantRef` and `CodeParticipantDirectory` are `@deprecated`, as is `connect`'s
  `to: "code"` overload. `is(e)` on a participant is `@deprecated` and logs `participant-is`.
- **The transition** (the deprecation rule: what works today keeps working for a beta, logged):
  - `to: "code"` with `{key}:reply` declared works as the declaration alone, logging `to-code`.
  - `to: "code"` without it, in a workflow that declares no `{key}:reply` at all: as today, its
    replies presented as `participant:reply`, logging `to-code` with the name to declare. In a
    workflow that declares some `{key}:reply`, it throws, naming the declaration: that workflow
    has moved to the new form, and nothing written before this task can declare one (a colon name
    failed `tsc` and the loader).
  - `start()` with `{key}:ended` declared: the end is presented under it. Without, in a workflow
    that declares no `{key}:ended` at all: as today, presented as `agent:ended`, logging
    `undeclared-ended` per key. In a workflow that declares some `{key}:ended`, it throws.
  - So the Done-when's "start() throws" holds for every workflow that declares an end, and is a
    deprecation for one that declares none, which task 10 turns into the throw. **Decision for
    review**: the story says it throws outright; that would break every workflow with events that
    calls `start()` today (the Datadog watcher's investigator, the sketches) with no beta between,
    against the deprecation rule.
  - The record `participant-connected` keeps `to: "code"`, now for a participant whose replies go
    to the code by either form, so `awf logs` and `awf send --event-id` read it as before.
- **`awf emit {ref} {name} [{json}] [--event-id {id}]`**: the run found by its ref as `awf send`
  finds one (here, then the projects awf knows), the event checked against the definition in the
  file its last attempt ran, as a wake would run it, and delivered by `deliver`. It never starts a
  run. `{key}:reply` must be declared, else refused (exit 2) listing the declared names, and its
  data must fit `ParticipantReply`; it is appended as `participant:reply` from `key`, its id the
  `--event-id` given (the message's own id, so a resend is a duplicate) or awf's random one. An
  `{key}:ended` is refused: only awf sends one. The `--target --id` form takes `{key}:reply` too,
  never as a start. `wf.emit` refuses every colon name: a run speaks for no participant.
- **`awf send --event-id`** forwards: it prints that it is deprecated once on stderr, naming the
  `awf emit` command, then delivers through the same function: as `{as}:reply` when the run's
  definition declares it, else as before for a participant connected `to: "code"`, else refused
  `no-participant`. Its output and exit codes stay `send`'s, which existing callers parse.
- **A route's `timeout` on any route.** The refusal goes; a question to an agent closes unanswered
  after the route's timeout as one to an outside participant does, the asker's shorter `--timeout`
  winning. Records unchanged (`timeoutMs`).
- **Tests' scripted events** take `{ during, name: "thread:reply", data }`, checked as `awf emit`
  checks one. `{ name: "participant:reply", from }` still works, logging `test-participant-reply`.

Proof: an e2e test (a workflow declaring `thread:reply`, replies by `awf emit {ref}`, live and
parked, received under that name; an undeclared participant's reply refused listing the names;
data that doesn't fit refused); the old e2e test kept for `awf send --event-id`, which now also
logs its replacement; runner tests for each transition branch and for `{key}:ended` received
under its name; a workflow-testing test for both; a messaging test for an agent-to-agent route's
timeout; the typecheck fixtures for the declarations.

As built:

- **Where the name changes.** `sources.ts` holds both directions: `presented(event, declared)`,
  applied once, to what `#holdingWait` returns, so `receive`, `race`, `select` and a stage's batch
  all hand back the declared name, and to the batch a reused stage around a wait returns
  (`batchOf`), so no path hands out a record name for a declared one; and `recordName(event)`,
  which `matches` reads, so a take recorded as `agent:ended` from `fixer` takes `fixer:ended` too.
  A signal is marked when made (`signalOf`), and a race's or select's branch on one hands back the
  whole event, where an agent's or timer's hands back its data, as before.
  `wf.signal("{key}:reply")` takes `{ name: "participant:reply", from: key }`;
  `wf.signal("{key}:ended")` fails `tsc` and throws, pointing to the agent as the source: one way
  to wait on an end.
- **Types.** `AgentEndedEvent` keeps the name `agent:ended` (deprecated); a declared end is one of
  the workflow's own events, so a misspelled `e.name === "fxier:ended"` fails `tsc`. `agent.is(e)`
  narrows to `e`'s own type intersected with `AgentEndOf<E, Meta, T>`: for one of a run's events,
  the agent's end under either name, the declared `{key}:ended` or `agent:ended`; for an event
  typed loosely (`WorkflowEvent<string, JsonValue>`, `EventLike`), to `AgentEndedEvent` as before
  the task, so code that hands it to a function taking `AgentEndedEvent<Batch>` still compiles.
  Given explicit type arguments, `is<Batch>(e)`, `E` can't be inferred and it narrows as before
  too, which for a declared end types its name as `agent:ended` while it arrives as
  `{key}:ended`: accepted, as at HEAD. A deprecated `CodeParticipantRef.is` narrows the same way
  (`ParticipantReplyOf<E>`), so with `{key}:reply` declared beside `to: "code"` the narrowed name
  is `{key}:reply` or `participant:reply`, not a lie. The deprecated `connect(CodeParticipantSpec)`
  overload comes first (a second declaration of `ParticipantDirectory`, whose members merge
  ahead), so a `to: "code"` spec held in a typed variable still gets a `CodeParticipantRef`.
- **Schema identity by `$id`.** `ParticipantReply` and `AgentEnded` carry `$id`
  `agentswf:ParticipantReply` and `agentswf:AgentEnded`. `tsc` (through the schema types) and the
  loader (`eventWorkflowProblem`) accept an awf name only with that `$id`, since the workflow's
  installed `agentswf` may be another version than the awf loading it. A reply's data is always
  checked against the engine's own `ParticipantReply`, never the workflow's copy. Rejected:
  comparing the schema's canonical JSON with the engine's, which a version bump of either would
  break.
- **Checks.** `start()` asks its agent's `turns.checkDeclared()` before anything is recorded;
  `connect` checks `to: "code"` as above. Both read the run's `declared` set, which the runner
  already held for `signal`. For a key with a colon, the throw and the deprecation say to rename
  the key (`fix:er` to `fix-er`), not to declare `fix:er:ended`.
- **`awf emit`.** The ref form, `emitToRun(status, event, context)` in `emit.ts`, takes only
  `{key}:reply` (design §7): it loads the run's last attempt's file (or `run.json`'s), refuses one
  that is no longer that workflow with events, checks the event (`checkEvent` with `replies` on),
  and delivers through `deliverReply`. It checks the definition alone, not whether the participant
  has connected: one sent before the run connects it waits in the mailbox for the next wait. The
  `--target --id` form and `wf.emit` take only the workflow's own events; a `{key}:reply` there is
  refused, pointing to the ref form. A run whose file no longer declares the reply refuses it
  (exit 2); one whose file is gone fails to load (exit 1).
- **`awf send --event-id`** keeps its beta behaviour: a participant the run never connected is
  refused `no-participant` (exit 1), as before; one the run recorded as connected `to: "code"`
  (declared or the deprecated form) gets the reply through `deliverReply` without loading the
  workflow file, as before; any other connected participant goes through `emitToRun`, and any
  error from it, a file that won't load included, becomes `no-participant` (exit 1) with the
  reason, as that case was refused before. It prints its replacement on stderr once.
- **Testing.** A scripted `{key}:reply` goes through `checkEvent(workflow, event, true)` and is
  built by `replyRecord`, the one writer `awf emit` uses too; no `author` is filled in (the old
  form still fills `engineer`).
- **Docs.** The coordinator skill (`packages/engine/skills/awf-coordinator/SKILL.md`) teaches
  `awf emit {ref} {key}:reply … --json`; `records.ts` says the mailbox keeps `participant:reply`
  and `agent:ended` as its names for good (task 10 doesn't remove them), and that `post` is to any
  participant.
- **Route timeout.** `Messaging.grant` no longer refuses it; `#ask` takes the route's limit for
  any recipient, and sets `closes` for any, so a question to an agent ends `timed-out` with "the
  question closed unanswered after …". `openQuestions` and `awf inbox` still list only outside
  participants'.
- **Examples.** `approval-reminders`, `nudges`, the site's `testing-api` and `workflow-api`
  samples and `event-sketches/dd-case` declare `{key}:reply` (and the sketch and the guide's
  race `{key}:ended`) and race `wf.signal(…)`; their tests script `{ name: "{key}:reply" }`.
  `site/patterns/review-on-event` is left on the deprecated `start()`: it opens `reviewer#2`,
  `reviewer#3`, … after a failed turn, keys the code makes, which no fixed `events` can declare
  without the `*:ended` wildcard the design dropped. **Open for task 10**: such a workflow either
  reuses one key (a closed key can't be reopened today) or declares a bounded set; task 10's
  refusal breaks it otherwise.
- Proof added after review: a declared reply taken in a stage around `receive`, then reused by
  the next attempt, has the same name (`deprecations.test.ts`); an undeclared participant's answer
  reaches the asking agent with no mailbox event (`event-testing.test.ts`); `awf emit {ref}` to a
  run whose file no longer declares the reply (2) or is gone (1), an own event by ref and a reply
  by `--target` refused, and `send --event-id` for a declared participant never connected refused
  (`participant-e2e.test.ts`); `wf.signal("{key}:ended")`, a colon key's `start()`, and the
  misspelled end and signal of an end in the typecheck fixture.
- **Live check to return to** (one cheap model turn; not run): the approval example, started by
  an event and approved by a declared reply:

  ```sh
  awf emit --target examples/approval-reminders/workflow.ts --id doc-1 doc.submitted \
    '{"doc":"doc-1","remindEvery":"1m","expiresIn":"10m"}'
  awf emit approval/doc-1 approvals:reply '{"text":"approved","author":"dana"}' --event-id m1
  awf runs approval/doc-1   # completed, { ended: "approved", by: "dana" }
  ```

### Task 8

- **Durations on the CLI.** `parseDuration(value, flag, deprecated)` (`engine/src/duration.ts`)
  reads contract's grammar through `positiveDurationMilliseconds`, for `awf run --timeout` and
  `awf test --timeout`. Before, `--timeout` took a whole number with `ms`, `s`, `m` or `h`; the
  grammar drops `ms`, so a whole number of `ms` is still read until 0.1.0, logged `duration-ms`
  on stderr with its replacement (`500ms` → `0.5s`). `parseWait(value, max, deprecated)` reads
  `--wait` for `awf logs` and `awf inbox` (`awf inbox --wait` took bare seconds too, so it moved
  with `logs`): a duration up to `5m`, `0s` allowed; a bare decimal is still seconds, logged
  `wait-seconds` (`--wait 90` → `--wait 90s`). A form `Number()` read and the grammar doesn't,
  such as `1e2` or `" 5"`, is now a usage error. The `next:` commands print `--wait 90s`; the
  coordinator skill passes `--wait 100s`. Both CLI deprecations are said once per invocation, as
  `send-event-id` is. `run.json`'s `flags.timeout` keeps the text as given.
- **`wfa`'s parser** uses contract's `durationMilliseconds` (rule 3 allows contract), and keeps a
  whole number of `ms`, with its own deprecation line on stderr: it can't import the engine's
  list. So `--timeout 1.5s` and `2d` now work in `wfa waiting` and `wfa send --await-reply`.
- **The state table (wire 6).** `PEER_STATES` is exported from `wire.ts` with `PeerState`;
  `PeerView` is `{ peer, can, queued, purpose }` and either `{ kind: "agent", state, awaits?,
  reason? }` or `{ kind: "participant" }`, with no `state`. `awaiting` became `awaiting-reply`;
  `SEND_CODES` and `REPLY_CODES` say `already-awaiting`; `PARTICIPANT_CODES` say `peer-stopped`.
  The `wfa peers` table prints `awaiting-reply from you` and `participant`. The messaging gate's
  internal `kind: "awaiting"` (not on the wire) is unchanged.
- **Agent states in `awf runs {run} --json`.** `AGENT_STATES` and `AgentStateJson` in
  `records.ts`, from what `run-view.ts` produces: `idle`, `working`, `waiting` and
  `awaiting-reply` (a running turn's liveness phase, which becomes the state, as `wfa peers` and
  the human line say it; `live` keeps the reason, peer and times), a `TurnOutcome`'s kind
  (`answered`, `unanswered`, `blocked`, `timed-out`, `failed`, `cancelled`), `failed` for an
  `operation-failed`, `stopped`, and `interrupted`, which replaces `was working` (the word a stage
  already used for the same case). `records.typecheck.ts` pins the set both ways to the outcome
  kinds plus those lifecycle words. `stages[].state` is `STAGE_STATES` / `StageStateJson`
  (`running`, `interrupted`, `reused`, `provided` and the `StageOutcome`s), pinned the same way.
  The human `awf runs` line prints the state; one awaiting a reply adds `from {peer}`.
- **Holder refusals before the socket.** `awf reply`/`awf send` refuse a `--to` that isn't
  `{attempt}.{n}`, a blank `--as` and a blank agent as usage errors, so a request this awf makes
  is one the run decodes; the no-answer message says the run is *most likely* an older awf, since a
  closed socket has other causes.
- **`wfa`'s `ms` notice** is said only when the legacy form was taken (never beside a usage
  error), and comes from the flag the parser read, not the first `--timeout` in the arguments.
- **JSON `v` 2, minimal:** `ParticipantResultJson` (`awf reply --json`, `awf send --json`, and
  what the coordinator socket answers), for `peer-stopped` and the new `unsupported-version`; and
  `RunJson` (`awf runs {run} --json`), for its agent and stage states. Unchanged at 1: `awf runs --json`
  (the list has no agent states), `awf logs --json` (its `next` now says `90s`, a command, not a
  word for a state), `awf inbox --json`, `awf emit`, `awf tick` and `awf allowance`. `wfa peers
  --json` has no `v`: the wire version is its version. No record format changed.
- **How an old `wfa` meets a new engine.** Same machine, two processes: a headless or TUI agent's
  launcher runs `bun {engine}/agent-cli/cli.ts` from disk, and a sandboxed agent's `wfa.js` is
  bundled from that file when the agent opens, while the run's engine is the code it loaded when
  the attempt started. They differ only when awf is installed anew in place while a run is live:
  an upgrade gives a new `wfa` and an old engine, a downgrade the reverse. Both are now clear:
  - An old `wfa` (4 or 5) to this engine: the engine answers `unsupported-version` *in the
    request's version*, `{ version: 5, kind: "rejected", … }`, which a version 4 or 5 decoder
    accepts (its rejected shape is unchanged since 4, checked in git), so it prints `this wfa
    speaks wire version 5 and the workflow engine 6: … Nothing was done`. No `owing` is added.
  - This `wfa` to an older engine: the old engine answers in its version; the decoder's error
    now names both, `the engine answered in wire version 5 and this client speaks 6`.
  - The holder wire (`awf reply`, `awf send`, the nudge) is the same `WIRE_VERSION`. An older
    `awf` to this run is answered `unsupported-version` naming both, which an older `awf send`
    prints as any refusal; this `awf` to an older run is closed unanswered, as before, and now says
    the run is an older awf and names this one's wire version (it can't know the run's).
- Proof: `wire.test.ts` (every peer state and the participant kind decode, the old words and a
  participant with a state are refused, the renamed codes, both version messages);
  `control-plane.test.ts` (a version-5 result is refused in version 5, naming both, nothing
  accepted); `client.test.ts` (a version-5 engine refused naming both); `coordinator-socket.test.ts`
  (a version-5 holder request); `runs-command.test.ts` (`interrupted` in the JSON, one of
  `AGENT_STATES`); `logs-command.test.ts` and `inbox-command.test.ts` (`--wait 90s`, `1.5m`, `90`
  with its line, out-of-range and malformed refused); `operator-cli.test.ts` (`--timeout 1d`,
  `1.5h`, `90s`; `0s`, `2w`, `0ms` refused; `500ms` ends the run with its deprecation line);
  `cli.test.ts` (`wfa` takes `1.5s`, `2d`, and `1500ms` with its line).
- Unverified: that a real version-5 `wfa` prints the refusal (proved against its decoder's code,
  not run); a real harness's `wfa` in a pane against a mid-run reinstall (a live check, not run);
  the path where this `awf send` meets an older run's socket has no test (it needs an engine that
  closes unanswered).

## Human review

- [ ] Every task is complete and story-level verification passes.
- [ ] Set the story status to `awaiting-human-review` and present the outcome, architecture
  decisions, task-level subagent findings and dispositions, exact verification results, deviations,
  and remaining risks.
- [ ] Record the human's explicit approval or requested changes here.
- [ ] If changes are requested, return to the affected task and repeat its review and verification.
- [ ] Only after explicit approval, mark the story `done` and update `Stories at a glance`.
