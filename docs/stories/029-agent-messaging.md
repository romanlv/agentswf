---
id: "029"
title: Agents in a run message each other over routes the workflow grants
summary: "`workflow.messages.allow` grants routes with a purpose; agents use `wf peers`, `wf send [--await-reply]` and `wf reply`; a message reaches an agent at a turn boundary and wakes it if idle, an awaited reply continues the sender's operation, and the engine owns delivery, obligations, limits and the record."
type: story
status: draft
priority: P1
epic: authoring
discovered_in: "docs/design/messaging.md, settled with the user 2026-10-11"
depends_on: ["018", "021", "024"]
---

# Agents in a run message each other over routes the workflow grants

The design is [[messaging]] (`docs/design/messaging.md`). It converged with the user on
2026-10-11, was reviewed from four sides, and was then checked against the code for this story.
This story links to it rather than copying it. Before `ready`, the questions under
[[#Open questions]] need answers.

## Outcome

A workflow lets two agents talk while both are working, without code passing text between them:

- The workflow grants a route with a purpose.
- An agent lists its peers, sends a note, or asks and waits for the answer.
- A message to an idle agent wakes it for one bounded operation.
- The engine keeps every message and obligation in the run's record, with what each wake cost.

Why now: Stage 4 of [[foundation]] starts with messaging, "the structural test", the one feature
that touches every package. Today `reviewLoop` in `examples/feature-delivery/reviews.ts` has to end
the reviewer's turn, hand its findings to code, and start the implementer again. With messaging,
the reviewer owns the loop ([[messaging#Review until convergence]]).

## How it works

```text
workflow                 engine (control plane)                  agents
--------                 ----------------------                  ------
messages.allow  ──────>  route {from,to | between, purpose, max}
                                                                 reviewer: wf send --await-reply implementer
                         admit: route? limit? ─────────────────  (atomic with the obligation)
                         reviewer's operation: waiting   <─────  reviewer ends its turn
                         implementer idle → message operation ─> implementer wakes, fixes,
                                                                 wf reply reviewer
                         obligation satisfied; reply queued ───> reviewer's same operation continues
                                                                 reviewer: wf result {call-id}
```

- **Routes.** `workflow.messages.allow` grants a one-way route (`from`, `to`) or both directions
  (`between`). Each carries a purpose that every envelope quotes, and an optional `maxMessages`.
  - A route granted in a stage closes when the stage ends.
  - A route closes when either endpoint stops.
  - Messages not yet shown when a route closes end `undelivered`.
- **Send and reply.** `wf send {peer}` returns once the message is durably recorded.
  - With `--await-reply`, the obligation is created atomically with the message.
  - The peer then owes a reply, and is held to it as to a result: its `wf result` and
    `wf waiting` are refused (`owes-reply`), and a turn that ends still owing gets one nudge
    naming the reply, within the check-in response window. If it still owes, the obligation fails
    and the sender is continued with that failure ([[messaging#Finishing]]).
  - `wf send --await-reply` is a tool call like any other: the sender may go on with work that
    does not need the answer. If its turn ends without a result, its operation waits for the
    reply. Awaiting never blocks `wf result`: a sender that finds the answer itself, or decides not
    to wait, finishes, and the wait is dropped. A request not yet shown is withdrawn and wakes
    nobody; a peer that has seen it no longer owes it, and its reply is refused `expired`.
  - The reply, or a failure, continues the same operation with the same call id.
  - `wf reply {peer}` is the only thing that satisfies an obligation.
- **Waking.** A message to an idle agent starts a *message operation*. An agent opened but not yet
  run is idle: the message starts its first turn, and a later `run` continues that session.
  - It settles when its turn ends with nothing awaited, and needs no `wf result`.
  - A turn that ends naturally is not a failure, even if a reply is still owed after its one nudge.
  - A request also continues an agent that is waiting on a reply. `--await-reply` is refused
    (`cycle`) when the chain of open waits from the peer leads back to the sender.
- **Delivery, at turn boundaries only.** An idle pane has the message typed into it. A headless
  agent gets it as a resumed turn (`resumeTurn`) once its process has exited. A busy agent gets it
  when its turn ends. Folding a message into a running claude turn is later, in
  [[mid-turn-messages]].
- **Where a sender can wait.** On a claude pane that confirms delivery, awaiting a reply uses
  `wf waiting`'s waiting state (story 021), ended by the reply instead of a timer. Any message also
  ends a check-in's `wf waiting` interval early. A check-in's `wf waiting` is refused headless,
  where its receipt cannot be confirmed ([[021-implementation-proof#Current support boundary]]). So
  headless, the process exits and the reply resumes the session as a fresh turn; this is new
  support. While a reply is awaited, `wf waiting` changes nothing and is only acknowledged, on any
  placement.
- **Settlement.** Every settle is a compare-and-set against the operation still open on the agent,
  so a late or stale reply is refused, not consumed.

The case people ask about first, "what if the peer never answers?": the peer is nudged once, and
then its obligation fails and the sender is continued with a failure that says what to do instead.
The same happens when the peer fails or stops, or when the sender's `--timeout` passes. The wait
never outlasts the sender's operation: at that operation's deadline, or its scope's, the operation
times out and the agent stops, as any timeout does.

## Scope

In scope:

- **Author surface.** `workflow.messages.allow` with `maxMessages`, and a branded `ParticipantRef`
  for agents. The validation, scope and waking rules are in [[messaging#Workflow interface]].
- **Agent commands:**
  - `wf peers`, with `--json`;
  - `wf send`, with `--await-reply` and `--timeout`;
  - `wf reply`;
  - `wf result` and `wf waiting` refused while a reply is owed; a result while awaiting drops the
    wait;
  - the obligation line;
  - all of it through the sandbox door.
- **Engine.** The messaging state machine in `engine/src/messaging/` ([[foundation]] §10), and its
  integration into the runner:
  - routes and their scope;
  - inboxes;
  - obligations;
  - message operations;
  - limits;
  - cycle refusal;
  - envelopes;
  - prompts that teach routes.
- **Harness.** `HarnessTurn.deliver` at turn boundaries:
  - headless, by `resumeTurn`, for all four harnesses;
  - idle panes, typed, for all four harnesses;
  - the fake harness too.
- **`--await-reply` support.** Claude panes that confirm delivery, plus headless claude, codex, pi
  and cursor ([[messaging#Q9. Where can a sender await a reply?|Q9]]). An engine allow-list, keyed
  by harness and placement, enables each combination once every model M2 measured on it passes. A
  model M2 did not measure is allowed on an enabled combination. A combination that is off refuses
  `--await-reply` with `unsupported`. The fake harness is always on.
- **Record and usage:**
  - the message and obligation record;
  - `cause` on operation, turn and usage records;
  - the ceilings written into the record.
- **Testing surface.** `messages` scripts, `turn.send`, `turn.messages`, `turn.reply`,
  `run.messagesOf` and `turn.cause` ([[messaging#Testing a workflow that messages]]).
- **Progress view.** Lines for accepted messages, waits and queues.
- **M1.** Tests and refusal of inbound cross-session messages, plus the measurement.
- **M2.** A live measurement against thresholds set in advance.
- **Example.** `reviewLoop` rewritten as review until convergence, with its test and one live run.
- **Docs.** `workflow-api.md` (Messaging, Testing, Not built yet), `composition.md` (branded
  `ParticipantRef`), `status.md`.

Out of scope:

- **Mid-turn delivery**, [[mid-turn-messages]]. Until then, in the lenses→fixer shape, findings
  continue the fixer's operation when its turn ends, and a finding after its result wakes a message
  operation outside its report.
- **`awf send`**, gated on M3: designed, not built.
- **`awf signal`** and the process inbox ([[workflow-styles]]).
- **Outside participants:** `participants.connect` and `wf inbox --wait` ([[composition]]). Their
  stubs stay published and throw `unavailable`.
- **The calling session (`agents.caller`) as an endpoint**, until [[attended-agent]]. Agents
  opened with `agents.forkCaller` (story 027) are ordinary agents and may be endpoints.
- **What [[messaging#Not in this design]] excludes:**
  - typed replies;
  - steer;
  - cancelling or editing queued messages;
  - reading transcripts;
  - pushed rooms;
  - broadcast.
- **`--await-reply` on codex, pi and cursor panes.**
- **An operator setting for the ceilings**, [[operator-settings]].
- **Closing a route in the middle of a stage.** Stages scope routes.
- **Spend limits**, [[live-spend-limits]].

## Context and evidence

Checked against the code on 2026-10-11 by two read-only reviews; what each found is under
[[#Review record]].

**The author surface:**

- `contract/src/workflow/messaging.ts` defines `MessageAccess` without `maxMessages`.
- `workflow.ts:85-88` publishes `participants`, `messages` and `signals`.
- `ParticipantRef` (`participants.ts`) is a plain `{ key }`. `AgentRef` extends it
  (`agents.ts:341`), and `LogicalAgent implements AgentRef` (`engine/src/workflow-runner.ts`).
- No example or test builds a `{ key }` literal, so branding breaks nothing.

**The harness seam:**

- `HarnessTurn.deliver(prompt): Promise<void>` is a stub (`harness/src/adapter.ts`,
  `session-core.ts:395` throws).
- `nudge` returns a turn with native `delivery` evidence. `NativeTurnRequest.kind` is
  `"turn" | "nudge" | "compact"`.
- `session-core` allows one active turn (`assertIdle`).
- The pane path waits for the agent to settle before it types (`adapters/herdr.ts`, the E8 comment).
- Pane idleness is observable, through Herdr `agent wait --until idle` and `agent_status`.

**Waiting:**

- `supportsWaiting` is set only with `confirmsDelivery` (`session-core.ts:498`).
- Only `adapters/herdr.ts:887` sets that: a claude pane awf launched on the host, or a sandboxed
  one in the run's own Herdr session with a seeded home (story 024). A claude pane in a sandbox's
  own Herdr session cannot wait, so it cannot await a reply.
- `direct-process.ts` never sets it. Headless waiting is refused
  ([[021-implementation-proof#Current support boundary]]).
- Headless `--await-reply` is therefore new: a reply resumes the session as a fresh turn. All four
  harnesses define `resumeTurn` (`harnesses/{claude,codex,pi,cursor}.ts`).

**A name collision:** `operation-liveness.ts:29,283` already has an `awaiting-reply` phase, and
`progress-view.ts` shows it as "awaiting reply". It is 021's check-in response window, up to
`responseMs` (120 s) for `wf waiting` or `wf result`, after which the turn is `unanswered`. It is
not a hook for messaging.

**Failure stops an agent:** `executeWaitingOperation` closes the agent on `failed` or `timed-out`
(`closeAfterFailure`, `workflow-runner.ts:2308`), and Q10 keeps that rule. A `cancelled` operation
does not close it there, though [[workflow-api#Outcomes]] says every unsuccessful operation does.
That gap predates this story and is left as it is; messaging relies only on timeouts and failures
stopping the agent.

**Serialization:** `LogicalAgent.#tail` serializes an agent's operations, but nothing counts what
is queued. Stages call `scope.seal()` then `settleOwned()` (`workflow-runner.ts:876-930`), and
scopes are AsyncLocalStorage.

**Control plane:**

- `startResultControlPlane` and `handleFrame` (`control-plane.ts`) are hard-wired to
  `ResultSlotRegistry`, which is indexed by `operationId` only.
- There is no lookup of the open operation for an agent.
- The wire is version 3, and every request carries `operationId`. Decoding rejects unknown fields
  and codes (`RESPONSE_CODES`, `RESULT_SUBMIT_CODES`).
- The test host already submits over the real socket, through `@agentswf/wf/client`
  (`workflow-testing/host.ts`).

**Records:**

- `OperationRecord` (`agents.ts:230`) reaches `SettledOperation` and `TurnRecord` through
  `TURN_OPERATION_FIELDS` (`records.ts:375`).
- `TurnRecord.kind` is `"turn" | "compact"`.
- `OperationTags` in `run-usage.ts:57` carries the per-operation tags.
- `turnsOf` exists (`workflow-testing/index.ts:91`).

**The M1 environment is mostly done:**

- `callingSessionEnv` in `harnesses/claude.ts` already lists `CLAUDE_CODE_MESSAGING_SOCKET` and
  `CLAUDE_CODE_MESSAGING_TOKEN`.
- `operator-runtime.ts:409-431` folds them into `WITHHELD_ENVIRONMENT` and
  `PANE_WITHHELD_ENVIRONMENT`. `withholding()` applies these headless, sandboxed and in panes
  (`herdr.ts` `emptyEnvironmentArgs`).
- What is missing: tests for each placement, and refusing inbound messages. Claude's changelog
  names `crossSessionInbound: "refuse"`.
- Host agents use the operator's `~/.claude`, so the setting has to be passed by `--settings` at
  launch. In a sandbox it goes in the seeded `settings.json` (`harness/src/sandbox-needs.ts:86`).

**Constraints:**

- Messaging cannot be one package ([[foundation]] §7). If a boundary has to move, stop and say so.
- The record is published once built, so its format is approved before anything writes it.
- Crash recovery is not built ([[foundation]] §10). After a crash, the record is read as it stands.
- Examples may import only `contract/workflow` (`scripts/check-boundaries.ts`, the author rule),
  and their tests also `@agentswf/engine/workflow-testing`, so the brand's symbol must be exported
  from neither.

**Assumption:** models end their turn when told to, and use `wf reply` rather than prose. M2
measures this. Agent Relay's "phantom" messages say some will not.

## Code map

### contract

- **`src/workflow/messaging.ts`:** `maxMessages`.
- **`src/workflow/participants.ts`:**
  - `ParticipantRef` is branded with a `unique symbol`. The symbol and the function that mints a
    ref live in a contract module reached only through an engine-side export path, never
    `contract/workflow`, so the engine and `workflow-testing` issue refs without `as unknown as`
    and examples cannot forge one;
  - `ExternalParticipantRef` and `ParticipantDirectory` stay as stubs.
- **`src/workflow/agents.ts`:** `cause` on `OperationRecord`. It is the one place a message
  operation is told apart; `TurnRecord.kind` stays `"turn" | "compact"`.
- **`src/records.ts`:**
  - `cause` added to `TURN_OPERATION_FIELDS`;
  - the message and obligation records, versioned like the others;
  - liveness kinds for a reply wait in `OPERATION_LIVENESS_KINDS` (`liveness.jsonl`).
- **`src/wire.ts`:**
  - version 4;
  - `peers`, `send` and `reply` requests, none with an `operationId`;
  - an `obligation` line on every response;
  - send codes `no-route`, `awaiting`, `cycle`, `limit`, `too-large`, `inbox-full`, `closed`,
    `peer-stopped`, `unsupported`, `no-operation`;
  - reply codes `none-owed`, `expired`, `closed`, `too-large`, `no-operation`, and with
        `--await-reply` the send codes `awaiting`, `unsupported`, `cycle`, `limit`;
  - `owes-reply` and `no-result` in `RESULT_SUBMIT_CODES`: `owes-reply` for `wf result` and
    `wf waiting`, and `no-result` for `wf result` and `wf waiting` given a message operation's call
    id;
  - `wf waiting`'s acknowledgement while a reply is awaited: a new response kind, `awaiting-reply`,
    carrying the peer and the reply's deadline, so `wf` never prints "waiting granted"; a
    `--timeout` given then is ignored.

### harness

- `src/adapter.ts`:
  - `deliver(prompt): Promise<HarnessTurn>`;
  - `cause` on `AuthoredTurn`, so the test host can tell a message operation apart.
- `src/session-core.ts`: replaces the stub, reusing the nudge path's evidence.
- `src/adapters/direct-process.ts`: headless delivery through `resumeTurn`.
- `src/adapters/herdr.ts`: pane delivery when idle.
- `src/harnesses/claude.ts`: `crossSessionInbound` by `--settings` on the host.
- `src/sandbox-needs.ts`: `crossSessionInbound` in seeded sandbox settings.
- `src/testing/fake.ts`: `deliver`, needed in task 2 so later tasks can run against the fake.

### engine

- `src/messaging/` (new). Holds the `--await-reply` allow-list by harness and placement, on for the
  fake from task 3, and:
  - routes, their scope and closure;
  - admission with limits, reservation and cycles;
  - inboxes and ordering;
  - obligations;
  - envelopes;
  - the record writer.
- `src/control-plane.ts`: a dispatcher for messaging requests beside `ResultSlotRegistry`.
- `src/result-slots.ts`:
  - an open-operation lookup by agent;
  - call ids for message operations, with no result slot (`no-result`);
  - `owes-reply`, and `wf waiting` only acknowledged while a reply is awaited, on any placement,
    with no check-in;
  - the compare-and-set on settle.
- `src/operation-liveness.ts`:
  - a peer-wait phase with a new name;
  - 021's `awaiting-reply` renamed `check-in-response`, and "awaiting reply" in the view likewise;
  - a reply continuation observed as a fresh working turn, not under the check-in response window;
  - a deadline that can move, where 021 fixed one per operation;
  - a reply wait that does not depend on `supportsWaiting` (`workflow-runner.ts:2229`,
    `operation-liveness.ts:77`).
- `src/workflow-runner.ts`:
  - `workflow.messages`;
  - a queue count on `LogicalAgent`;
  - a supervisor for message operations, which have no schema or result slot;
  - attaching message operations to their route's scope, a sealed one included, or to the attempt
    outside any stage, with a drain that repeats until nothing is in flight;
  - closing on stage end, `agents.stop` and the workflow's return.
- `src/run-progress.ts`, `src/progress-view.ts`: message lines.
- `src/run-usage.ts`: `cause` in `OperationTags`.
- `src/workflow-testing/`:
  - `messages` scripts, `turn.send`, `turn.messages`, `turn.reply`, `messagesOf` and `cause`;
  - `host.ts` submits sends and replies, and maps a reply's turn back to the pending `turn.send`.

### wf

- `src/cli.ts`, `src/client.ts`:
  - `peers`, `send` and `reply`;
  - the heredoc, standard-input and argument forms;
  - the obligation line printed from each response;
  - usage text.

### examples

- `examples/feature-delivery/reviews.ts`: `reviewLoop` becomes review until convergence, with its
  `*.test.ts`.

### docs

- `docs/workflow-api.md`, `docs/design/composition.md`, `docs/status.md`.

## Proposed design

As written in [[messaging]]. The state machine lives in the engine; the adapter only starts or
continues model work and reports what it observed ([[messaging#Agent binding and adapter seam]]).

Decided on 2026-10-11 while refining this story, and written into the design:

- **A sender waits across turns, never inside `wf send`**
  ([[messaging#Q1. Does a sender wait inside `wf send` or across turns?|Q1]]).
- **Replies are text, never typed** ([[messaging#Q4. Can a sender ask for a typed reply?|Q4]]).
- **An inbox shows counts, in acceptance order, with no editing for now**
  ([[messaging#Q5. How much of an inbox can be seen and changed?|Q5]]). A dropped wait already
  withdraws an unshown request; a sender withdrawing its plain messages would reuse that end, but
  it would be a fourth verb for M2 to measure.

- **Delivery at turn boundaries only**
  ([[messaging#Q2. How soon does `deliver` reach a busy headless agent?|Q2]]). Mid-turn claude
  folding is [[mid-turn-messages]].
- **`--await-reply` on claude panes and on all headless harnesses**
  ([[messaging#Q9. Where can a sender await a reply?|Q9]]).
- **Failure.** A message operation's natural end is not a failure; a timeout or a harness failure
  stops the agent ([[messaging#Q10. Does a message operation's failure stop the agent?|Q10]]).

Implementation decisions taken in review, also in the design:

- **Held messages.**
  - They join a workflow's `run` as well as a message operation.
  - In a `run` they follow its prompt, each in its envelope, and `cause` stays absent.
  - A request shown in a `run` becomes that operation's obligation.
  - `compact` and `set` carry none.
- **The end of a turn,** in the order in [[messaging#Finishing]]:
  - **A workflow operation:** awaiting, then waiting; held messages continue it; owing gets one
    nudge; otherwise the check-in.
  - **A message operation:** awaiting, then waiting; owing gets one nudge; then it settles, and
    held messages open a new message operation, with its own `cause`, scope and deadline, or join
    a workflow `run` already queued.
  - A message ends a check-in's `wf waiting` interval early.
  - An operation awaiting a reply is continued only by its reply, a failure or a request.
  - `wf waiting` is refused while a reply is owed. While one is awaited it changes nothing and is
    only acknowledged, on any placement; `wf result` drops the wait.
- **One route opens a message operation.** Messages held on other routes wait for the next one, so
  `cause` names one sender and the operation belongs to one scope. Once open, it may be continued
  from any route: by its awaited reply, by a request, and by plain messages held with the reply. A
  stage waits for the operations its routes opened to settle, and for every reply owed on its
  routes to be sent or fail, whatever operation owes it. After a stage's function returns, a
  reply's `--await-reply` on its routes is refused `closed`.
- **A stage owns the message operations its routes opened,** as it owns a `run`: one that times
  out or whose harness fails fails the stage, and a stage that throws or stops cancels them.
- **Routes.** A route is an ordered pair of agents with at most one open route at a time; a grant
  for an open pair must be identical or it rejects. Endpoints are any agents the workflow opened,
  in any scope. `maxMessages` above the ceiling is clamped.
- **Message operations have call ids,** named in their envelopes, with no result slot and no
  check-in: `wf result` and `wf waiting` refuse one (`no-result`), before any other check. Nothing
  shown to a message operation mentions `wf result`; it stops waiting only by its reply, a failure
  or its own `--timeout`.
- **A result drops a wait.** A reply accepted but not yet shown to the waiter ends `undelivered`
  (`withdrawn`), as an unshown request does; "shown" means `offered`.
- **Send and reply checks run in a fixed order,** given in [[messaging#`wf send`]] and
  [[messaging#`wf reply`]]; `peer-stopped` comes before `closed`, and `no-route` means never
  granted, so a closed route stays known for the attempt.
- **A reply and a timeout race** by compare-and-set on the obligation: once the reply is accepted,
  the timeout changes nothing.
- **One agent can reach a sibling's socket,** since agents share the engine's user; M3 measures it
  per placement.
- **`--timeout` past the default** is clamped, and the acknowledgement prints the deadline. Only
  `--timeout` continues a sender with a timeout failure; reaching its operation's own deadline
  times the operation out and stops the agent.
- **No call closes a route.** A route closes with its stage; a stage may exist only to scope one.
  `allow` returning a handle with `close()` is additive and waits for a workflow that needs it
  ([[messaging#Routes by shape]]).
- **The review example.** `reviewLoop` grants a `between` route per review stage, none when
  `maxRevisions` is 0, with `maxMessages` twice `maxRevisions`, asks the reviewer once, stops on
  `changes-requested`, and takes the work's typed value from one more author turn,
  `Record {subject}` ([[messaging#Review until convergence]]).
- **A reply with `--await-reply`** whose request check fails is refused whole.
- **The lenses→fixer shape** needs a claude pane until [[mid-turn-messages]], and each lens says
  `done` last.
- **`wf peers` states.** `not-started` (a message starts its first turn), `working`, `idle`,
  `awaiting {peer}` or `stopped` with a reason. A failed operation stops its agent, so `failed` and
  `done` are gone.
- **Message-operation deadline.** The later of 15 minutes from opening and the operation deadlines
  of the waiters whose requests it carries, capped by its scope's, and only ever lengthened. A
  waiter's `--timeout` fails only its obligation, never the replier's operation. It is in the
  ceilings table, and a timeout stops the agent as any timeout does.
- **Route closure.** A message not yet shown when its route closes is `undelivered`
  (`route-closed`). A reply already admitted still delivers.
- **Workflow return.** It refuses new sends and waits for message operations in flight, as a
  stage's end does. The attempt owns message operations opened by routes outside any stage: one
  that times out or whose harness fails ends the run `failed`, even after the workflow returned a
  value.
- **Plain messages and waiting senders.** A plain message to a waiting sender is held and
  delivered with its reply.
- **A message to an agent that has not run** starts its first turn, as a message operation through
  `HarnessSession.start`, as a first `run` does. `agents.open` already opens the session idle, on
  the host (`workflow-runner.ts:1247`) and sandboxed (`:1392`); a pane is placed at open and its
  harness launched by the first operation (`herdr.ts:1350-1357`), and both adapters prepend
  `instructions` to the first prompt of any kind. Nothing new is needed to open an agent asleep.
- **Every message operation opens with `HarnessSession.start`,** bound to its call id; `deliver`
  only continues an open operation.
- **A workflow operation that ends owing a reply** gets one owing nudge instead of the check-in.
- **Ceilings.** They are engine constants, written into the run's record.
- **A reply counts against its route's limit.** A request needs room for itself and its reply.
- **Delivery states.** `observed` needs `claude-receipt` on a claude pane, or the resumed turn's
  session record headless. Otherwise a message stays `unconfirmed`.
- **Compaction.** The obligation line restores obligations after a harness's own compaction. The
  design's "compaction focus" rule was dropped: operations are serialized, so awf's `compact`
  never runs while an obligation is open.
- **The record**, in the design's [[messaging#The record]], goes in `messages.jsonl` in the
  attempt's directory, one event per line, with `admitted` written before `wf send` returns.

Alternatives rejected, with reasons in the design's Decisions:

- **A sender blocking inside `wf send`** (Q1).
- **"The next send is the reply"** (Q7).
- **The crossing rule.**
- **Typed replies** (Q4).
- **A per-run limit** (Q3).
- **Any message-operation failure stopping the agent** (Q10).

## Tasks at a glance

- [ ] 1. Claude agents cannot message around their routes (M1)
- [ ] 2. Types, wire v4, record format and the `deliver` seam are settled
- [ ] 3. The messaging state machine admits, queues and settles, as pure code
- [ ] 4. The runner wakes, continues and closes through it, against the fake harness
- [ ] 5. `wf peers`, `wf send` and `wf reply` work over the control plane and the sandbox door
- [ ] 6. Headless agents receive messages and await replies
- [ ] 7. Panes receive messages when idle, and claude panes await replies
- [ ] 8. A workflow's tests script messages; the progress view and usage show them
- [ ] 9. Agents operate the protocol live (M2); the review example converges; docs updated

## Open questions

### Q11. What must M2 show before `--await-reply` is enabled?

Task 9. [[messaging#Q11. What must M2 show before `--await-reply` is enabled?|Q11]] in the design.

- **Pass thresholds, proposed, per harness and model over 20 trials:**
  - at least 18 turns ended correctly after `--await-reply`;
  - at most 2 prose-only replies;
  - at most 2 `sleep` or `peers` polls;
  - no obeyed forged-operator fence;
  - obligation recalled after the harness's own compaction (`/compact` in a pane) in at least 18.

  Confirm them or change them before the run.

## Task execution rule

Process one task at a time. Every task repeats the checklist shown under its details. Do not begin
the next task because the current implementation merely compiles: its design must be recorded, its
diff reviewed by subagents, findings resolved, and focused verification complete.

After all tasks are complete, run story-level verification and request human review of the complete
deliverable.

## Task details

Every task runs the same checklist:

- [ ] Plan
- [ ] Implement
- [ ] Review: two subagents, one for architecture and scope, one for correctness and proof
- [ ] Resolve
- [ ] Verify

[[README#Task and story gates]] says what each step requires.

### 1. Claude agents cannot message around their routes

Outcome: an awf-launched claude agent can neither reach a peer or the operator's session over
claude's cross-session socket nor receive from one. This holds on the host and under srt and
docker.

Work:

- Check first that `crossSessionInbound: "refuse"` exists in the installed claude, and what
  `--settings` does with it. If it does not exist, record that and rely on withholding.
- Pass it by `--settings` on the host, and in seeded sandbox settings.
- Add tests that the messaging variables are withheld for headless, sandboxed and pane agents.
  They already are, but untested.
- Run M1: send from an agent in each placement, including with a token read with `ps eww`.

Done when:

- the tests show the variables absent for every placement, and the setting present if it exists;
- M1's result is in [[messaging#To measure]] and `docs/findings/`. If the host is still reachable,
  the story stops for a decision.

### 2. Types, wire v4, record format and the `deliver` seam are settled

Outcome: everything another package will import is final before any of it is used.

Work:

- **Contract:**
  - `maxMessages`;
  - the brand;
  - `cause`;
  - the reply-wait liveness kinds.
- **Wire v4:** requests, responses, the obligation line and every refusal code in the Code map. An
  old launcher is refused, as 021 did at v3.
- **The record:**
  - a written draft of `messages.jsonl`: events, fields, states, version;
  - `cause`;
  - the ceilings in the run's record.
- **Harness:** `deliver(prompt): Promise<HarnessTurn>`, `cause` on `AuthoredTurn`, and `deliver`
  on the fake harness.

Done when:

- the design's author-surface examples compile in a typecheck file, and a `{ key }` literal does
  not. The testing sketch is settled in task 8;
- wire round-trip tests cover every code;
- the user has approved the record draft, the new liveness kinds, and `cause` on turn records.

### 3. The messaging state machine admits, queues and settles, as pure code

Outcome: `engine/src/messaging/` decides every case in the design, without I/O beyond its record
writer.

Work:

- **Routes:**
  - validation;
  - idempotence;
  - scope and closure;
  - `route-closed` for messages not yet shown.
- **Admission:**
  - route, limit, size and unread checks;
  - reserved room for a reply;
  - cycle refusal over open waits, ignoring the obligation a reply with `--await-reply` answers;
  - atomic request plus obligation.
- **Inboxes:** acceptance order; plain messages to a waiting sender held with its reply.
- **Obligations:**
  - satisfied by `wf reply` only;
  - `none-owed` and `expired`;
  - failing on timeout, stop or cancel;
  - a peer's late reply refused.
- **Envelopes.** The three kinds, from [[messaging#What a delivered message looks like]]:
  - a message;
  - an awaited reply;
  - a failure.

  Each has a nonce fence of at least 8 hex characters, escapes fence-like lines, quotes the
  purpose and names the call id.
- **Prompt text:** the route lesson in an operation prompt, the route announcement, and the owing
  nudge.

Done when:

- unit tests cover each bullet;
- the envelope tests include a forged fence and a forged header.

### 4. The runner wakes, continues and closes through it, against the fake harness

Outcome: the runner carries out every messaging rule on the fake harness. Tests drive sends and
replies through `engine/src/messaging`'s own interface, the one task 5's dispatcher calls; the
`wf` commands come in task 5.

Work:

- `workflow.messages`, with grants bound to the current scope, route identity and the
  `maxMessages` clamp.
- **Waking:** a queue count on `LogicalAgent`, and a message operation only when nothing is queued.
- **Message operations:**
  - a supervisor of their own;
  - a natural end settles;
  - one owing nudge;
  - a timeout or a harness failure stops the agent (Q10);
  - one route opens a message operation and fixes its `cause` and scope, and continuations may
    come from any route;
  - a stage waits for the operations its routes opened, and for every reply owed on its routes to
    be sent or fail;
  - the deadline: the later of 15 minutes and the waiters' operation deadlines, lengthened only;
  - a stage owns them: a timeout fails the stage, a throw or stop cancels them. A sealed scope still
    takes them, since a message held before the function returned may open one after the seal, and
    the drain repeats until nothing is in flight;
    - outside any stage the attempt owns them, and a failure ends the run `failed`;
  - a message to an agent opened but not yet run starts its first turn.
- **Held messages:** they join a workflow's `run` after its prompt, and a request shown there
  becomes that operation's obligation.
- **A turn's end,** in the design's order:
  - for a workflow operation, held messages continue it before any check-in;
  - for a message operation, held messages open the next one, or join a `run` already queued;
  - a message ends a check-in's `wf waiting` interval.
- **Waiting senders:** continued by a reply, a failure or a request; `wf waiting` only
  acknowledged; `wf result` drops the wait.
- **Settlement:**
  - `wf result` and `wf waiting` refused while a reply is owed;
    - a result while awaiting drops the wait: an unshown request withdrawn (`withdrawn`), a seen one
    released, its late reply `expired`; a reply accepted but not shown also `withdrawn`;
  - a reply racing its waiter's timeout, settled by compare-and-set;
  - the compare-and-set on settle;
  - an open-operation lookup by agent.
- **Endings:**
  - stage end and the workflow's return wait for message operations in flight;
  - `agents.stop` closes routes;
  - the attempt's end records undelivered messages;
  - the ceilings written into the run's record.
- **Phases:** 021's `awaiting-reply` renamed, and a peer-wait phase added.

Done when:

- runner tests on the fake harness cover each bullet, including races between a send, a stage
  ending and an agent stopping;
- 021's waiting tests still pass under the renamed phase.

### 5. `wf peers`, `wf send` and `wf reply` work over the control plane and the sandbox door

Outcome: an agent's commands behave and print as in [[messaging#Agent CLI]].

Work:

- The three verbs, in the heredoc, standard-input and argument forms; `--json` on `peers`.
- The obligation line from each response.
- The "may have been queued" acknowledgement.
- Exit codes 0, 1 and 2.
- Usage text with the launcher's full path.
- A messaging dispatcher in `control-plane.ts`.
- Forwarding through the sandbox door, as 021 task 2 tested for `wf waiting`.

Done when:

- CLI tests check every acknowledgement and refusal line written in the design;
- end-to-end tests run over a real socket, on the host and through the srt door.

### 6. Headless agents receive messages and await replies

Outcome: on headless claude, codex, pi and cursor:

- a message to an idle agent wakes it by `resumeTurn`, and one to an agent that has not run by
  its first `start`;
- a message to a busy one waits for its process to exit;
- a sender that awaits a reply is continued by one.

Work:

- `deliver` in `direct-process.ts`.
- A reply continuation observed as a fresh working turn, not under the check-in window.
- `wf waiting` while awaiting a reply acknowledged headless, changing nothing.
- `observed` from the resumed turn's session record.
- `--await-reply` allowed headless by the allow-list, which stays off for each combination until
  task 9.

Done when:

- harness tests with the fake cover wake, held delivery and continuation;
- one live smoke per harness delivers, wakes and continues, with the allow-list forced on for the
  smoke.

### 7. Panes receive messages when idle, and claude panes await replies

Outcome: in a pane, a message is typed only when the agent is idle. A claude pane's sender awaits
a reply as with `wf waiting`.

Work:

- `deliver` in `herdr.ts`: wait for idle, then type, with `claude-receipt` on claude.
- Await-reply on claude panes through the waiting machinery, behind the allow-list like headless.
- Codex, pi and cursor panes refuse `--await-reply` with `unsupported`.

Done when:

- adapter tests cover typing only when idle;
- one live smoke per harness in a pane delivers a message, read or recorded `unconfirmed`, with the
  allow-list forced on for claude;
- a claude pane awaits and is continued.

### 8. A workflow's tests script messages; the progress view and usage show them

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
  - a turn ended with `reply.waiting` or `reply.silent` invoked again with held messages;
  - continuations as turns of their own in `turnsOf`;
  - `run.messagesOf` and `turn.cause`;
  - a missing script for a woken agent fails the test.
- **The test host:** submits sends and replies, and maps a reply's turn back to the pending
  `turn.send`.
- **Progress:** lines for accepted messages, waits and queues; nothing for idle agents.
- **Usage:** `cause` in `workflow.usage()` and `output.json`.

Done when:

- the user has approved the testing surface's names and types before it is built;
- the design's testing sketches, the review loop and lenses→fixer, pass as real tests;
- progress-view tests show the three line kinds.

### 9. Agents operate the protocol live; the review example converges; docs updated

Outcome:

- each harness and placement that passes M2 is on the allow-list;
- one that fails stays refused, with the reason recorded;
- the review example runs live;
- the docs say what is built.

Work:

- **M2** on the E8 setup: 20 or more trials per harness, placement and model, counting what
  [[messaging#To measure]] lists, against the thresholds confirmed in Open questions. Cheap models,
  on codex where claude is not under test.
- **Revisions:** prompts and envelopes revised from the counts.
- **The example:** `reviewLoop` in `examples/feature-delivery` rewritten as review until
  convergence, with its test, and run live once.
- **Docs:**
  - `workflow-api.md`: Messaging, Testing, and Not built yet;
    - `composition.md`: the branded `ParticipantRef`, and its review loop asking with
    `wf send --await-reply` and answered with `wf reply`;
  - `status.md`;
  - the design's status line.

Done when:

- M2's counts are in `docs/findings/`, and the allow-list, by harness and placement, matches them;
- the example's test passes, and its live run reaches a verdict within its `maxMessages`.

## Verification

Automated:

- [ ] focused tests named in each task
- [ ] `bun test`
- [ ] `bunx tsc --noEmit`
- [ ] `bun run check`, with no boundary moved

Manual or live evaluation, with costs estimated in [[testing]] first:

- [ ] M1 on the host, srt and docker (task 1).
- [ ] Delivery smokes: headless per harness (task 6), panes per harness (task 7).
- [ ] M2, at least 20 trials per harness and model (task 9).
- [ ] The review example, live, once (task 9).

## Review record

### Refinement, 2026-10-11

- **Code against the story** (one subagent).
  - **Corrected:**
    - headless waiting is not supported today;
    - `awaiting-reply` is 021's check-in window;
    - the M1 environment is already withheld (`operator-runtime.ts`, not `command.ts`);
    - the review loop is `examples/feature-delivery`;
    - `cause` belongs on `OperationRecord`.
  - **Added:**
    - the wire v4 and dispatcher;
    - an open-operation lookup;
    - a message-operation supervisor;
    - a queue count;
    - scope attachment;
    - the fake's `deliver` moved earlier;
    - where the brand lives;
    - the dependency on 024.
  - **Not taken:** "cursor has no `resumeTurn`". It does (`harnesses/cursor.ts:80`).
- **Story against the design** (one subagent).
  - **Contradictions:**
    - headless support;
    - failure stopping the agent;
    - the phase name.

    The first two became Q9 and Q10; the third is a rename.
  - **Undecided behaviour,** now written into the design:
    - held messages;
    - the default deadline;
    - route closure;
    - the workflow's return;
    - ceilings;
    - reply room;
    - delivery states;
    - new refusal codes and texts;
    - route lessons;
    - the owing nudge.
  - **Tasks 3 and 5 split.**
  - **The M2 gate made explicit** with an allow-list.
  - **Docs added as work.**
  - **Delivery reduced to turn boundaries** by the user's decision, which removed the adopted-turn
    machinery.

### Second pass, 2026-10-11

- **Story against design and code** (one subagent).
  - **Two blocking gaps, now decided:**
    - plain messages and a turn's end, which the lenses→fixer shape needs;
    - held messages joining a `run`, with no format or test surface. Now `turn.messages` and
      `turn.reply`.
  - **Fixed:**
    - leftover "operator ceilings", "never stopping" and "fold in" text;
    - the 15-minute deadline added to the ceilings;
    - the allow-list key;
    - task 4's test path;
    - the record approval widened to liveness kinds and `cause`, with no new `TurnRecord.kind`;
    - `wf peers` states;
    - `sandbox-needs.ts` moved to harness;
    - the boundary cite;
    - "forced compaction";
    - wire codes;
    - task 1's conditional;
    - "an attempt".
  - **Eight or more code claims** spot-checked correct.

### Third pass, 2026-10-11

- **Story against design and code** (one subagent).
  - **One blocking gap, now decided:** a message operation continued by every later message would
    hit its 15 minutes and stop the agent. Held messages now open a new message operation instead.
  - **Fixed:**
    - the order at a turn's end, for both kinds of operation;
    - `wf waiting` refused while owing;
    - reply codes, and a reply refused whole when its own request is refused;
    - `--timeout` clamped;
    - the cancel wording against the code;
    - lenses→fixer limited to claude panes, with `done`;
    - the testing sketch:
      - result kinds that do not clash with `reply`;
      - `end` not `state`;
      - re-invocation with held messages;
      - continuations in `turnsOf`;
    - the testing surface approved in task 8, not task 2;
    - allow-list coverage;
    - the `wf peers` example.

### Fourth pass, 2026-10-11

Its `awaits-reply` refusal is superseded by the User decision below.

- **Story against design** (one subagent).
  - **Three blocking gaps, now decided:**
    - a message operation carrying several routes' messages had no single `cause` or scope; now
      one route per operation;
    - `wf result` while awaiting had no code; now `awaits-reply`;
    - two story lines still said a cancel stops the agent.
  - **Fixed:**
    - the testing sketches type-check in shape and wait for every lens;
    - the allow-list's place in the Code map;
    - `expired` wins over `closed` for a reply to a stopped waiter;
    - the `wf peers` example;
    - "turn's number".

### Fifth pass, 2026-10-11

- **Story against design and code** (one subagent).
  - **One blocking gap, now decided:** "one route per operation" against continuations from other
    routes. One route opens the operation and fixes its `cause` and scope; continuations may come
    from any route; a stage waits for operations carrying an open obligation on its routes.
  - **Checked consistent:**
    - result codes against wire v3;
    - `expired` over `closed`;
    - the turn-end orders;
    - the testing sketches against `script.ts`;
    - the allow-list;
    - the task order.

### Sixth pass, 2026-10-11

- **Story against design and code** (one subagent).
  - **One blocking gap, now decided:** whether a stage waits for a foreign operation to settle or
    only for the reply it owes. Now it waits for the reply, sent or failed.
  - **Also settled:**
    - a request continuing a message operation moves its deadline;
    - a reply's `--await-reply` after a stage returns is refused `closed`.

### Seventh pass, 2026-10-11

- **Story against design and code** (one subagent): no blocking findings. Two clauses added:
  - what happens at a stage's end to messages held before its function returned;
  - Finishing names both halves of the stage wait.

### Eighth pass, 2026-10-11

Its `wf waiting` reset of a reply wait is superseded by the User decision below.

- **Fresh read of story, design and code** (main session).
  - **Decided with the user:**
    - a reply wait that reaches its operation's deadline times out and stops the agent; only
      `--timeout`, a peer's failure or stop, or a failed obligation continue the sender;
    - the review example rewritten against `reviews.ts` as it is after b9cb6d0: shared by every
      review stage, `Session` and `Subject`, a final `Record {subject}` turn;
    - no call closes a route mid-stage.
  - **Fixed:** the cycle check on a reply with `--await-reply` ignores the obligation it answers;
    otherwise `wf reply --await-reply` to the waiter was always `cycle`.
  - **The user's comments answered:** rooms as a stopgap, route closing, `awf send` finding runs
    by folder, the owing nudge, a sender going on working after `--await-reply`, and `wf waiting`
    applied to replies.
  - **Decided with the user:** `wf waiting` while awaiting a reply is accepted and resets the
    reply wait, capped by the operation's deadline, not refused.
  - **Confirmed by the user:** Q1 and Q4; Q5 for now, with room for withdrawing left in the record.
  - **Noted:** story 024 is `awaiting-human-review`; task 7 needs it done, tasks 1 to 6 do not.

### Ninth pass, 2026-10-11

- **Design soundness** (one expert subagent).
  - **Two blocking gaps, now decided:**
    - a waiter's `--timeout` bounded the replier's operation, so a peer could stop it. A message
      operation is now bounded by its waiters' operation deadlines, lengthened only, and a
      `--timeout` fails only its obligation;
    - a stage's drain had no outcome. A stage owns the operations its routes opened, as it owns a
      `run` (`settleOwned`): a timeout fails the stage, a throw or stop cancels them.
  - **Fixed:**
    - a reply racing its waiter's timeout;
    - route identity and overlapping grants;
    - `maxMessages` above the ceiling clamped;
    - the socket's limit stated and added to M3;
    - call ids for message operations (`no-result`);
    - where the brand is minted;
    - reserved reply room released when an obligation fails;
    - `messages` scripts as arrays, and the reviewer's turns in the sketch;
    - a route's worst-case wakes;
    - the review example with no revisions, and where it can run.
- **Story against design and code** (one subagent).
  - **One blocking break:** the story's frontmatter had been rewrapped into a paragraph by a
    formatting pass, now restored.
  - **Fixed:**
    - `awaits-reply` is not only after a request;
    - what continues a sender: no "refused reply";
    - `wf waiting` while awaiting, against the headless refusal and the code's `supportsWaiting`
      gate, now in the Code map and tasks 4 and 6;
    - `wf waiting` refused while owing, now in Scope and task 4;
    - which claude panes can wait (`herdr.ts:887`);
    - the allow-list written into the design's Q9;
    - grant endpoints are agents the workflow opened, not the scope's;
    - a message operation's held messages may join a queued `run`;
    - `reviewLoop` runs in every review stage;
    - the record's file and events in the design;
    - the ceilings written into the record in task 4.
  - **Code citations** all held, except `herdr.ts:887`'s condition.

### Tenth pass, 2026-10-11

Its `not-awaiting` code is superseded by the User decision below.

- **Fixes checked** (one expert subagent): all nine held in both docs and against the code;
  `BLOCKING: none`.
  - **Fixed:**
    - the message-operation deadline is the later of 15 minutes and the waiters' deadlines, so a
      waiter near its own deadline cannot shorten the replier's;
    - a top-level message operation that fails ends the run `failed`, even after its value;
    - `wf waiting` on a message operation awaiting nothing is refused `not-awaiting`;
    - the stage drain takes operations opened after the seal, and repeats;
    - the `cycle` refusal worded for a ring through a third agent;
    - `maxMessages` a positive integer;
    - the seeded-home condition in Q9;
    - the review example's stop reason, and its `Record` turn after an approval with no revision
      accepted;
    - the M2 thresholds numbered Q11, in the design too.

### User decision, 2026-10-11

- **`--await-reply` never blocks `wf result`.** The agent chose to wait, so it may stop waiting:
  a result settles the operation and drops the wait, as a cancel does. A request not yet shown is
  withdrawn (`undelivered`, `withdrawn`); a peer that has seen it no longer owes it, and its reply
  is refused `expired`. `awaits-reply` is removed.
- **The `cycle` refusal stays.** Dropped, then restored after review: a turn that owes and awaits
  waits before its nudge, and a waiting agent cannot run `wf result`, so a ring of waits would hold
  until a deadline stopped its agents.
- **`wf waiting` no longer resets a reply wait.** While a reply is awaited it changes nothing and
  is acknowledged with the reply's deadline, which only `--timeout` sets. `not-awaiting` is removed;
  on a message operation `wf waiting` is refused `no-result`, as `wf result` is.

- **A message starts an agent that has not run.** An agent opened and not yet run is idle, and a
  message starts its first turn as a message operation. A workflow can keep an agent on call and
  pay for it only if a peer needs it, and a request to it no longer waits for a `run` that cannot
  come until the stage returns.

## Readiness

- [x] Outcome and boundaries are concrete.
- [x] Relevant implementation, callers, and tests are mapped.
- [x] Evidence and research support the proposed design.
- [x] Expensive interface, record-format, and stage-gate decisions are settled. The record format
  is approved inside task 2.
- [x] Tasks are ordered, coherent, and independently verifiable.
- [ ] Open questions are resolved or explicitly moved out of scope.

## Implementation notes

## Human review

- [ ] Every task is complete and story-level verification passes.
- [ ] Set the story status to `awaiting-human-review` and present the outcome, architecture
  decisions, task-level subagent findings and dispositions, exact verification results, deviations,
  and remaining risks.
- [ ] Record the human's explicit approval or requested changes here.
- [ ] If changes are requested, return to the affected task and repeat its review and verification.
- [ ] Only after explicit approval, mark the story `done` and update `Stories at a glance`.
