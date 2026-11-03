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
once per run with its replacement, and none survives into 0.1.0.

## Tasks at a glance

Betas from the design's §8 in brackets.

- [ ] 1. Unbuilt and unused names out, old forms deprecated, waits name the agent, `agentswf/workflow` an explicit list (A)
- [ ] 2. Testing's renames: `noAnswer`, `run.ending`, `eventId`, `TestTurn` (A)
- [ ] 3. One context type, and `--from-stage` for every run (B)
- [ ] 4. Agents: `CallerRef`, `runtime` on fork, `agent.close()` (B)
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

- [ ] Plan: inspect the relevant code and tests and record the architecture and focused proof.
- [ ] Implement: make only this task's coherent change and add focused tests with it.
- [ ] Review: obtain architecture/scope and correctness/proof subagent reviews of the actual diff.
- [ ] Resolve: disposition findings and obtain targeted re-review after material design changes.
- [ ] Verify: satisfy every `Done when` item before checking this task.

Work:

- Remove `wf.steps`, `wf.call`, `receive({ take })`, `wf.timers()`, `WorkflowDefinition`,
  `agents.attach` and `participants.get` (design §6).
- Deprecate agent `labels`, `meta.whenToUse`, a stage around `receive`, `isAnswered` and
  `defineExecutableWorkflow`, and the per-call `id` on `run`, `start`, `compact` and `set` (§2;
  the design gives this no beta, so it goes with the others here). Each logs once per run, naming
  its replacement.
- A wait names the agent; a turn passed to `race`, `select` or `receive` is deprecated, and the
  turn keeps `id` and `cancel()` (§2).
- One `WaitOptions` for `race`, `select` and `receive`, with `label?: string | (() => string)`.
- `agentswf/workflow` exports an explicit list of the names an author uses. The examples import it
  instead of `@agentswf/contract/workflow`.
- `output.json` gains `ref`.

Done when:

- A typecheck fixture shows each removed name fails to compile and each deprecated one compiles.
- A run test shows each deprecated name logs its replacement once per run, a turn in `race`
  included.
- An engine test reads `ref` from a finished run's `output.json`.
- `eventWorkflowProblem` and `placementOf` are not importable from `agentswf/workflow`.
- `bun test`, `bunx tsc --noEmit` and the boundaries pass. `examples/` import only
  `agentswf/workflow` and `agentswf/testing`.

### 2. Testing's renames

Outcome: in a test, `reply` only ever means answering.

Execution:

- [ ] Plan: inspect the relevant code and tests and record the architecture and focused proof.
- [ ] Implement: make only this task's coherent change and add focused tests with it.
- [ ] Review: obtain architecture/scope and correctness/proof subagent reviews of the actual diff.
- [ ] Resolve: disposition findings and obtain targeted re-review after material design changes.
- [ ] Verify: satisfy every `Done when` item before checking this task.

Work:

- `reply.*` becomes `noAnswer.*`, and `message.silent()`/`fail()` become returning nothing, or
  throwing (§5).
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

- One `WorkflowContext<Events = {}>` and one `AgentRef`. `EventWorkflowContext` and
  `EventAgentRef` become deprecated aliases.
- `signal`, `started` and `receive` take only declared names.
- `file` and a run id are required only with `starts`.
- **Structural:** `--from-stage` for a run with events reruns that stage and every later one; their
  earlier results move to `replaced/` as in a plain run.
- An agent's or participant's key with a colon is deprecated: it logs once, naming the key with
  `-` in place of each colon. The examples move to `-` (`reviewer-${lens}`, `worker-${name}`).

Done when:

- A workflow with no `events` races an agent against `"14d"` and typechecks. A misspelled signal
  name is a type error.
- An engine test continues a run with events `--from-stage {stage}`. It reruns that stage and the
  ones after it, keeps the earlier ones, and its record reads as a plain run's does.
- A run test shows `open({ key: "reviewer:security" })` logs the deprecation once, and no example
  uses a colon in a key.
- The 034 and 037 example tests pass unchanged apart from the type names.

### 4. Agents

Outcome: an agent's ref is the one handle for its turn, its runtime and its end.

Execution:

- [ ] Plan: inspect the relevant code and tests and record the architecture and focused proof.
- [ ] Implement: make only this task's coherent change and add focused tests with it.
- [ ] Review: obtain architecture/scope and correctness/proof subagent reviews of the actual diff.
- [ ] Resolve: disposition findings and obtain targeted re-review after material design changes.
- [ ] Verify: satisfy every `Done when` item before checking this task.

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
- The three-argument form is deprecated.

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

## Readiness

- [x] Outcome and boundaries are concrete.
- [x] Relevant implementation, callers, and tests are mapped.
- [x] Evidence and research support the proposed design.
- [x] Expensive interface, record-format, and stage-gate decisions are settled.
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
