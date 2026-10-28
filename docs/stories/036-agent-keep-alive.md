---
id: "036"
title: "An agent stays live after its turn, and compacts before the run parks"
summary: "An agent opened with keepAlive keeps the run live for a while after its last turn, so a follow-up is a warm turn in the same pane; when its window passes, its onTimeout handler can compact it with a focus written then, while the cache is warm. The run parks once every window has passed and its handlers have run."
type: story
status: ready
depends_on: ["034"]
---

# An agent stays live after its turn, and compacts before the run parks

## Outcome

[[034-event-driven-runs|Story 034]] parks a run as soon as it waits with no turn running, and
wakes it on its agents' kept sessions. That works, but the Datadog watcher shows two costs:

- **Every message opens a pane.** A reply in a case's Slack thread wakes the parked run, the
  investigator resumes its session in a new pane, answers, and the run parks again and closes it.
  A conversation of five messages is five panes, five claude starts and five resumes.
- **Every wake reads the whole session.** A resumed session reprocesses its whole context. Past
  the prompt cache's hour, claude writes it all to the cache again
  ([`resume-after-hours.md`](../findings/resume-after-hours.md), H3: about 13 times a warm resume).
  An investigator that has grown over weeks pays that on every wake.

After this story, an agent opened with `keepAlive` keeps the run live for a while after its last
turn: the run doesn't park, its panes and processes stay, and a message in that window is a warm
turn in the same pane. When the agent's window passes, its `onTimeout` handler runs while the
cache is still warm: it can compact the agent with a focus written from the state as it is then,
run a wrap-up turn, or do nothing. Once every window has passed and its handlers have run, the run
parks as today, and the next wake resumes a session a fraction of the size.

## How it works

```text
 turn ends ──► window open (timeoutMs) ─────────────────► window passes, at a wait
                 │ the run stays live: every pane and      │ onTimeout(agent), if given and due: e.g.
                 │ process; a reply: nudged, a warm turn   │   agent.compact({ prompt: focusFor(…) })
                 │ in the same pane, its end a new window  │ the pane stays; the agent is still usable
                 ▼                                         ▼
           receive() returns it                  no window open, no handler due → parked, as in 034
                                                 next wake: --resume on the compacted session
```

```ts
const investigator = await workflow.agents.open({
  key: "investigator",
  runtime: "claude",
  instructions,
  keepAlive: {
    timeoutMs: 60 * 60_000, // the default
    // Written when the window passes, from the case as it is then.
    onTimeout: async (agent) => {
      await agent.compact({ prompt: focusFor(kase.view()) });
    },
  },
});

const focusFor = (kase: CaseView) =>
  kase.closed()
    ? "The case is closed: keep why, and what would reopen it; drop the investigation's detail."
    : "Keep the findings, the hypotheses ruled out and the thread's open questions; drop raw logs.";
```

- **An agent's window** runs for `timeoutMs` from the end of the last turn it ran in this attempt:
  awaited, started, or a message from a peer. A turn that never reached the harness, refused or
  cancelled while queued, opens none; nor do a compaction, a `set`, a fork, a turn's end a crash's
  recovery wrote, or any turn begun inside a handler. So a wake that only takes an event opens no
  window. An agent that closes has no window and its handler isn't called: a turn that fails, is
  cancelled or times out closes it, as `agents.stop` and a cancelled stage do.
- **The handler is due** once the agent's window has passed, the agent is idle with no started
  turn, and a turn that opened a window has ended since the handler last ran. What a handler runs
  on its own agent never makes it due again, so a wrap-up turn can't loop it. A message the
  wrap-up sends a peer is that peer's ordinary turn and opens its window; two kept agents whose
  handlers message each other can keep a run live, as two agents messaging each other can today.
- **The run stays live** while any agent's window is open or a handler is due or running. Every
  agent stays with it, with `keepAlive` or not: nothing is released alone. The run parks when the
  wait has nothing to take, nothing works, no window is open and no handler is due, as in 034, and
  every pane closes with the attempt.
- **Handlers run at a wait, and the wait awaits them.** At a wait with nothing to take and nothing
  else working, the wait calls the due handlers one by one, reading the mailbox again before each:
  an event there is returned first, and its turn opens a new window instead. A window that passes
  while the code or another agent works is handled at the next wait where nothing does. Two agents' windows pass each on its own clock;
  the run parks after the later. Between windows the wait sleeps to the earliest window's end, as
  to an `until`, without polling.
- **The handler** gets the agent's ref and runs in the wait's scope, as the code at that wait
  would: in a stage, `start()` is refused there as anywhere out of the run's root, and a cancelled
  stage cancels the handler's operations with the rest of the scope. `timeouts()` takes the wait's
  signal: once the run stops or the wait's scope is cancelled, it calls no further handler and
  stops waiting on the one running. Its operations are recorded
  and costed as any. The agent stays live and usable after it. The code never runs beside a
  handler, since the code is waiting; an event that arrives meanwhile is returned once the handler
  finishes, and a `receive()` in it is refused by the rule for every wait: one at a time.
- **A turn the handler starts** ends as any started turn does, as `agent:ended` the loop takes:
  the code tells it from its own by the `meta` it gave.
- **A handler that throws** is logged and doesn't fail the run; the handler is not due again until
  a new turn, and the run parks anyway. A compaction that answers `failed` leaves the agent's
  context as it was.
- **On an agent whose session isn't kept** — with skills or a sandbox, on a harness the code now
  changes, or in a nested call — the next wake starts it afresh, so a compaction in its handler
  buys nothing; the open logs that, as it logs a session not reopened.
- **On a headless agent** there is no pane to keep: each headless claude turn is a process of its
  own, and the window keeps the run's process. A wake within the cache's life resumes warm anyway;
  there the window buys only the compaction's timing and skipping the wake.
- **On a reopen** of the same key in an attempt, `keepAlive` takes the new spec, as tools take the
  new handlers; left out, the agent keeps what it has. A fork has no `keepAlive`.
- **Without any `keepAlive`** a run parks as 034 built, at the first wait with no turn running.

## Scope

In scope:

- `keepAlive: { timeoutMs?, onTimeout? }` on the open spec of a workflow with `events`, whose runs
  park: a type error elsewhere, and refused at open for a workflow `tsc` never saw;
- the parking rule: no park while a window is open or a handler is due or running; the wait sleeps
  to the earliest window's end;
- `onTimeout` at a wait once its agent's window passes, awaited by the wait, in its scope;
- the run's terminal output saying when a run in a window parks: "live until {time}" (Q3);
- `testWorkflow`: an event scripted after a turn ends, which the window's tests need, a published
  change to `ScriptedEvent`;
- the Datadog case run's investigator, as the proof;
- the ADR 034 owes for kept sessions, with this story's window.

Out of scope:

- releasing one agent while the run stays live, its pane closed and its session resumed in a new
  pane at its next turn ([[agent-release]]): the harness refuses a session whose pane closed (ADR
  0008), and no workflow yet has a second agent beside a kept one;
- compacting on size: the harness's own compaction when the context fills goes on as now, and a
  compaction the workflow asks for past a size needs the size first ([[context-size]]);
- a virtual clock for workflow tests: the window's tests use a short real `timeoutMs`
  ([[workflow-test-virtual-time]]);
- `then: "fresh"`, an agent that keeps nothing between attempts: no workflow asks for it (ADR
  0001's rule); 034 already keeps every root agent's session;
- keeping a session through a crash: a continue after a crash opens agents on new sessions (034's
  Q17), and a long window makes a crash within it likelier; [[run-through-sleep]];
- a limit on live runs: twenty cases woken at once are twenty live windows (034 leaves the limit to
  `wake`).

## Context and evidence

- Fact: a run parks when its wait has nothing to take and the owner is idle:
  `WorkflowOwner.idle()` (`packages/engine/src/workflow-runner.ts:1129`), asked through the
  `Parking` seam (`packages/engine/src/mailbox.ts:223`, `idle` and `park`) by `RunMailbox.receive`'s
  park branch (`mailbox.ts:392-412`), which parks when idle and reads the mailbox each second when
  not (`mailbox.ts:416`). So the window stays out of `idle()`, which would poll for the window's
  hour: it is one step on the seam when the run is idle — call the due handlers, and say when the
  earliest window ends — and that end bounds the sleep as an `until` does.
- Fact: parking closes no single pane: it ends the attempt, and the owner's close closes every
  agent (`workflow-runner.ts:663`). This story keeps that: panes close only with the attempt.
- Fact: the sender's choice between nudging a live run and continuing a parked one is made under
  the run's lock (`emit.ts`, `wake.ts`), and the wait reads the mailbox again under the same lock
  before it parks (`mailbox.ts:401-406`): an event in the window, or during a handler, is never
  lost.
- Fact: a wake reopens each root agent on its last native session (`keptSessionsOf`,
  `workflow-runner.ts:4343`), without sending instructions again, and places a pane at the agent's
  first turn (`paneAtFirstTurn`). Measured live in 034's task 5 for claude in a pane and codex
  headless.
- Fact: a pane agent keeps its pane for every operation in an attempt (ADR 0008), so a turn taken
  by the same attempt runs in the same pane. A pane closed mid-attempt is never reopened
  (`packages/harness/src/adapters/herdr.ts:1360-1366`), which is why releasing one agent is out of
  scope.
- Fact: a crash's recovery writes a turn's failed end before the code runs (`recoverTurns`,
  `workflow-runner.ts:546`); it is no turn of this attempt, so it opens no window.
- Fact: an agent can't be compacted before its first turn in an attempt; the harness answers
  `failed` (`docs/workflow-api.md:685`, `herdr.ts:1352-1356`). A window opens only at the end of a
  turn that reached the harness in this attempt, and a turn whose pane never launched fails and
  closes the agent, so a handler never meets an agent before its first turn.
- Fact: a turn that fails, is cancelled or times out closes an opened agent
  (`closeAfterFailure`, `workflow-runner.ts:3120`); so do `agents.stop` (`agents.ts:499`) and a
  stage's cancellation (`workflow-runner.ts:3088`). A closed agent refuses every operation, so it
  can hold no window.
- Fact: a wait inside a stage carries the stage's scope: a `start()` there is refused, as root
  only (`workflow-runner.ts:2593-2597`), and work in it is cancelled with the stage. The stage
  can't end while its wait awaits a handler, so the handler runs in that scope like the code.
- Fact: while a turn the code started runs, its agent refuses `compact()`, `run()`, `set()` and
  `fork()` (`#refusedWhileStarted`, `workflow-runner.ts:2676-2684`): a handler is due only when
  the agent has no started turn.
- Fact: `compact()` answers a failure as an outcome (`docs/workflow-api.md`, compact); it rejects
  only for a closed agent or a passed deadline.
- Fact: an agent with skills or a sandbox, or reopened on another harness, starts afresh at a wake
  (`workflow-runner.ts:1605-1612`), and a nested call's agents keep no session.
- Fact: a handler in the open spec has a precedent: a tool's `handler` (`ToolSpec`, `agents.ts`).
  On a wake the code opens the agent again, so the handler is always the current code's.
- Fact: compaction is built for claude headless and pane, codex both ways and pi; cursor refuses
  ([[015-native-compaction|story 015]], [`native-compaction.md`](../findings/native-compaction.md)).
  Claude's `compact_boundary` row carries `preTokens` and `postTokens`.
- Fact: claude's cache lives 5 minutes, or an hour for the main conversation on a subscription
  ([`fork-cache.md`](../findings/fork-cache.md)); a claude resume past it costs about 13 times a
  warm one, and a day costs the same as two hours. Codex at 2 h was still cached. So 1 h is the
  default window.
- Fact: `awf runs` renders a run at its wait as its label and `until`
  (`packages/engine/src/runs-command.ts:161-167`, from the wait record, `run-state.ts:56-66`); it
  can't show when a window ends without the record saying so. The run's terminal draws
  `WorkflowRunSnapshot` (`workflow-runner.ts:326`, `progress-view.ts`): a row per agent, and no
  wait.
- Fact: `testWorkflow` runs on real timers, and a scripted event is sent only during a turn,
  `during: "{agent}#{n}"` (`workflow-testing/index.ts:142`); nothing sends one after a turn ends.
- Fact: today's watcher case run opens a pane per message: the operator saw it in Slack on
  2026-10-27.
- Constraint: `foundation.md` (§ on operations, "native session references never cross into
  workflow or engine-owned state as resume authority") predates 034, which made them cross for a
  run of a workflow with events without amending it. This story's ADR records the rule as built
  and amends the sentence.
- Constraint: ADR 0001 removed `AgentOpenSpec.lifecycle` and `RetentionPolicy` because nothing
  implemented them. `keepAlive` comes back with its implementation and the workflow that needs it,
  as 0001 asks. `foundation.md` §10's row "agent retention … pane release is measured (Story
  001)" is amended with it: no pane is released alone, so that precondition belongs to
  [[agent-release]].
- Constraint: ADR 0008, a pane agent keeps one pane for its operations: since 034 that holds per
  attempt. The ADR says so; this story changes nothing else in it.
- Assumption: a compacted investigator is much smaller (M1). The compaction's value rests on it;
  the window's doesn't, since it saves a pane and a resume per message (M3).

## Code map

### contract

- `packages/contract/src/workflow/agents.ts` — a new `EventAgentOpenSpec`, which extends
  `AgentOpenSpec` with `keepAlive`; `EventAgentDirectory.open` (`agents.ts:551`) takes it, and
  `AgentOpenSpec` is unchanged. `onTimeout` is given the agent's `EventAgentRef`.
- Records: none. What the handler runs is an ordinary compaction or turn in `turns.jsonl`;
  windows and whether a handler is due last one attempt, in memory; `awf runs` shows a run in a
  window as live and waiting (Q3).

### engine

- `packages/engine/src/workflow-runner.ts` — the logical agent keeps the end of its last turn in
  this attempt that opened a window and whether its handler is due; a handler's async context is
  marked, as a tool handler's is (`inToolHandler`), and `startMessageOperation` clears the mark as
  it clears the tool one (`outsideTools`, `workflow-runner.ts:3501`): a peer's message drained from
  the agent's queue during a handler is the peer's turn, not the handler's. Nothing else begun in
  it opens a window or makes a handler due; closing the agent drops its window; open refuses
  `keepAlive` outside a workflow with `events`. The snapshot's agent gains `liveUntil`, its
  window's end while one is open.
- `packages/engine/src/progress-view.ts` — an idle agent in a window shows "live until {time}" on
  its row (Q3).
- `packages/engine/src/mailbox.ts` — `Parking` gains `timeouts()`: when the run is idle at a wait
  with nothing to take, it calls the due handlers, the mailbox read again before each, and returns
  the earliest open window's end; the wait parks only when none is open, and otherwise sleeps to it.
- `packages/engine/src/workflow-testing/` — `ScriptedEvent` gains `after: "{agent}#{n}"`, sent once
  that turn ends, beside `during`; a compaction in the handler shows in `run.compactionsOf(key)`, a
  turn in it takes the agent's next scripted answer.

### harness

- Checked: no change. Nothing closes or reopens a pane mid-attempt; compaction and resume are
  built per harness.

### the watcher

- `agent/workflows/datadog-watcher/case.ts` (braintrust) — the investigator opens with
  `keepAlive` and an `onTimeout` that compacts with a focus from the case.

## Proposed design

```ts
export interface EventAgentOpenSpec extends AgentOpenSpec {
  keepAlive?: {
    /** How long the run stays live after this agent's last turn ends; absent, an hour. */
    timeoutMs?: number;
    /** Called at a wait once the window passes, if a turn ended since it last ran. */
    onTimeout?: (agent: EventAgentRef) => Promise<void>;
  };
}

// workflow-testing: exactly one of `during` and `after`.
type ScriptedEvent = { during: string } | { after: string } /* & name, data, id as today */;
```

The engine keeps, per logical agent, the end of the last turn in this attempt that opened a window,
and whether its handler is due. A window is open while `now < lastEnd + timeoutMs`. The wait loop
is as today until it finds the run idle with nothing to take; then it calls `timeouts()`, which
awaits each due handler in turn, reading the mailbox again before each and returning to the loop
if an event is there, and returns the earliest window still open. With none open the wait parks
as today; otherwise it sleeps to the earliest of an event, `until` and that window's end.

Alternatives rejected:

- **Releasing each agent at its own window's end**, its pane closed and the run live for others:
  only agents with `keepAlive` would be kept, but the harness can't resume a session whose pane
  closed, and ADR 0008 says why: a close doesn't prove the process gone. It needs a harness
  operation, a release that isn't a close, and a record of several panes per attempt; no workflow
  needs it yet ([[agent-release]]).
- **A `keepAlive` on the workflow or the wait**, `receive({ keepAlive })`: a second knob for the
  same window, and it doesn't say whose turns start it, so a side agent's quick turn would keep the
  run live as long as the investigator's. A version where the code tracks the window itself also
  compacted an agent after a crash's recovered end, before its first turn.
- **A `{key}:idle` event the loop handles**, as it handles `{key}:ended`: no callback, but a new
  event in a published format, and one left in the mailbox by a crash would reach an agent that
  can't compact before its first turn. The handler sits on the agent it is for.
- **A fixed `compact: { prompt }`**: the focus is written when the agent opens, before the turns it
  should summarise; a handler writes it from the state at the window's end, and can skip
  compacting or run a wrap-up turn first.
- **Refusing `start()`, `fork()` and `receive()` in the handler**, as the first draft did: the
  handler runs in the wait's scope, where the code's own rules already hold, a started turn's end
  reaches the loop as any does, and a second `receive()` is refused by the rule for every wait. No
  rule of its own is needed.
- **The handler beside the wait, not awaited by it**: events would be returned while it runs, and
  the code's next operations would race the handler's on the same agent.
- **The window in `idle()`**: the wait reads the mailbox each second while not idle, so an hour's
  window would be 3,600 reads; a bound on the sleep is one.
- **Compact after every turn**, with no window: pays a compaction per message in a conversation
  and gives up the warm follow-up, the cheapest case.
- **Compact at wake, before the new turn**: past the cache's life that compaction reads the whole
  context cold, the cost this story removes.

## Tasks at a glance

- [ ] 1. The contract and the ADR
- [ ] 2. The window and `onTimeout` at park, with tests
- [ ] 3. The Datadog case run, live

## Open questions

- Q1. **Names.** Decided: `keepAlive: { timeoutMs, onTimeout }`.
- Q2. **A default `timeoutMs`.** Decided: an hour, claude's cache life on a subscription.
- Q3. **Showing when a kept-alive run will park.** Decided: nothing is saved for it. `awf runs`
  shows the run as live and waiting, as today; the run's own terminal output prints
  "live until {time}" as it waits, on the row of each agent whose window is open.

## To measure

- M1. A real investigator session: tokens before and after compaction (`preTokens`,
  `postTokens`), and a cold wake of each.
- M2. A compaction at the window's end against one after the cache expired, on the same session.
- M3. A reply in the window reaches the live pane as a warm turn: cache read, no new pane.

## Task execution rule

Process one task at a time. Every task repeats the checklist shown under its details. Do not begin
the next task because the current implementation merely compiles: its design must be recorded, its
diff reviewed by subagents, findings resolved, and focused verification complete.

After all tasks are complete, run story-level verification and request human review of the complete
deliverable.

## Task details

### 1. The contract and the ADR

Outcome: `keepAlive` is in `EventAgentOpenSpec` and documented; the ADR records kept sessions and the
window, and amends foundation's sentence and ADR 0008.

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

- `EventAgentOpenSpec` with `keepAlive`, refused at open outside a workflow with `events`, and a
  `timeoutMs` that isn't a positive number refused;
- `ScriptedEvent`'s `after`, with its doc and `ScriptedEvents`' (`workflow-testing/index.ts:141`,
  `:607`), which say today every event is sent while a turn runs;
- `docs/workflow-api.md`; the ADR; foundation's sentence and §10 row, and ADR 0008, amended.

Done when:

- the type checks in an example, and fails `tsc` in a workflow without `events`; open refuses it
  there; the published surface, `keepAlive` and `after`, is stopped for the operator's review.

### 2. The window and `onTimeout` at park

Outcome: a run with a `keepAlive` agent stays live through its window, calls its `onTimeout` at a
wait once the window passes and a turn has ended since, and parks once no window is open and no
handler is due.

Execution:

- [ ] Plan: inspect the relevant code and tests and record the architecture and focused proof.
- [ ] Implement: make only this task's coherent change and add focused tests with it.
- [ ] Review: obtain architecture/scope and correctness/proof subagent reviews of the actual diff.
- [ ] Resolve: disposition findings and obtain targeted re-review after material design changes.
- [ ] Verify: satisfy every `Done when` item before checking this task.

Work:

- the window and the due rule in the logical agent; the handler marker; `timeouts()` on
  `Parking` and the wait's sleep to the window's end; the terminal's "live until {time}" line;
- `testWorkflow`: `after` sends a scripted event once its turn ends.

Done when:

- tests show: an event in the window is taken by the same attempt; the run parks once the window
  passes; the handler is called once, not again on a wake that ran no turn, and not after a crash's
  recovered end; a turn after it makes it due again; a turn it runs, awaited or started, opens no
  window and doesn't make it due; it isn't called while its agent has a started turn running; an
  event already in the mailbox when a window passes is returned before the handler runs; an event
  during the handler is returned once it finishes; a peer's message that reaches the agent during
  its handler opens a window; a stop during a handler ends the wait without calling the next; a
  handler that throws still parks; a turn that fails closes the agent, opens no window, and the
  run parks; two agents' handlers each run at their own window's end and the run parks after the
  later; a window that passes while another agent works is handled at the next idle wait; the
  wait in a window doesn't read the mailbox each second; the agent's row shows "live until
  {time}"; no `keepAlive` parks as today.

### 3. The Datadog case run, live

Outcome: the watcher's investigator keeps its pane through a conversation and wakes compacted.

Execution:

- [ ] Plan: inspect the relevant code and tests and record the architecture and focused proof.
- [ ] Implement: make only this task's coherent change and add focused tests with it.
- [ ] Review: obtain architecture/scope and correctness/proof subagent reviews of the actual diff.
- [ ] Resolve: disposition findings and obtain targeted re-review after material design changes.
- [ ] Verify: satisfy every `Done when` item before checking this task.

Work:

- `keepAlive` on the investigator in `case.ts`, with an `onTimeout` whose focus is written from
  the case;
- M1–M3 on a real case.

Done when:

- two replies in a thread within the window are answered in one pane; the run parks after the
  window with a compaction recorded; the next wake resumes it, and M1–M3 are recorded in a finding.

## Verification

Automated:

- [ ] the window and `onTimeout` tests of task 2
- [ ] `bun test`
- [ ] `bunx tsc --noEmit`
- [ ] `bun run scripts/check-boundaries.ts`

Manual or live evaluation:

- [ ] task 3 on a real case, claude in a pane on the subscription: one case's conversation and its
  next wake.

## Review record

### Task 1

### Task 2

### Task 3

## Readiness

- [x] Outcome and boundaries are concrete.
- [x] Relevant implementation, callers, and tests are mapped.
- [x] Evidence and research support the proposed design. (M1, the size a compaction saves, is
  measured in task 3; the window stands without it, and a poor M1 changes only the watcher's
  handler.)
- [x] Expensive interface, record-format, and stage-gate decisions are settled. (No record
  change.)
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
