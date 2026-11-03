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
- [ ] 5. One duration and `timeout` in the API (B)
- [ ] 6. One `testWorkflow` signature (B)
- [ ] 7. Participants routed to the code declared in `events`; a reply to the code by `awf emit` (C)
- [ ] 8. Durations and one word per state on the CLI and the wire (D)
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

- [ ] Plan: inspect the relevant code and tests and record the architecture and focused proof.
- [ ] Implement: make only this task's coherent change and add focused tests with it.
- [ ] Review: obtain architecture/scope and correctness/proof subagent reviews of the actual diff.
- [ ] Resolve: disposition findings and obtain targeted re-review after material design changes.
- [ ] Verify: satisfy every `Done when` item before checking this task.

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

- [ ] Plan: inspect the relevant code and tests and record the architecture and focused proof.
- [ ] Implement: make only this task's coherent change and add focused tests with it.
- [ ] Review: obtain architecture/scope and correctness/proof subagent reviews of the actual diff.
- [ ] Resolve: disposition findings and obtain targeted re-review after material design changes.
- [ ] Verify: satisfy every `Done when` item before checking this task.

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

- [ ] Plan: inspect the relevant code and tests and record the architecture and focused proof.
- [ ] Implement: make only this task's coherent change and add focused tests with it.
- [ ] Review: obtain architecture/scope and correctness/proof subagent reviews of the actual diff.
- [ ] Resolve: disposition findings and obtain targeted re-review after material design changes.
- [ ] Verify: satisfy every `Done when` item before checking this task.

Work:

- `--timeout` and `--wait` take a `Duration`. A bare number for `--wait` still means seconds
  until 0.1.0.
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

## Human review

- [ ] Every task is complete and story-level verification passes.
- [ ] Set the story status to `awaiting-human-review` and present the outcome, architecture
  decisions, task-level subagent findings and dispositions, exact verification results, deviations,
  and remaining risks.
- [ ] Record the human's explicit approval or requested changes here.
- [ ] If changes are requested, return to the affected task and repeat its review and verification.
- [ ] Only after explicit approval, mark the story `done` and update `Stories at a glance`.
