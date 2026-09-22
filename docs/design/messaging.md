# Agent messaging

Messaging lets agents coordinate during a workflow run. Messages are short-lived coordination;
durable state belongs in shared files such as a ticket document or review ledger.

The workflow grants routes, prompts define the collaboration protocol, and the engine owns
delivery, waiting, limits, and accounting.

## Workflow interface

```ts
export type MessageAccess =
  | {
      from: AgentRef;
      to: AgentRef;
      between?: never;
      purpose: string;
    }
  | {
      between: readonly [AgentRef, AgentRef];
      from?: never;
      to?: never;
      purpose: string;
    };

export interface Messaging {
  /** Grants workflow-scoped routes atomically; conflicting purposes reject. */
  allow(access: MessageAccess): Promise<void>;
}

export interface WorkflowContext {
  // ...existing fields
  readonly messages: Messaging;
}
```

`from` and `to` grant one-way initiation. `between` grants both directions. A required response may
travel back over a one-way route, but does not create a permanent reverse route.

```ts
await workflow.messages.allow({
  between: [implementer, reviewer],
  purpose: "Review and revise the implementation until both agree it is ready.",
});
```

Routes use engine-issued `ParticipantRef` values. These normally refer to agents; a connected
outside session is the exception described in [`composition.md`](composition.md). The engine
validates that both endpoints belong to the current workflow scope. Each directed pair has one
purpose. Repeating the same declaration is idempotent; a conflicting purpose rejects atomically.
Routes last for their workflow scope and disappear when either endpoint stops or is released.

Workflows should grant routes before starting participating agents. A later grant is enforced
immediately, but does not rewrite an operation already generating; the agent discovers it through
`wf peers` or its next authenticated message.

An accepted message can continue an active operation or wake an idle retained agent. Waking an
agent creates an engine-owned message operation from its existing context, the route purpose, and
the inbound message. Its text result is not exposed to workflow code, but its usage is. A message
to an outside participant waits in that participant's inbox instead. Granting a route to an agent
therefore authorizes the recipient model work caused by messages on that route.

## Agent CLI

```sh
wf peers

wf send reviewer 'Findings are ready in REVIEW.md'
wf send reviewer < message.md
wf send reviewer 'The revision is ready' --expect-response
wf send reviewer --expect-response < message.md
wf send reviewer 'The revision is ready' --expect-response --timeout 5m

wf result '{"verdict":"approve"}'
wf result < result.json
```

`wf peers` lists the current agent's incoming and outgoing routes, their purposes, whether each peer
can currently accept an expected response, and replies the current operation owes. It is advisory;
`send` performs the authoritative check when accepting a message.

`send` takes its message from either the final argument or standard input. Without
`--expect-response`, it returns after the message is durably queued; this does not mean the peer has
read it. An idle retained peer is scheduled for a message operation without delaying the sender.

With `--expect-response`, accepting the message and creating the response obligation are atomic.
The command remains pending until the peer responds or an explicit failure occurs. The engine uses
a bounded default deadline; `--timeout` may override it within the configured maximum. While
waiting, the model is not generating and its model-execution permit is released.

For an agent, the obligation binds to its active operation, next queued operation, or a new message
operation if it is idle and retained. Result acceptance and obligation creation are serialized:
either the message wins and keeps that operation open for a reply, or completion wins and the send
is refused without queueing. For an outside participant, the obligation binds to its stable session
inbox and ends when that participant replies, is released, or reaches the deadline.

The peer sees that a response is required and receives one temporary send back, even on a one-way
route. Its next accepted send to the waiting agent satisfies the obligation. An operation may own
only one outgoing expectation at a time, so agents do not copy correlation ids. The trade-off is
that any send to that peer counts as the reply; an agent owing a response must not send unrelated
content first. An operation may owe several peers; each reply names its recipient.

The temporary reverse permission lasts until the bound operation settles. After the deadline, its
send becomes an ordinary late message and cannot create another expectation unless a permanent
route independently permits it.

A response send may itself use `--expect-response`. Crossing expectations are ordered atomically:
the later send satisfies the earlier obligation and creates the reverse obligation, so both agents
cannot become mutually blocked. The earlier sender receives a crossing notice saying that the peer
sent its message before seeing the earlier request and that it is not an answer to that request.

`wf result` completes the current operation. The engine rejects it while the operation owes a
response. A message operation uses the same result contract with an engine-owned text schema; its
result is internal.

## Delivery and failure

The engine presents every inbound message in an authenticated envelope containing the sender,
route purpose, and whether a response is required. Peer content is quoted as untrusted content and
cannot impersonate envelope metadata.

Messages to an active operation appear at its next safe model continuation; messages to an outside
participant appear through its inbox. Ordinary messages are presented in acceptance order. A
timely response completes the waiting `wf send` directly and is not duplicated in the sender's
inbox. A response arriving after its deadline becomes an ordinary message. Inbox and obligation
state live outside model context and survive compaction.

An expected-response message keeps a bound agent operation open until it replies or the obligation
ends. If the agent finishes without replying, the engine may nudge it. An outside participant has
no operation to hold or nudge, though its session may be woken. The waiting command receives an explicit failure on timeout,
delivery failure, recipient failure or cancellation, or an engine limit. If the engine refuses an
attempted reply after identifying its peer, the waiter receives the same failure immediately.

The CLI refuses a send before queueing when the route or target is invalid, the sender already has
an outgoing expectation, the target cannot accept a response obligation, or a message, time, or
spend limit has been reached.

Stopping an agent removes its routes and fails obligations involving it. Cancelling an operation
fails only obligations bound to that operation. Workflow completion cancels remaining waits and
records undelivered messages; nothing carries into a later workflow run.

## Review until convergence

The initial implementation finishes before review begins. The reviewer then owns the revision loop
and wakes the retained implementer only when it has findings or a final approval:

```ts
const implementation = await implementer.run({
  prompt: "Implement the approved ticket document and record the decisions made.",
  schema: IMPLEMENTATION_RESULT,
});

if (implementation.outcome.kind !== "answered") {
  return defer(implementation.outcome.reason);
}

const verdict = await reviewer.run({
  prompt: `
Review the completed implementation in ${implementation.outcome.value.docPath} and keep durable
findings in REVIEW.md.

Own the revision loop. When changes are needed, send the findings to the implementer with a
response expectation, then review the revision it reports. Once the implementation is ready, send
the approval with a response expectation and return the final verdict after acknowledgement.
`,
  schema: REVIEW_VERDICT,
});
```

```text
implementer                         reviewer
-----------                         --------
implements
returns implementation
                                    reviews completed implementation
                         <--------- send findings --expect-response
wakes, fixes, replies --------------> reviews revision
                         <--------- send approval --expect-response
wakes, acknowledges ----------------> returns verdict
```

The workflow starts only the initial implementation and review operations. Each later implementer
wake-up is an engine-owned message operation. Operations remain serialized within one `AgentRef`,
while different agents may run concurrently. Message traffic cannot prove semantic convergence;
the review verdict does.

## Agent binding and adapter seam

An agent runs a launcher the engine installed and names the call it was given; it copies no run,
message, or authority token into a command. The socket behind that launcher is what binds the
shared `wf` CLI to the workflow run and logical agent:

```text
agent socket + call id -> active operation -> open result schema
```

The call id keeps a delayed command from an earlier operation off a later one on the same agent;
the socket keeps one agent from answering for another. A harness that can deliver a prompt can
expose messaging and `wf result`, and delivering a prompt is all it has to do.

Messaging adds one capability to the internal harness seam:

```ts
export interface HarnessTurn<T extends JsonValue> {
  // ...existing members
  /** Continues this operation and resolves once the prompt is presented to the model. */
  deliver(prompt: string): Promise<void>;
}
```

The engine owns inboxes, permissions, envelopes, response matching, deadlines, and settlement. The
adapter only starts or continues model work and acknowledges presentation. A pending send may keep
the CLI invocation blocked or suspend the model at that boundary and resume it through `deliver`;
both preserve the same operation, context, result slot, and usage record.

## Usage and limits

Every workflow-started or message operation reports its resolved harness, model, backend, spend
pool, tokens, and cost through the existing usage interface. Missing usage remains unavailable
rather than becoming zero. Waiting time is wall time, not model usage.

Engine limits bound message volume, response waits, spend, and accidental ping-pong. Convergence
and the decision to retry, defer, or involve a person remain workflow concerns.

## Deferred surface

There is no `ask`, `tell`, visible message id, channel, team, broadcast, dynamic grant, or automatic
convergence primitive. Known fan-out uses `workflow.parallel`; shared files hold durable state.

`wf receive` remains deferred. Inbound delivery already wakes an idle retained agent. Outside
sessions have no operation to wake and read through the bounded `wf inbox --wait` described in
[`composition.md`](composition.md); waking such a session may prompt that call but never replaces
it.

## Open questions

- Which harnesses can keep a CLI invocation blocked, and which require suspended continuation?
- Can each adapter present `deliver` without losing an in-flight response or creating a second
  operation?
- A long-lived pane keeps one socket across operations, so what has to change per operation is the
  call id it is told. How does it learn the new one in a way that stops the old one working?
- Does a waiting harness consume provider concurrency or subscription capacity?
- Should workflows be able to tighten engine-wide message, response, and spend limits?
