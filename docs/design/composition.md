# Workflow composition and outside participants

Composition covers two related cases:

- a workflow calls a reusable child workflow without colliding with another call;
- a workflow exchanges messages with a session the engine did not start.

An outside session is a messaging participant, not an agent. The engine cannot run it, compact it,
or collect a result from it. The one exception is the session a run was started from with
`awf run --here`, which the workflow drives as an agent through `agents.caller`
([ADR 0010](../adr/0010-the-calling-session-is-an-agent.md)); it is never an outside participant.

## Calling a child workflow

Calling a `WorkflowDefinition.run` function directly is appropriate for a local helper. A reusable
child needs a scoped context so its agent keys, step ids, signals, routes, and nested calls cannot
collide with siblings.

```ts
export type WorkflowCallId = string;

export interface WorkflowCallSpec<Args extends JsonValue, Result extends JsonValue> {
  /** Idempotency key scoped to the caller. */
  id: WorkflowCallId;
  definition: WorkflowDefinition<Args, Result>;
  args: Args;
  /** Parent participants exposed under child-local keys. */
  participants?: Readonly<Record<ParticipantKey, ParticipantRef>>;
  label?: string;
}

export interface WorkflowContext {
  // ...existing fields
  call<Args extends JsonValue, Result extends JsonValue>(
    spec: WorkflowCallSpec<Args, Result>,
  ): Promise<Result>;
}
```

The call id forms one segment of the child's scope. Call ids have their own namespace; they do not
collide with step ids. Repeating an identical call returns the same result; reusing the id with a
different definition, arguments, participant bindings, or label rejects. Engine configuration
bounds nesting depth, including recursive definitions.

The child sees local keys. A bound participant is available through
`workflow.participants.get(localKey)` and may be used for messaging, but cannot be run merely
because its parent reference happens to be an `AgentRef`. This keeps the child dependency narrow.
Child-created agents remain usable for the duration of the call and stop when it returns. Bound
participants retain their parent's lifecycle.

Routes created by the child disappear when the call returns. Parent routes and bindings are not
changed. Steps, signals, and nested call ids are scoped the same way.

`usage()` is scoped too: a child sees its own operations and descendants, while the root sees the
whole run. Logs and usage carry the call path even though child code uses only local keys.

Admission remains global. A child's `parallel` concurrency is a local maximum under the run's
active-operation limit, so nesting cannot multiply capacity. If the child throws, `call` rejects.

Usage preserves structure rather than encoding it into an agent key:

```ts
export type OperationRecord = {
  /** Nested workflow call ids from outermost to innermost; empty at the root. */
  callPath: string[];
  agent: AgentKey;
  operationId: string;
  // ...execution, times, and native sessions
};
```

The same child can therefore run more than once against one parent participant:

```ts
const verdicts = await workflow.parallel(reviewers, (reviewer) =>
  workflow.call({
    id: `review:${reviewer.name}`,
    definition: reviewLoop,
    args: { base: "main", runtime: reviewer.runtime },
    participants: { author },
  }),
);
```

Each `reviewLoop` opens its own reviewer and resolves `author` from its participant directory.

## Connecting an outside session

```ts
export interface ParticipantRef {
  /** Logical key in the workflow context that issued this reference. */
  readonly key: ParticipantKey;
}

export interface ExternalParticipantSpec {
  key: ParticipantKey;
  /** Defaults to the workflow's discoverable session binding. */
  bindingPath?: string;
  labels?: JsonObject;
}

export interface ExternalParticipantRef extends ParticipantRef {
  /** Stops routing and fails outstanding response obligations involving this participant. */
  release(reason?: string): Promise<boolean>;
}

export interface ParticipantDirectory {
  /** Connects a session the engine did not start. */
  connect(spec: ExternalParticipantSpec): Promise<ExternalParticipantRef>;
  /** Finds an agent or connected participant visible in this workflow scope. */
  get(key: ParticipantKey): Promise<ParticipantRef | null>;
}
```

`AgentRef` also extends `ParticipantRef`, and messaging accepts `ParticipantRef` endpoints. Runtime
validation ensures references belong to the current scope. Agents and outside participants share
one key namespace within that scope, so `connect` rejects an occupied key.

`connect` creates an inbox and installs a CLI binding for the outside session. The default binding
is discoverable from the workflow working directory; `bindingPath` supports sessions that need an
explicit location. Installing a binding is exclusive and atomic. A second live connection cannot
replace it, and `release` removes only the binding owned by that reference.

The binding is the participant's own socket, held for as long as it stays connected rather than
for one operation. It permits `peers`, `inbox`, and `send`, but never `result`. Releasing the participant removes its routes,
discards unread ordinary messages, and fails outstanding response obligations. Workflow completion
does the same automatically.

When `bindingPath` is supplied, the outside session's CLI must already be configured to discover
that location. The model runs a launcher by path and names peers; it passes no authority token.

## Outside-session CLI

```sh
wf peers
wf inbox
wf inbox --wait 5m
wf send reviewer < round2.md
```

`inbox` prints unread messages in acceptance order. Messages are considered delivered only after
the command writes them successfully. Outstanding response obligations remain visible until they
are answered, even after their messages have been delivered.

`--wait` requires a bounded duration. It returns when a message arrives and exits unsuccessfully on
timeout, leaving inbox state unchanged. Delivery is always this pull: the engine has no operation
through which to run an outside session, so nothing is ever pushed into its context.

`send` follows the messaging contract. Sending to a peer awaiting this participant's response
satisfies that obligation and may add `--expect-response`. The participant may have at most one
outgoing response expectation at a time; responses it owes are distinguished by peer name, so no
message ids enter the CLI.

Peer names are qualified only when necessary. If two child calls both expose a local `reviewer`,
`wf peers` shows addresses such as `review:claude/reviewer` and `review:codex/reviewer`; `wf send`
accepts those addresses. Child code continues to use the local key `reviewer`. A peer address is a
human-readable route name, not a capability or correlation id.

Any CLI call reports outstanding obligations before its normal output. The engine can record
deadlines and release waiting agents, but it cannot force a quiet outside session to invoke the
CLI.

## Waking an outside session

A backend that can locate sessions it did not start may offer `OutsideSessionControl`, and the
engine then wakes a participant that has unread messages instead of waiting for it to look.

The wake carries no message. It only causes the session to take a turn; the content is still read
through `inbox`, so delivery semantics are unchanged and responsiveness is the only difference.
That is what makes the wake safe to repeat — a lost one costs nothing, so it is retried against
`status` rather than confirmed by the call that sent it.

The two receipts answer different questions and neither replaces the other. `status` reporting
`working` says a turn started, which is enough to stop waking. The participant's next CLI call says
the message was read. A `blocked` session is escalated rather than woken again, because no number
of turns clears a prompt that is waiting on a person.

The adapter discovers the session handle when it installs the CLI binding, so terminal identity
stays out of workflow code and out of the participant spec. Where no adapter provides the
capability, `wf inbox --wait` is the whole mechanism.

## Review loop

The parent connects the current author session and passes it into reusable review calls:

```ts
const author = await workflow.participants.connect({ key: "author" });

const verdicts = await workflow.parallel(reviewers, (reviewer) =>
  workflow.call({
    id: `review:${reviewer.name}`,
    definition: reviewLoop,
    args: { base, runtime: reviewer.runtime, findingsPath: reviewer.findingsPath },
    participants: { author },
  }),
);

await author.release("reviews complete");
```

Inside each child, the reviewer owns the loop:

```ts
const author = await workflow.participants.get("author");
if (!author) throw new Error("review-loop requires an author participant");

const reviewer = await workflow.agents.open({
  key: "reviewer",
  runtime: args.runtime,
  skills: [{ path: new URL("./skills/air-code-review", import.meta.url) }],
});

await workflow.messages.allow({
  between: [reviewer, author],
  purpose: "Report findings and receive dispositions until the branch is clean.",
});

const { outcome } = await reviewer.run({
  prompt: `
Review the working tree against ${args.base} and keep findings in ${args.findingsPath}.

Send each round to the author with a response expectation. Continue when dispositions arrive.
Return the verdict once nothing is open.
`,
  schema: REVIEW_VERDICT,
});
```

The outside session participates with the same files and a small CLI surface:

```sh
wf inbox
wf peers
wf send review:claude/reviewer < round2.md
```

Durable findings remain in files; messages carry only coordination.

## Deliberately absent

- detached child workflows or signal-delivered child results;
- workflows presented as agents;
- running or collecting results from an outside participant, other than the calling session
  (ADR 0010);
- sharing a runnable parent agent with a child workflow;
- visible message ids or authority tokens in agent commands.
