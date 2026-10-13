---
id: "029"
title: Agents in a run message each other over routes the workflow grants
summary: "`workflow.messages.allow` grants routes with a purpose; agents use `wf peers`, `wf send [--await-reply]` and `wf reply`; a message reaches an agent at a turn boundary and wakes it if idle, an awaited reply continues the sender's operation, and the engine owns delivery, obligations, limits and the record."
type: story
status: in-progress
priority: P1
epic: authoring
discovered_in: "docs/design/messaging.md, settled with the user 2026-10-11"
depends_on: ["018", "021", "024"]
---

# Agents in a run message each other over routes the workflow grants

The design is [[messaging]] (`docs/design/messaging.md`). This story builds it and links to it
rather than copying it.

## Outcome

Agents in a workflow can talk to each other while they work, without workflow code passing text
between them:

- The workflow allows two agents to talk, and says what for. This is a *route*.
- An agent can list who it may talk to, send a note, or ask a question and wait for the answer.
- A message to an idle agent wakes it to deal with the message.
- The run's record keeps every message, every answer still owed, and what each wake cost.

Why now: stage 4 of [[foundation]] starts with messaging, because it touches every package. Today
`reviewLoop` in `examples/feature-delivery/reviews.ts` has to end the reviewer's turn, pass its
findings through code, and start the implementer again. With messaging the reviewer runs the loop
itself ([[messaging#Review until convergence]]).

## How it works

```text
workflow                 engine (control plane)                  agents
--------                 ----------------------                  ------
messages.allow  ──────>  route {from,to | between, purpose, max}
                                                                 reviewer: wf send --await-reply implementer
                         admit: route? limit? ─────────────────  (saved together with the owed answer)
                         reviewer's operation: waiting   <─────  reviewer ends its turn
                         implementer idle → message operation ─> implementer wakes, fixes,
                                                                 wf reply reviewer
                         answer recorded and queued ───────────> reviewer's same operation continues
                                                                 reviewer: wf result {call-id}
```

- **Routes.** `workflow.messages.allow` lets one agent message another (`from`, `to`), or both ways
  (`between`). Each route has a purpose, shown with every message, and an optional cap,
  `maxMessages`. A route made in a stage closes when the stage ends, and any route closes when
  either agent stops. Messages not yet shown by then are recorded `undelivered`.
- **Sending.** `wf send {peer}` returns as soon as the message is saved. It does not wait for the
  peer.
- **Asking.** `wf send --await-reply {peer}` also records that the peer owes an answer. The asker
  may keep working. If its turn ends without a result, its operation waits, and the answer
  continues that same operation, with the same call id. If the asker finishes with `wf result`
  instead, the question is dropped: withdrawn if the peer has not seen it, and otherwise a late
  answer is refused `expired`.
- **Answering.** Only `wf reply {peer}` counts as an answer. Until it answers, the peer cannot finish
  with `wf result` or ask for more time with `wf waiting` (both refused `owes-reply`). A turn that
  ends still owing gets one reminder. If it still has not answered, the owed answer fails, and the
  asker continues with a failure that says what to do instead ([[messaging#Finishing]]). The
  peer's turn ending that way is not a failure of its own operation.
- **Waking.** A message to an idle agent starts a *message operation*: an operation whose only job
  is the message. It ends when the agent's turn ends with nothing awaited, and needs no `wf result`. An agent that was opened
  but never run counts as idle, so the message starts its first turn, and a later `run` continues
  the same session. A question also continues an agent that is waiting on its own answer. Asking is
  refused `cycle` when it would close a ring of agents each waiting on the next.
- **When a message arrives.** Only between turns. An idle pane has it typed in. A headless agent
  gets it as a resumed session (`resumeTurn`) once its process exits. A busy agent gets it when its
  turn ends. Putting a message into a claude turn that is still running is later work,
  [[mid-turn-messages]].
- **How an asker waits.** In a claude pane that can confirm what it was sent, the asker waits the
  way `wf waiting` does (story 021), woken by the answer instead of a timer. Headless, a check-in's
  `wf waiting` is refused, because receipt cannot be confirmed
  ([[021-implementation-proof#Current support boundary]]); there the process exits, and the answer
  resumes the session as a new turn. While an answer is awaited, `wf waiting` is accepted and
  changes nothing. Any message also cuts a check-in's `wf waiting` short.
- **Nothing is applied twice.** An answer or a result is accepted only against the operation still
  open on the agent, so a late or stale one is refused, not used.

"What if the peer never answers?" It gets one reminder. Then its answer fails, and the asker
continues with a failure that says what to do instead. The same happens when the peer fails or
stops, or the asker's `--timeout` passes. The wait never outlasts the asker's own operation: at
that operation's deadline, or its scope's, the operation times out and the agent stops, as with any
timeout.

**Terms used below:**

- **Operation:** one piece of work given to an agent, such as a workflow `run`. Each has a *call
  id*, which the agent uses to finish it with `wf result {call-id}`.
- **Check-in:** 021's question to an agent whose turn ended without a result: finish, or ask for
  more time with `wf waiting`.
- **Placement:** where an agent runs: headless or in a pane, on the host or in a sandbox (srt or
  docker). The *sandbox door* forwards `wf` commands out of a sandbox.
- **Held messages:** messages that arrived while their recipient was busy, delivered when its turn
  ends.
- **Scope:** a stage's lifetime. A stage *seals* its scope when its function returns, and then
  waits for what it owns.
- **Route lesson:** the lines in an agent's prompt that tell it its routes and how to use them.
- **Lenses→fixer:** several reviewers ("lenses") each sending findings to one agent that fixes
  them.
- **M1, M2, M3:** measurements in [[messaging#To measure]]: whether claude's own messaging gets
  around routes; whether agents use messaging correctly; what stops an agent from acting as the
  operator. **E8** and **E9** are earlier experiments: E8 measured pane delivery, and its setup is
  reused; E9 tried this protocol on a stand-in `wf`.

## Scope

In scope:

- **Workflow API.** `workflow.messages.allow` with `maxMessages`. `ParticipantRef` becomes a branded
  type, so a workflow can only name agents it opened. Rules: [[messaging#Workflow interface]].
- **Agent commands.** `wf peers` (with `--json`), `wf send` (with `--await-reply` and
  `--timeout`) and `wf reply`. `wf result` and `wf waiting` are refused while an answer is owed,
  and a result while awaiting an answer drops the wait. Every response ends with a line saying what the agent
  owes. All of it works through the sandbox door.
- **Engine.** The messaging logic, in `engine/src/messaging/` ([[foundation]] §10), wired into the
  runner: routes, inboxes, owed answers, message operations, limits, the `cycle` refusal, the
  wrapper around each delivered message, and the prompt text that tells agents their routes.
- **Harness.** `HarnessTurn.deliver` between turns, for all four harnesses, headless and in idle
  panes, and in the fake harness.
- **Where asking works.** Claude panes that confirm what they were sent, and headless claude, codex,
  pi and cursor ([[messaging#Q9. Where can a sender await a reply?|Q9]]). An engine list turns
  `--await-reply` on per harness and placement once M2 passes there ([[#The M2 gate]]). A model M2
  did not measure may use a combination that is on. Elsewhere it is refused `unsupported`. The
  fake harness always has it.
- **Record and usage.** Messages and owed answers in the run's record. `cause`, why an operation
  ran, on operation, turn and usage records. The limits written into the record.
- **Testing API.** `messages` scripts, `turn.send`, `turn.messages`, `turn.reply`,
  `run.messagesOf` and `turn.cause` ([[messaging#Testing a workflow that messages]]).
- **Progress view and logs.** Lines for accepted messages, waits and queues in `awf run`; the same
  events in `awf logs`, and a phase for awaiting an answer in `awf runs`.
- **M1.** Claude's own messaging blocked, with tests and a measurement.
- **M2.** A live measurement, judged by [[#The M2 gate]].
- **Example.** `reviewLoop` rewritten so the reviewer and implementer talk until they agree, with
  its test and one live run.
- **Docs.** `workflow-api.md` (Messaging, Testing, Not built yet), `composition.md` (branded
  `ParticipantRef`), `status.md`.

Out of scope:

- **Delivering into a running turn**, [[mid-turn-messages]]. Until then, in the lenses→fixer shape,
  findings continue the fixer's operation when its turn ends, and a finding after its result wakes
  a separate message operation, outside its report.
- **`awf send`**, which waits on M3. Designed, not built.
- **`awf signal`** and the process inbox ([[workflow-styles]]).
- **Outside participants:** `participants.connect` and `wf inbox --wait` ([[composition]]). Their
  stubs stay published and throw `unavailable`.
- **The session that started the run (`agents.caller`) as a route end**, until [[attended-agent]].
  Agents opened with `agents.forkCaller` (story 027) are ordinary agents and can be route ends.
- **What [[messaging#Not in this design]] leaves out:** typed replies, steering, cancelling or
  editing queued messages, reading transcripts, pushed rooms and broadcast.
- **`--await-reply` in codex, pi and cursor panes.**
- **An operator setting for the limits**, [[operator-settings]].
- **Closing a route in the middle of a stage.** Stages scope routes.
- **Spend limits**, [[live-spend-limits]].

## Context and evidence

The code as of 2026-10-12.

**Workflow API:**

- `contract/src/workflow/messaging.ts` defines `MessageAccess` without `maxMessages`.
- `workflow.ts:85-88` publishes `participants`, `messages` and `signals`.
- `ParticipantRef` (`participants.ts`) is a plain `{ key }`. `AgentRef` extends it
  (`agents.ts:341`), and `LogicalAgent implements AgentRef` (`engine/src/workflow-runner.ts`).
- No example or test builds a `{ key }` literal, so branding breaks nothing.

**Harness:**

- `HarnessTurn.deliver(prompt): Promise<void>` is a stub (`harness/src/adapter.ts`;
  `session-core.ts:398` throws).
- `nudge` returns a turn with native `delivery` evidence. `NativeTurnRequest.kind` is
  `"turn" | "nudge" | "compact"`.
- `session-core` allows one active turn at a time (`assertIdle`).
- The pane path waits for the agent to settle before typing (`adapters/herdr.ts`, the E8 comment).
- A pane's idleness can be read through Herdr `agent wait --until idle` and `agent_status`.

**Waiting:**

- `supportsWaiting` is set only together with `confirmsDelivery` (`session-core.ts:501`).
- Only `adapters/herdr.ts:887` sets it: a claude pane awf launched on the host, or a sandboxed one
  in the run's own Herdr session with a seeded home (story 024). A claude pane in a sandbox's own
  Herdr session cannot wait, so it cannot await an answer.
- `direct-process.ts` never sets it, so headless waiting is refused
  ([[021-implementation-proof#Current support boundary]]).
- So headless `--await-reply` is new: the answer resumes the session as a new turn. All four
  harnesses define `resumeTurn` (`harnesses/{claude,codex,pi,cursor}.ts`).

**A name clash:** `operation-liveness.ts:29,290` already has a phase named `awaiting-reply`, shown as
"awaiting reply" in `progress-view.ts`. It is 021's window for answering a check-in, up to
`responseMs` (120 s), after which the turn is `unanswered`. It has nothing to do with messaging and
is renamed.

**A failure stops the agent:** `executeWaitingOperation` closes the agent when an operation fails or
times out (`closeAfterFailure`, `workflow-runner.ts:2454`), and messaging keeps that rule (Q10). A
cancelled operation does not close it there, although [[workflow-api#Outcomes]] says every
unsuccessful operation does. That gap is older than this story and stays; messaging relies only on
timeouts and failures stopping the agent.

**Order of work:** `LogicalAgent.#tail` runs an agent's operations one at a time, but nothing counts
what is queued. Stages call `scope.seal()` then `settleOwned()` (`workflow-runner.ts:898-955`), and
scopes are AsyncLocalStorage.

**Control plane:**

- `startResultControlPlane` and `handleFrame` (`control-plane.ts`) are tied to
  `ResultSlotRegistry`, which is indexed by `operationId` only.
- Nothing finds the open operation for an agent.
- The wire is version 3, and every request carries `operationId`. Decoding rejects unknown fields
  and codes (`RESPONSE_CODES`, `RESULT_SUBMIT_CODES`).
- The test host already submits over the real socket, through `@agentswf/wf/client`
  (`workflow-testing/host.ts`).

**Records:**

- `OperationRecord` (`agents.ts:230`) reaches `SettledOperation` and `TurnRecord` through
  `TURN_OPERATION_FIELDS` (`records.ts:376`).
- `TurnRecord.kind` is `"turn" | "compact"`.
- `OperationTags` in `run-usage.ts:58` carries the per-operation tags.
- `turnsOf` exists (`workflow-testing/index.ts:91`).

**Claude's own messaging (M1) is mostly handled:**

- `callingSessionEnv` in `harnesses/claude.ts` already lists `CLAUDE_CODE_MESSAGING_SOCKET` and
  `CLAUDE_CODE_MESSAGING_TOKEN`.
- `operator-runtime.ts:409-431` adds them to `WITHHELD_ENVIRONMENT` and
  `PANE_WITHHELD_ENVIRONMENT`, and `withholding()` keeps them from headless, sandboxed and pane
  agents (`herdr.ts` `emptyEnvironmentArgs`).
- Missing: a test for each placement, and refusing incoming messages. Claude's changelog names
  `crossSessionInbound: "refuse"`.
- Host agents use the operator's `~/.claude`, so the setting is passed with `--settings` at launch.
  In a sandbox it goes in the seeded `settings.json` (`harness/src/sandbox-needs.ts:86`).

**Constraints:**

- Messaging cannot live in one package ([[foundation]] §7). If a package boundary has to move, stop
  and say so.
- The record is public once built, so its format is approved before anything writes it.
- Crash recovery is not built ([[foundation]] §10). After a crash, the record is read as it is.
- Examples may import only `contract/workflow` (`scripts/check-boundaries.ts`), and their tests also
  `@agentswf/engine/workflow-testing`, so neither may export the brand's symbol.

**Assumption:** models end their turn when told to, and answer with `wf reply` rather than in plain
text. M2 measures this. Agent Relay's evals saw agents answer in plain text ("phantom" messages).
E9 saw none on headless pi with gpt-6-luna and gpt-6.1-sol: 40/40 waits ended cleanly and 80/80
owed answers went by `wf reply` ([[messaging-protocol]]). Claude, codex, cursor and panes are not
yet measured.

## Code map

### contract

- **`src/workflow/messaging.ts`:** `maxMessages`.
- **`src/workflow/participants.ts`:**
  - `ParticipantRef` branded with a `unique symbol`. The symbol and the function that makes a ref
    live in a contract module the engine reaches through its own export path, never
    `contract/workflow`, so the engine and `workflow-testing` make refs without casts and examples
    cannot forge one;
  - `ExternalParticipantRef` and `ParticipantDirectory` stay as stubs.
- **`src/workflow/agents.ts`:** `cause` on `OperationRecord`, the one field that marks a message
  operation. `TurnRecord.kind` stays `"turn" | "compact"`.
- **`src/records.ts`:**
  - `cause` added to `TURN_OPERATION_FIELDS`;
  - the message and owed-answer event kinds in `RunEvent`, versioned in `RUN_EVENT_VERSIONS`;
  - a phase for awaiting an answer in the `awf runs` view, beside `waiting`;
  - liveness kinds for waiting on an answer, in `OPERATION_LIVENESS_KINDS` (`liveness.jsonl`).
- **`src/wire.ts`:**
  - version 4;
  - `peers`, `send` and `reply` requests, none with an `operationId`;
  - a line on every response saying what the agent owes;
  - send refusals `no-route`, `awaiting`, `cycle`, `limit`, `too-large`, `inbox-full`, `closed`,
    `peer-stopped`, `unsupported`, `no-operation`;
  - reply refusals `none-owed`, `expired`, `closed`, `too-large`, `no-operation`, plus, with
    `--await-reply`, the send refusals `awaiting`, `unsupported`, `cycle`, `limit`;
  - `owes-reply` and `no-result` in `RESULT_SUBMIT_CODES`. `owes-reply` refuses `wf result` and
    `wf waiting` while an answer is owed; `no-result` refuses them on a message operation's call id;
  - a new response kind, `awaiting-reply`, for `wf waiting` while an answer is awaited. It carries
    the peer and the answer's deadline, so `wf` never prints "waiting granted". A `--timeout` given
    then is ignored.

### harness

- **`src/adapter.ts`:**
  - `deliver(spec: HarnessDeliverySpec & HarnessTurnHooks): Promise<HarnessTurn>`, with a spec
    shaped like a nudge's: `id`, `prompt`, `authored`, and `onSession` as `start` takes it;
  - `cause` and `messages` on `AuthoredTurn`, so the test host can spot a message operation and
    read what was delivered without parsing the wrapped text.
- **`src/session-core.ts`:** replaces the stub, reusing the nudge path's delivery evidence.
- **`src/adapters/direct-process.ts`:** headless delivery through `resumeTurn`.
- **`src/adapters/herdr.ts`:** pane delivery when idle.
- **`src/harnesses/claude.ts`:** `crossSessionInbound` passed by `--settings` on every agent launch.
- **`src/sandbox-needs.ts`:** `crossSessionInbound` in seeded sandbox settings too.
- **`src/testing/fake.ts`:** `deliver`, in task 2, so later tasks can run against the fake.

### engine

- **`src/messaging/` (new):**
  - routes, their scope and closing;
  - admission, with limits, room kept for answers, and the `cycle` check;
  - inboxes and their order;
  - owed answers;
  - the wrapper around each delivered message;
  - the record's events, written through `RunEventLog`;
  - the `--await-reply` list by harness and placement, on for the fake from task 3.
- **`src/control-plane.ts`:** a handler for messaging requests beside `ResultSlotRegistry`.
- **`src/result-slots.ts`:**
  - finding the open operation for an agent;
  - call ids for message operations, with no result slot (`no-result`);
  - `owes-reply`, and `wf waiting` only acknowledged while an answer is awaited, on any placement,
    with no check-in;
  - accepting a result only if the operation is still open (compare-and-set).
- **`src/operation-liveness.ts`:**
  - a new phase for waiting on a peer;
  - 021's `awaiting-reply` renamed `check-in-response`, and "awaiting reply" in the view too;
  - an answer that continues an operation seen as a new working turn, not under the check-in
    response window;
  - a deadline that can move, where 021 fixed one per operation;
  - waiting on an answer that does not need `supportsWaiting` (`workflow-runner.ts:2372`,
    `operation-liveness.ts:79`).
- **`src/workflow-runner.ts`:**
  - `workflow.messages`;
  - a count of what is queued on `LogicalAgent`;
  - a supervisor for message operations, which have no schema or result slot;
  - attaching each message operation to its route's scope, even a sealed one, or to the attempt
    outside any stage, and draining until nothing is in flight;
  - closing routes at a stage's end, on `agents.stop`, and when the workflow returns.
- **`src/run-progress.ts`, `src/progress-view.ts`:** message lines.
- **`src/run-view.ts`, `src/logs-command.ts`:** message events in `awf logs`, and the awaiting phase
  in `awf runs`.
- **`src/run-usage.ts`:** `cause` in `OperationTags`.
- **`src/workflow-testing/`:**
  - `messages` scripts, `turn.send`, `turn.messages`, `turn.reply`, `messagesOf` and `cause`;
  - `host.ts` submits sends and replies, and matches an answer's turn to its pending `turn.send`.

### wf

- **`src/cli.ts`, `src/client.ts`:**
  - `peers`, `send` and `reply`;
  - message text from a heredoc, standard input or an argument;
  - the owed-answer line printed from each response;
  - usage text.

### examples

- **`examples/feature-delivery/reviews.ts`:** `reviewLoop` becomes review until agreement, with its
  `*.test.ts`.

### docs

- `docs/workflow-api.md`, `docs/design/composition.md`, `docs/status.md`.

## Proposed design

As written in [[messaging]]. The engine holds all messaging state; the adapter only starts or
continues model work and reports what it saw ([[messaging#Agent binding and adapter seam]]).

### Settled questions

- **An asker waits between turns, never inside `wf send`**
  ([[messaging#Q1. Does a sender wait inside `wf send` or across turns?|Q1]]).
- **Answers are text, never typed** ([[messaging#Q4. Can a sender ask for a typed reply?|Q4]]).
- **An inbox shows counts, in arrival order, and cannot be edited for now**
  ([[messaging#Q5. How much of an inbox can be seen and changed?|Q5]]). A sender withdrawing its
  own unshown messages would reuse the end a dropped wait already records (`withdrawn`), so the
  record leaves room for it; it is not built because it would be a fourth command for M2 to measure.
- **Delivery only between turns**
  ([[messaging#Q2. How soon does `deliver` reach a busy headless agent?|Q2]]). Delivery into a
  running claude turn is [[mid-turn-messages]].
- **`--await-reply` in claude panes and on every headless harness**
  ([[messaging#Q9. Where can a sender await a reply?|Q9]]).
- **Failure.** A message operation that simply ends is not a failure. A timeout or a harness
  failure stops the agent ([[messaging#Q10. Does a message operation's failure stop the agent?|Q10]]).

### Rules this story builds

Each is written out in the design.

- **Routes.** A route is from one agent to another, and a pair has at most one open route at a
  time. Granting it again must match exactly, or it is rejected. Route ends are any agents the
  workflow opened, in any scope. `maxMessages` above the ceiling is lowered to it.
- **No call closes a route.** A route closes with its stage, so a stage can exist just to scope
  one. `allow` returning a handle with `close()` can be added later, when a workflow needs it
  ([[messaging#Routes by shape]]).
- **A route closing** marks messages not yet shown `undelivered` (`route-closed`). An answer
  already accepted is still delivered.
- **Limits.** The limits are engine constants, written into the run's record. An answer counts
  against its route's limit, so a question needs room for itself and its answer.
- **Checks run in a fixed order,** listed in [[messaging#`wf send`]] and [[messaging#`wf reply`]].
  `peer-stopped` comes before `closed`. `no-route` means the route was never granted, so a closed
  route is still known for the rest of the attempt. A reply with `--await-reply` whose question
  fails a check is refused whole.
- **`--timeout`** past the default is lowered to it, and the acknowledgement prints the deadline.
  Only `--timeout` continues an asker with a timeout failure; reaching its operation's own deadline
  times the operation out and stops the agent.
- **Message operations have call ids,** named in their messages, with no result slot and no
  check-in. `wf result` and `wf waiting` on one are refused `no-result`, before any other check.
  Nothing shown to a message operation mentions `wf result`; it stops waiting only on its answer, a
  failure or its own `--timeout`.
- **One route opens a message operation,** so `cause` names one sender and the operation belongs to
  one scope. Messages held on other routes wait for the next one. Once open, the operation can be
  continued from any route: by its answer, by a question, and by plain messages held with the
  answer.
- **A message operation's deadline** is the later of 15 minutes from opening and the deadlines of
  the operations waiting on its answers, capped by its scope's, and it only ever moves later. An
  asker's `--timeout` fails only its question, never the answering agent's operation. A timeout
  stops the agent, as any timeout does.
- **A stage owns the message operations its routes opened,** as it owns a `run`. One that times out
  or whose harness fails fails the stage; a stage that throws or stops cancels them. A stage waits
  for them to finish, and for every answer owed on its routes to be sent or fail, whatever
  operation owes it. After its function
  returns, a reply's `--await-reply` on its routes is refused `closed`.
- **When the workflow returns,** new sends are refused, and it waits for message operations in
  flight, as a stage does. The attempt owns message operations opened by routes outside any stage:
  one that times out or whose harness fails ends the run `failed`, even after the workflow returned
  a value.
- **The end of a turn** follows the order in [[messaging#Finishing]]:
  - **A workflow operation:** waiting on an answer comes first, then `wf waiting`. Held messages
    continue it. One that owes an answer gets one reminder instead of the check-in. Otherwise the
    check-in.
  - **A message operation:** waiting on an answer, then `wf waiting`. One that owes gets one
    reminder. Then it ends, and held messages open a new message operation, with its own `cause`,
    scope and deadline, or join a workflow `run` already queued.
  - A message cuts a check-in's `wf waiting` short.
  - An operation waiting on an answer is continued only by the answer, a failure or a question.
  - `wf waiting` is refused while an answer is owed. While one is awaited, it changes nothing and
    is acknowledged, on any placement.
- **Held messages** join a workflow's `run` as well as a message operation. In a `run` they come
  after its prompt, each wrapped, and `cause` stays absent. A question shown in a `run` becomes
  owed by that operation. `compact` and `set` carry none.
- **A plain message to an asker that is waiting** is held and delivered with the answer.
- **A result drops a wait.** An answer accepted but not yet shown to the asker is recorded
  `undelivered` (`withdrawn`), like an unshown question. "Shown" means `offered`.
- **An answer and a timeout race** by compare-and-set: once the answer is accepted, the timeout
  changes nothing.
- **A message to an agent that has not run** starts its first turn as a message operation, through
  `HarnessSession.start`, as a first `run` does. `agents.open` already opens the session idle, on
  the host (`workflow-runner.ts:1273`) and sandboxed (`:1418`). A pane is placed at open and its
  harness started by the first operation (`herdr.ts:1350-1357`), and both adapters put
  `instructions` before the first prompt of any kind. Nothing new is needed to open an agent
  asleep.
- **Every message operation starts with `HarnessSession.start`,** bound to its call id. `deliver`
  only continues an operation already open.
- **`wf peers` states:** `not-started` (a message starts its first turn), `working`, `idle`,
  `awaiting {peer}`, or `stopped` with a reason. A failed operation stops its agent, so there is no
  `failed` or `done` state.
- **Delivery states.** A message is `observed` when a claude pane confirms it (`claude-receipt`),
  or, headless, when the resumed turn's session record shows it. Otherwise it stays `unconfirmed`.
- **Compaction.** The owed-answer line on every response restores what an agent owes after its
  harness compacts. Operations run one at a time, so awf's `compact` never runs while an answer is
  owed.
- **Agents can reach each other's sockets,** since they run as the engine's user. M3 measures this
  per placement.
- **The record** ([[messaging#The record]]) is the run's event log, `turns.jsonl`, which `awf logs`
  and `awf runs` already read (story 028): message and owed-answer events are new kinds there, with
  `admitted` written before `wf send` returns.
- **The review example.** `reviewLoop` grants a `between` route per review stage, none when
  `maxRevisions` is 0, with `maxMessages` twice `maxRevisions`. It asks the reviewer once, stops on
  `changes-requested`, and takes the work's typed value from one more author turn,
  `Record {subject}` ([[messaging#Review until convergence]]).
- **The lenses→fixer shape** needs a claude pane until [[mid-turn-messages]], and each lens says
  `done` last.

### The M2 gate

`--await-reply` stays off for a harness and placement until M2 passes there
([[messaging#Q11. Which live results let a harness use `--await-reply`?|Q11]]). For each model, in
at least 18 of 20 trials:

- after asking, the agent ends its turn without `sleep` or another blocking wait, since an asker
  that blocks holds back its own answer and uses up its deadline;
- once the answer arrives, the agent finishes its task with it, a check-in allowed;

and the harness's live smoke shows the answer arriving: a headless session resumed with it, or a
pane confirming it (tasks 6 and 7).

The rest of M2 is reported, not gated; under 18 of 20 means revising the prompts and wrappers in
task 9. That covers: answering with `wf reply` within one reminder; how often `wf peers` is checked
per wait, flagged above two; answering only in plain text, `wf result` on a message, sending on a
reply-only route (one that only lets it answer the other side's questions); and remembering an owed answer after `/compact` in a pane, where a miss
costs a reminder, not the answer.

Fake "operator" text inside a message is reported and never gates `--await-reply`: plain messages
carry the same text and are not gated. What limits the harm is the route, the sandbox and
permissions. Any time it is obeyed is recorded in [[messaging-protocol]] and in the design's
[[messaging#What a delivered message looks like]].

The evidence is E9 ([[messaging-protocol|P1–P6]]), on headless pi with gpt-6-luna and gpt-6.1-sol.
Asking, waiting and answering held 40/40. What failed was wording: sol stopped after answering a
question that came with a workflow `run` (20/20, recovered by the check-in), and luna tried to
send on a reply-only route (50/60). The design's wrapper for a question in a `run` and its
reply-only refusal text address both. A fake operator line was obeyed once in 60, and never when
escaped or quoted (0/80).

### Rejected

The reasons are in the design's Decisions.

- **An asker blocking inside `wf send`** (Q1).
- **"The next send is the answer"** (Q7).
- **The crossing rule.**
- **Typed answers** (Q4).
- **A per-run limit** (Q3).
- **Any failed message operation stopping the agent** (Q10).

## Tasks at a glance

- [x] 1. Claude agents cannot message around their routes (M1)
- [x] 2. Types, wire v4, record format and the `deliver` seam are settled
- [x] 3. The messaging logic admits, queues and settles, as pure code
- [x] 4. The runner wakes, continues and closes through it, against the fake harness
- [x] 5. `wf peers`, `wf send` and `wf reply` work over the control plane and the sandbox door
- [x] 6. Headless agents receive messages and await replies
- [x] 7. Panes receive messages when idle, and claude panes await replies
- [x] 8. A workflow's tests script messages; the progress view, logs and usage show them
- [x] 9. Agents use messaging correctly live (M2); the review example converges; docs updated

Task 7 needs story 024, which is `awaiting-human-review`, to be done. Tasks 1 to 6 do not.

## Open questions

None.

## Task execution rule

Do one task at a time. Every task goes through the checklist under its details. Compiling is not
enough to move on: the task's design is recorded, its diff reviewed by subagents, their findings
resolved, and its focused checks passing.

When every task is done, run the story-level checks and ask for human review of the whole.

## Task details

Every task runs the same checklist:

- [ ] Plan
- [ ] Implement
- [ ] Review: two subagents, one for architecture and scope, one for correctness and proof
- [ ] Resolve
- [ ] Verify

[[README#Task and story gates]] says what each step requires.

### 1. Claude agents cannot message around their routes

Outcome: a claude agent awf launched can neither send to nor receive from a peer or the operator's
session over claude's own cross-session messaging. This holds on the host, under srt and under
docker.

Work:

- Check that the installed claude has `crossSessionInbound: "refuse"`, and what `--settings` does
  with it. If it does not exist, record that and rely on withholding the variables.
- Pass it by `--settings` on the host, and in seeded sandbox settings.
- Test that the messaging variables are withheld from headless, sandboxed and pane agents. They
  already are, but nothing tests it.
- Run M1: send from an agent in each placement, including with a token read through `ps eww`.

Done when:

- the tests show the variables absent in every placement, and the setting present if it exists;
- M1's result is in [[messaging#To measure]] and `docs/findings/`. If the host is still reachable,
  the story stops for a decision.

### 2. Types, wire v4, record format and the `deliver` seam are settled

Outcome: everything another package will import is final before anything uses it.

Work:

- **Contract:** `maxMessages`, the brand, `cause`, and the liveness kinds for waiting on an answer.
- **Wire v4:** requests, responses, the owed-answer line and every refusal code in the Code map.
  An older launcher is refused, as 021 did at v3.
- **The record:** a written draft of the message and owed-answer event kinds in `turns.jsonl`
  (fields, states, versions in `RUN_EVENT_VERSIONS`), `cause`, the limits in the run's record, and
  the phase `awf runs --json` shows for an agent awaiting an answer.
- **Harness:** `deliver(spec: HarnessDeliverySpec & HarnessTurnHooks): Promise<HarnessTurn>`, so a
  delivered turn names its session as a started one does, `cause` and `messages` on
  `AuthoredTurn`, and `deliver` on the fake harness.

Done when:

- the design's workflow examples compile in a typecheck file, and a `{ key }` literal does not.
  The testing sketch is settled in task 8;
- wire round-trip tests cover every code;
- the user has approved the record draft, the new liveness kinds, and `cause` on turn records.

### 3. The messaging logic admits, queues and settles, as pure code

Outcome: `engine/src/messaging/` decides every case in the design, with no I/O beyond its record
writer.

Work:

- **Routes:** validation, granting the same route twice, scope and closing, and `route-closed` for
  messages not yet shown.
- **Admission:**
  - the route, limit, size and unread checks;
  - room kept for an answer;
  - the `cycle` check over open waits, ignoring the question a reply with `--await-reply` answers;
  - a question and its owed answer saved together.
- **Inboxes:** arrival order; plain messages to a waiting asker held with its answer.
- **Owed answers:**
  - met only by `wf reply`;
  - `none-owed` and `expired`;
  - failing on timeout, stop or cancel;
  - a late answer refused.
- **Wrapping.** The three kinds in [[messaging#What a delivered message looks like]]: a message,
  an awaited answer, and a failure. Each is fenced with a random marker of at least 8 hex
  characters, escapes lines that look like a fence, quotes the route's purpose, and names the call
  id.
- **Prompt text:** the route lesson in an operation's prompt, the announcement of a new route, and
  the reminder to answer.

Done when:

- unit tests cover each bullet;
- the wrapping tests include a forged fence and a forged header.

### 4. The runner wakes, continues and closes through it, against the fake harness

Outcome: the runner follows every messaging rule on the fake harness. Tests drive sends and replies
through `engine/src/messaging`'s own interface, the one task 5's handler calls; the `wf` commands
come in task 5.

Work:

- `workflow.messages`, with grants bound to the current scope, one open route per pair, and
  `maxMessages` lowered to the ceiling.
- **Waking:** a count of what is queued on `LogicalAgent`, and a message operation only when nothing
  is queued.
- **Message operations:**
  - their own supervisor;
  - ending when its turn ends with nothing awaited;
  - one reminder to answer;
  - a timeout or a harness failure stops the agent (Q10);
  - one route opens a message operation and fixes its `cause` and scope; once open, it may be
    continued from any route;
  - the deadline: the later of 15 minutes and the waiting operations' deadlines, only ever later;
  - a stage owns them: a timeout fails the stage, a throw or stop cancels them. A sealed scope still
    takes them, since a message held before the function returned can open one after the seal,
    and the drain repeats until nothing is in flight;
  - a stage waits for the operations its routes opened, and for every answer owed on its routes to
    be sent or fail;
  - outside any stage the attempt owns them, and a failure ends the run `failed`;
  - a message to an agent opened but not yet run starts its first turn.
- **Held messages:** they join a workflow's `run` after its prompt, and a question shown there is
  owed by that operation.
- **A turn's end,** in the design's order:
  - for a workflow operation, held messages continue it before any check-in;
  - for a message operation, held messages open the next one, or join a `run` already queued;
  - a message ends a check-in's `wf waiting` early.
- **Waiting askers:** continued by an answer, a failure or a question; `wf waiting` only
  acknowledged; `wf result` drops the wait.
- **Finishing:**
  - `wf result` and `wf waiting` refused while an answer is owed;
  - a result while awaiting an answer drops the wait: a question not yet shown is `withdrawn`, a seen one is
    released and its late answer `expired`, and an answer accepted but not shown is `withdrawn`;
  - an answer racing its asker's timeout, settled by compare-and-set;
  - every result accepted only if its operation is still open;
  - finding the open operation for an agent.
- **Endings:**
  - a stage's end and the workflow's return wait for message operations in flight;
  - `agents.stop` closes routes;
  - the attempt's end records undelivered messages;
  - the limits written into the run's record.
- **Phases:** 021's `awaiting-reply` renamed, and a phase for waiting on a peer added.

Done when:

- runner tests on the fake harness cover each bullet, including races between a send, a stage
  ending and an agent stopping;
- 021's waiting tests still pass under the renamed phase.

### 5. `wf peers`, `wf send` and `wf reply` work over the control plane and the sandbox door

Outcome: the agent commands behave and print as in [[messaging#Agent CLI]].

Work:

- The three commands, with text from a heredoc, standard input or an argument; `--json` on `peers`.
- The owed-answer line printed from each response.
- The "may have been queued" acknowledgement.
- Exit codes 0, 1 and 2.
- Usage text with the launcher's full path.
- Forwarding through the sandbox door, tested as 021 task 2 tested `wf waiting`.

Done when:

- CLI tests check every acknowledgement and refusal line in the design;
- end-to-end tests run over a real socket, on the host and through the srt door.

### 6. Headless agents receive messages and await replies

Outcome: on headless claude, codex, pi and cursor:

- a message to an idle agent wakes it through `HarnessSession.start`, resuming its session, or
  starting one if it has not run;
- a message to a busy agent waits for its process to exit;
- an asker waiting on an answer is continued by it.

Work:

- `deliver` in `direct-process.ts`.
- An answer that continues an operation seen as a new working turn, not under the check-in
  response window.
- `wf waiting` while an answer is awaited, acknowledged headless and changing nothing.
- `observed` from the resumed turn's session record.
- `--await-reply` allowed headless through the engine list, still off for each combination until
  task 9.

Done when:

- harness tests with the fake cover waking, held delivery and continuing;
- one live smoke per harness delivers, wakes and continues, with the list forced on for it.

### 7. Panes receive messages when idle, and claude panes await replies

Outcome: in a pane, a message is typed only when the agent is idle. In a claude pane, an asker
waits for its answer the way `wf waiting` waits.

Work:

- `deliver` in `herdr.ts`: wait for idle, then type, with `claude-receipt` on claude.
- Waiting on an answer in claude panes through the waiting code, behind the engine list as
  headless is.
- Codex, pi and cursor panes refuse `--await-reply` with `unsupported`.

Done when:

- adapter tests cover typing only when idle;
- one live smoke per harness in a pane delivers a message, confirmed or recorded `unconfirmed`,
  with the list forced on for claude;
- a claude pane waits and is continued.

### 8. A workflow's tests script messages; the progress view, logs and usage show them

Outcome: an author tests a messaging workflow for free, and an operator sees messaging in
`awf run`.

Work:

- **Scripts:**
  - `messages` scripts;
  - `turn.send(..., { awaitReply })`;
  - `message.reply`, `send`, `silent` and `fail`;
  - `turn.messages` and `turn.reply(peer, text)` for messages that join a workflow turn, with a
    result refused (`owes-reply`) while the script still owes;
  - `turn.send` resolving to `sent`, `replied`, `failed` or `refused`;
  - a turn that ended with `reply.waiting` or `reply.silent` run again with held messages;
  - continuations as turns of their own in `turnsOf`;
  - `run.messagesOf` and `turn.cause`;
  - a woken agent with no script fails the test.
- **The test host:** submits sends and replies, and matches an answer's turn to its pending
  `turn.send`.
- **Progress:** lines for accepted messages, waits and queues; nothing for idle agents.
- **Logs:** message events in `awf logs`, followed by `--agent` from either side; an agent awaiting
  an answer shown in `awf runs` with its peer and deadline.
- **Usage:** `cause` in `workflow.usage()` and `output.json`.

Done when:

- the user has approved the testing API's names and types before it is built;
- the design's testing sketches, the review loop and lenses→fixer, pass as real tests;
- progress-view tests show the three kinds of line, and logs tests a message, an owed answer and a
  wait.

### 9. Agents use messaging correctly live (M2); the review example converges; docs updated

Outcome:

- each harness and placement that passes M2 is on the engine list;
- one that fails stays off, with the reason recorded;
- the review example runs live;
- the docs say what is built.

Work:

- **M2** on the E8 setup: 20 or more trials per harness, placement and model, counting what
  [[messaging#To measure]] lists, judged by [[#The M2 gate]]. Cheap models, on codex where claude
  is not the subject. E9's scenarios and scorer (`experiments/e9-messaging-protocol`) are the
  starting point, run against the built `wf`.
- **Revisions:** prompts and wrappers revised from the counts.
- **The example:** `reviewLoop` in `examples/feature-delivery` rewritten as review until agreement,
  with its test, and run live once.
- **Docs:**
  - `workflow-api.md`: Messaging, Testing, and Not built yet;
  - `composition.md`: the branded `ParticipantRef`, and its review loop asking with
    `wf send --await-reply` and answered with `wf reply`;
  - `status.md`;
  - the design's status line.

Done when:

- M2's counts are in `docs/findings/`, and the engine list, by harness and placement, matches them;
- the example's test passes, and its live run reaches a verdict within its `maxMessages`.

## Verification

Automated:

- [ ] focused tests named in each task
- [ ] `bun test`
- [ ] `bunx tsc --noEmit`
- [ ] `bun run check`, with no boundary moved

Manual or live, with costs estimated in [[testing]] first:

- [ ] M1 on the host, srt and docker (task 1).
- [ ] Delivery smokes: headless per harness (task 6), panes per harness (task 7).
- [ ] M2, at least 20 trials per harness and model (task 9).
- [ ] The review example, live, once (task 9).

## Readiness

- [x] Outcome and boundaries are concrete.
- [x] Relevant implementation, callers, and tests are mapped.
- [x] Evidence and research support the proposed design.
- [x] Expensive interface, record-format, and stage-gate decisions are settled. The record format
  is approved inside task 2.
- [x] Tasks are ordered, coherent, and independently verifiable.
- [x] Open questions are resolved or explicitly moved out of scope.

## Implementation notes

### Task 1

- claude 2.1.296 has `crossSessionInbound`: `accept`, `hold` or `refuse`. Unset, a message is
  delivered only when sender and receiver are in the same permission-mode class. Settings sources
  merge it as restrictive, so `refuse` from `--settings` cannot be loosened by the user's settings.
  `--settings` takes a JSON string, and still applies under `--setting-sources project,local`.
- Every agent launch passes `--settings '{"crossSessionInbound":"refuse"}'`: pane, pane resume,
  headless, resume, compaction and fork. `claude -p /usage` and `claude auth status` are not agents
  and do not. The seeded sandbox `settings.json` carries it too, as a backstop should a launch
  path ever miss the flag.
- In panes the variables are emptied (`NAME=`), not removed.
- The withholding test is the existing "no agent inherits the markers" test in
  `engine/src/operator-runtime.test.ts`, extended with `CLAUDE_CODE_MESSAGING_SOCKET` and a
  sandboxed agent, which has them removed. Dropping the socket from the withheld names fails it.
  `harness/src/harnesses/claude.test.ts` checks the flag on every claude plan, host and sandboxed.
- Herdr passes the flag's JSON intact: `herdr agent start --kind claude -- --settings '{…}'`
  reports it unchanged in its `argv`, and the pane's claude starts normally.
- Live, 2026-10-12, every harness: 15 of 17 evals pass. Among them are every sandboxed claude
  placement (`run-sandbox`, `run-sandbox-docker`, `sandbox-panes-srt`, `sandbox-panes-docker`,
  `sandbox-srt`, `sandbox-docker`), `harnesses`, `calling-session`, `compaction`, `effort` and
  `turn-liveness`. `harnesses` and `calling-session` failed only while other live runs shared
  Herdr, and pass alone. `skills` started no agent: a sandboxed cursor needs `CURSOR_API_KEY`.
  `fork` fails on `claude>headless` on main too, so not from this change. Its claude pane case
  failed once on prompt delivery, then passed twice alone.
- M1, measured 2026-10-12 ([[claude-session-messaging]]) and written up in
  [[messaging#Claude's own messaging]]: every claude
  that shares `~/.claude` sees and can write to every other, the operator's included, and
  withholding the variables changes nothing, since a claude agent is a session of its own. A
  claude with its own setup folder, as a sandboxed one has, reaches no one. `refuse` stops an
  agent receiving; nothing stops it sending.
- Decided by the human, 2026-10-12: a claude agent outside a sandbox may use claude's own
  messaging for now, as it already runs on the operator's whole claude setup; it is documented, not
  blocked. Giving agents a clean setup, by default, is [[agent-own-config]].

### Task 2

The human asked, 2026-10-12, that the story's approval gates be checked by review rather than
waiting on them; these are the drafts the gate named, as built and reviewed.

- **The brand.** `ParticipantRef` carries `[PARTICIPANT]: true`, a `unique symbol` in
  `contract/src/participant.ts`, exported only as `@agentswf/contract/participant`, with
  `participantRef(key)`. `participants.ts` imports its type alone, so `contract/workflow` exports no
  way to make one. `LogicalAgent` is the one class that implements `AgentRef`, and carries it.
- **`cause`** is `{ message: { from } }` on `OperationRecord`, absent for the workflow's own
  operations, and in `TURN_OPERATION_FIELDS`, so turn lines, `operation-started` and usage records
  carry it. An added optional field leaves every kind's version at 1, as story 028's rule says.
- **The record.** New `RunEvent` kinds, each at version 1, keyed by attempt and `message`, a number
  in the order admitted within the attempt, as `decision` is:
  - `route-opened` and `route-closed`: the route's ends (`from`/`to`, or `between`), purpose, the
    limit in force and the one asked for when it differed, the stage it closes with; closed for
    `stage-ended`, `agent-stopped` or `attempt-ended`.
  - `message-sent`, written before `wf send` or `wf reply` returns: sender, recipient, the sender's
    operation, the text and its bytes, `awaitsReply.until` on a question, `replyTo` on an answer.
  - `message-refused`: the command, code and bytes, so refused sends are kept.
  - `message-delivery`: `offered`, then `observed` or `unconfirmed`, with the operation it went in.
  - `message-undelivered`: `withdrawn`, `route-closed` or `attempt-ended`.
  - Delivery lines carry `from` as well as `to`, so `awf logs --agent` can follow either side.
  - `request-ended`: an owed answer's end, `replied`, `failed`, `timed-out`, `withdrawn` or
    `released`, with the answer's number.
  The text is kept, which the design's list did not name: it is the only copy of a message never
  shown, and `awf logs` cuts it in a page as it cuts any string the run wrote.
- **Limits.** `messageLimits` on the attempt record: `perRoute` 40, `bytes` 16 KB, `unread` 16,
  `operationMs` 15 minutes.
- **`awf runs`.** `live.phase` gains `awaiting-reply`, with `peer` and `until`, read from the
  latest liveness record as `waiting` is.
- **Liveness kinds.** `awaiting-reply` (with `peer` and `until`), `continued` (`reason` says by
  what: `reply`, `no-reply`, `request` or `messages`), `reminder-due`, and `deadline-extended`.
- **Wire 4.** `peers`, `send` and `reply` name no call id. Every response may lead with `owing`,
  the owed-answer line. `peers` carries the same as data for `--json`. `awaiting-reply` answers
  `wf waiting` while an answer is awaited. `SEND_CODES` and `REPLY_CODES` are in check order, and
  `ENVELOPE_CODES` are the refusals any command can get. `decodeResponseFor` takes only a
  command's own acknowledgements and codes, so the client casts nothing. A version 3 launcher is
  refused `unsupported-version`. Until task 5 the control plane answers the new commands
  `unsupported-command`.
- **Who writes what an agent reads.** The engine writes every messaging line, since only it knows
  the launcher's path, the peers' purposes and what closes a cycle: `notice` on `sent` and
  `awaiting-reply`, `text` on `peers`, `error` on a refusal, and `owing`. `wf` prints them. The
  result and waiting lines from before keep `wf`'s own wording, which E5 measured; `owes-reply` and
  `no-result` print the engine's.
- **`deliver`.** `HarnessDeliverySpec` is the design's, plus `deadline`, which a nudge has too. It
  runs a native turn of kind `deliver` on the operation's binding, after the turn settles, and may
  repeat on the turn it returns. A turn takes one successor, a check-in or a delivery. Both
  backends already send any kind but `compact` as a prompt; tasks 6 and 7 make them deliver
  properly. The fake delivers through the same path.
- **`AuthoredTurn`** gains `cause` and `messages`: each a `message` with its sender and text,
  `answers` when it is the answer the operation awaited and `asks` when it is a question, an answer
  that asks back being both; or `no-reply`, with the reason the answer failed.
- **Review.** Both reviewers found nothing blocking. Resolved:
  - one continuation path for a nudge and a delivery: claimed only once it starts, refused on a
    turn released or followed by another operation's, and one withdrawn before dispatch leaves the
    agent's status as it was;
  - the liveness `peer` is kept and checked; 021's check-in phase is now `check-in-response`;
  - `@agentswf/contract/participant` is forbidden outside the engine by the boundary check;
  - a peer's key with surrounding spaces is refused.
  Left for later tasks: the brand stops a `{ key }` literal, not a spread or cast of a real ref, so
  task 4 checks a route's ends by identity against the agents opened; agent-facing times carry
  their offset or are relative, since a docker agent's clock is UTC (task 3); `awf logs`'s filters
  and its message lines are task 8's.

### Task 3

- `engine/src/messaging/` holds the logic: `routes.ts` (a route, its scope, its pairs),
  `messaging.ts` (the `Messaging` class), `text.ts` (everything an agent reads about messaging),
  `limits.ts` (the ceilings and the `--await-reply` list, the fake alone on it). It starts nothing:
  the runner tells it of operations (`opened`, `extended`, `ended`) and asks it what a turn's end
  goes on to (`turnEnded`), what is held (`pending`, `opening`, `take`), and what a stage still
  waits for (`busy`); the control plane hands it `send`, `reply`, `peers` and `checkFinish`.
- An operation carries its scope and a ceiling. A message operation's deadline moves later as it
  takes questions, to the latest of its askers' deadlines, never past the run's; a wait without
  `--timeout` follows its asker's deadline as that moves.
- A message held for an agent busy outside a stage when the stage's function returns is dropped as
  the stage finishes (`route-closed`), so the stage never waits on an unrelated turn.
- An answer that asks back is an answer first: whatever ends its question, the answer is still
  delivered unless its own asker has finished, and then its sender is told rather than left
  waiting. A stopped agent's questions are dropped with it, so a reply to it is `expired`.
- Agent-facing times are in UTC with how long is left, and a past one is the time alone. A message
  operation opens on its routes' lesson, as a workflow's `run` does, and every envelope names its
  call.
- `message-sent` is written before a send is acknowledged; a write that fails rejects the send, for
  task 5's "may have been queued" acknowledgement. Every other record is best effort.
- Review: both reviewers' findings are resolved (the answer-that-asks-back cases, the record's
  undelivered reasons, the reply's limit, deadlines, scope, a pure `pending`, the text of past
  times and `awaiting you`), each with a test; 37 tests.

### Task 4

- The control plane's messaging handler came forward from task 5: `wf result` and `wf waiting`
  have to be judged against what is owed before the result slot is asked, and the runner's tests
  drive sends and replies over the real socket, as the test host does. It hands `peers`, `send` and
  `reply` to the logic, refuses `no-result` and `owes-reply` first, answers `awaiting-reply` for
  `wf waiting` while an answer is awaited, and leads every response with the owed-answer line.
  Task 5 is left the `wf` side, the door and the CLI and end-to-end tests.
- `WorkflowOwner` holds the run's `Messaging` and answers its questions about agents: `working`
  while anything is queued, `idle` once one of its operations was delivered, `not-started` before,
  `stopped` with its reason. A route's ends must be the very refs the run issued, so a spread or
  cast of one is refused. A route is scoped to the stage it is granted in, a `parallel` inside it
  included, else to the attempt.
- `LogicalAgent` counts what is queued. With nothing queued, a held message opens a message
  operation, which it queues as any operation, so nothing runs beside it. The opening is read again
  when it starts: a message dropped meanwhile leaves another route's for an operation of its own.
  A closed stage opens none.
- A message operation runs on `superviseMessageOperation`: no slot, no check-in. It honours a stop
  and its deadline while a turn starts or is delivered, fails on a delivery that fails or is not
  confirmed in time, as 021's turns do, and releases bounded. Its deadline is 15 minutes, moved
  later to its askers' as it takes their questions, never past the run's. It is recorded `answered`
  with no value, and messaging is told it settled. A timeout or a harness failure stops the agent
  and fails what owns it: its stage, or the run, even after the workflow returned.
- A stage owns the message operations its routes open, past the end of its function. When that
  returns, its routes take nothing new and messages held for agents busy outside it are dropped;
  it then waits until nothing it owns is in flight and no answer owed or message held on its routes
  is left, waking on any change to messaging. The workflow's return does the same for the attempt.
- A workflow operation registers with messaging when it starts, and takes what is held after its
  prompt and route lesson. When its turn ends without a result, what continues it goes at once,
  cutting a `wf waiting` short; while it awaits an answer there is no check-in; at the check-in's
  time it gets the reminder instead if it owes, which has the check-in's response window to be
  answered in. A delivery that has not dispatched is not withdrawn when a result arrives first,
  since what it carries is already shown. Without nudges the reminder still comes.
- The fake harness may `--await-reply` in a pane without delivery evidence: the list marks a real
  harness's pane `confirmed`, so it waits only where the pane confirms what it was sent.
- `RunWorkflowOptions.awaitReply` overrides the list; task 8's test host needs it, as a workflow's
  test runs real harness names on the fake.
- Deferred: a message operation's deadline follows its askers' only when it takes their questions,
  not when an asker's own deadline moves later afterwards.
- Review: both reviewers' findings are resolved, each with a test: the message supervisor rewritten
  to observe turns as the workflow's does; `ended` in a `finally`, with the credential write-back
  after a message operation; busy-elsewhere read from the runner's state; a recipient woken even
  when its message's record fails; the reminder's window; reminders without nudges. 18 runner tests.

### Task 5

- `wf peers [--json]`, `wf send` and `wf reply` print what the engine wrote, prefixed `wf:`:
  acknowledgements on standard output, refusals on standard error, exit 0, 1 or 2. The owed-answer
  line leads every response, but not one that already says it: the acknowledgement of a wait it
  began, `wf waiting` while awaiting, and the `owes-reply` and `awaiting` refusals. `wf peers`
  says it in its table, "No routes." included.
- The message comes from a quoted heredoc, standard input or one argument; given an argument,
  standard input is not read, as for `wf result`, since a tool runner's inherited pipe would stall
  the read. A heredoc's last newline is not part of the message. A flag after the peer is refused:
  sent as the message, it would drop the heredoc and the wait the agent meant.
- A connection that never opened says the message was not sent; one lost after the write says it
  may have been queued and that nothing was retried.
- The launcher passes its own path (`--as`), so `wf`'s usage names it as an agent must type it.
  A box's copy carries the same path.
- Tests: CLI tests for each line `wf` itself writes; through a real launcher and control plane on
  the host, every acknowledgement and refusal the design gives that no logic test prints; through
  a real srt sandbox's door, `peers`, a heredoc send and a refusal (`tests/messaging-door.local.test.ts`,
  skipped without srt).
- Review: both reviewers' findings are resolved; the design's Agent CLI text now says an argument
  wins over standard input, and its `closed` refusal names the stage.

### Task 6

- Headless delivery needed no new path: a `deliver` turn resumes the session with `resumeTurn`, as
  a nudge does, once the turn before it has ended, and a message operation's first turn starts a
  session for an agent that has not run.
- `observed` comes from the session's own record, read by the harness backend, which owns its
  formats: when a turn carries messages, the size of its session's own file before it runs marks
  where its rows begin, and it is observed when what it appended shows its prompt's first line
  from its user. Only what that turn wrote is read, so the same words in an earlier turn are never
  taken for it, and a turn that failed to run is never observed. A subagent's or a fork parent's
  files are not searched. cursor keeps its chats in a SQLite store awf cannot read: its deliveries
  stay `unconfirmed`. `HarnessTurnOutcome.observed` carries it; a pane keeps its delivery evidence.
- A check-in or a reminder carries no messages in `authored`; only the turns that deliver them do.
- `OperatorEnvironment.awaitReply` lets a live check turn the list on for what it tests;
  `tests/messaging.eval.ts` turns each harness on, headless.
- Live, 2026-10-12, claude, codex, pi and cursor headless: every asker returned the codeword only
  its keeper knew, every keeper was woken by the question, and every answer resumed its asker's
  same call; deliveries were `observed`, cursor's `unconfirmed`. 8 agents, ~25 s, ~$0.24 at list
  prices.
- Review: both reviewers' findings are resolved: the evidence read only from where the turn began,
  in the session's own file, the probe masked as the rows are; tests for a same-line delivery that
  fails to run, the engine recording `observed`, and headless `wf waiting` and held messages.

### Task 7

- Story 024's code is merged; only its human review is open, and task 7 relies on nothing else of
  it.
- The pane backend needed no change: it settles a pane before typing any turn but a compaction, a
  delivery included (`herdr.ts` `execute`), and arms the claude receipt for every turn on a pane
  that confirms delivery, so a delivery to a claude pane is `observed` once its session shows the
  model took it. Only a claude pane on the host, or one in the run's own Herdr session with a home
  of its own, confirms delivery; anywhere else `--await-reply` is `unsupported`, a sandbox's own
  Herdr included (Q9). A real harness's pane goes on the list only as `confirmed`.
- With delivery evidence, a turn's end waits a few seconds for the receipt before a delivery is
  `unconfirmed`, since the receipt is read from the session's file.
- Tests: a delivery types nothing while the pane's agent works and nothing once withdrawn, and a
  claude pane's carries its receipt marker; a claude pane in a sandbox's own Herdr cannot wait.
- Live, 2026-10-12, on main's pasted multi-line prompts: a claude asker waited in its pane
  (`awaiting-reply`, then `continued` by the reply) for a claude pane keeper; codex, pi and cursor
  pane keepers were woken in their panes by a headless asker. Every asker returned the codeword;
  claude panes' deliveries were `observed`, the others' panes' `unconfirmed`. ~$0.26 for the four,
  ~$0.20 for claude's alone.
- Review: both reviewers' findings are resolved: rebased on main's claude pane paste and rerun;
  the receipt's grace; stronger pane tests; the eval's default back to the headless four.

### Task 8

- The testing API is the design's sketch, with what building it settled:
  - `messages` takes a `MessageScript`, called with a `ReceivedMessage`: the message, its `turn`,
    and `reply`, `send`, `silent` and `fail`. What it returns ends the turn, as `silent` unless it
    is a `reply`. A list is one entry per message operation, apart from `agents`, whose lists now
    count the agent's workflow turns, not its session's: a message operation shifts no agent
    script.
  - `turn.send` and `turn.reply` resolve to a `MessageOutcome`. A turn that ends awaiting a reply
    is recorded `awaiting-reply`; the turn that carries the reply resumes the same script call.
    `TurnRecord` adds `cause` and the `messages` shown.
  - `run.messagesOf(recipient)` gives `{ from, awaitReply, end, reason? }`. A question ends
    `replied` or `failed`, `reason` saying why (`timed-out`, `withdrawn`, `released`, or how its
    peer failed); any other message `delivered` or `undelivered`; `pending` until then.
  - `awaitReply: "listed" | "anywhere"`, not in the sketch: by default a test refuses
    `--await-reply` where the engine's list does, as a run would, so a test cannot pass where a run
    fails. `anywhere` tries a workflow's messaging on a harness the list does not have yet. Raised
    for the human review: it could be dropped once M2 has put harnesses on the list.
- The host ends a native turn once its script is still with a reply awaited: no host call in
  flight, a macrotask later. So a script awaiting a reply awaits only the host's calls; one that
  goes on regardless fails the test, saying so. A script answers only once its sends have returned,
  as an agent's `wf send` returns before its `wf result`.
- Limit of the test host: a script awaiting a reply cannot answer a third agent's question that
  continues its call; the test fails, saying the host cannot script it.
- Progress: a line per message admitted, above the live block or in the log; `awaiting {peer} ·
  {elapsed} of {total}` and `{n} queued` on an agent's line. `awf logs --agent` follows a message
  line from either side, and a question's line says who awaits it until when. `awf runs` shows an
  agent `awaiting` its peer's reply until its deadline; `--json` has `live.peer`. `cause` reaches
  `workflow.usage()` and `output.json`'s `usage`, which a runner test asserts.
- A message operation that fails fails the run, as any operation the run owns does (Q10), which a
  test now shows.
- Review: both reviewers' findings are resolved: a result racing the run's end, or submitted while
  a send was in flight, flaked under load and no longer does (1,680 runs under load, none failed);
  a script left awaiting when its call ends is let go, its wait `cancelled`; sends after a turn
  ended fail the test; `messagesOf`'s ends made one vocabulary; tests added for `turn.reply`,
  `message.send`, `message.fail` and a `silent` turn run again.

### Task 9

- M2 ran on the built engine, `experiments/m2-messaging`, a real workflow per trial: a planner must
  plan retries whose home is its architect's call, with a route to ask it. Findings R1–R7 in
  `docs/findings/messaging-m2.md`. The gate passed 80/80, 20 each on claude headless and in a
  pane, codex and pi: every asker sent with `--await-reply`, ended its turn with no sleep or poll,
  and finished with the answer, 77 ending their turn before it came; every peer answered with
  `wf reply` first time; all 160 deliveries were `observed`. The engine list now allows claude headless and in a pane that confirms delivery, and
  headless codex and pi.
- cursor stays off, 11 of 20 on `composer-2.5-fast`: its turns ran past the 6-minute deadline,
  four before asking; those that asked waited and used the answer. `composer-2.5` answered
  `[unavailable]` all day, outside awf too.
- The revision M2 called for was ours: the route lesson's "add `--await-reply`" put the flag after
  the peer in 60 of 60 first-round trials, which `wf` refused. The lesson now shows
  `wf send --await-reply <peer>`, and `wf` takes flags typed right after the peer; one after the
  message is still refused, and so is a message argument that starts with `--`, told to use a
  heredoc. 0 of 80 after.
- Ten claude panes started at once beside the headless rounds lost their first prompts to the
  30 s delivery window, workflow turns as much as messages (R6); two pairs at a time ran clean.
- `reviewLoop` is the design's. Building it showed feature-delivery's reviewer ran in a codex pane,
  which cannot await, so its default is now `{ alias: "codex", placement: "headless" }`. The
  ticket doc's `revise` prompt went with the old loop; the additional reviews' fix-up is
  `applyFeedback`. The live run showed the design's route both ways let the author, recording its
  work, ask the reviewer after approval; the route now runs from reviewer to author, which the
  author answers with `wf reply`.
- Live, 2026-10-12, on a one-file repo with a two-line ticket: the run completed in 3m26s,
  ~$0.82 at list prices. In implementation review the reviewer asked the implementer for a
  correction with `--await-reply`, was answered by `wf reply` and approved; in doc review the
  planner, recording its doc, asked the reviewer a question and was answered. Two messages per
  review, within its limit of six.
- Docs: `workflow-api.md` has Messaging, testing's Messages, and messages left out of Not built
  yet; `composition.md` the branded `ParticipantRef` and the review loop's `wf reply`; the design's
  status line, Q11 and M2; `status.md`.

## Human review

- [ ] Every task is complete and story-level verification passes.
- [ ] Set the story status to `awaiting-human-review` and present the outcome, architecture
  decisions, task-level subagent findings and dispositions, exact verification results, deviations,
  and remaining risks.
- [ ] Record the human's explicit approval or requested changes here.
- [ ] If changes are requested, return to the affected task and repeat its review and verification.
- [ ] Only after explicit approval, mark the story `done` and update `Stories at a glance`.
