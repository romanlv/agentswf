# Workflow composition and outside participants

Composition covers two related cases:

- a workflow calls a reusable child workflow without colliding with another call;
- a workflow exchanges messages with a participant outside the run, such as a coordinator.

An outside participant is a messaging participant, not an agent. The engine cannot run it, compact
it, or collect a result from it. The one exception is the session a run was started from with
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

**Peer addresses.** Outside its own call, an agent is named by its address: each call id on its
call path, outermost first, followed by `/`, then its key, so `review:claude/reviewer`, or
`outer/review:claude/reviewer` nested one deeper; a root agent's address is its key. `wf peers`
and `wf send` qualify only when necessary: if two child calls both expose a local `reviewer`, they
show and accept `review:claude/reviewer` and `review:codex/reviewer`. A holder's commands
([[messaging#Coordinator CLI]]) always print an address qualified, so it never changes once
printed, and accept a bare key only when one agent in the run has it, else `ambiguous`. Child code
keeps using the local key. An address is a human-readable route name, not a capability or
correlation id.

## Connecting an outside participant

A participant outside the run is something the engine did not start and never runs: a coordinator
(built in [[032-run-coordinator|story 032]]; child calls, and so a participant passed into one, are
not built). Whatever answers for it, the holder, is `awf run`'s own
terminal, another claude or codex session, or an app such as a Slack bridge; the workflow never
knows which.

```ts
export interface ParticipantRef {
  /** Logical key in the workflow context that issued this reference. */
  readonly key: ParticipantKey;
  /** Only the engine makes one, so a `{ key }` literal is not a ref. */
  readonly [PARTICIPANT]: true;
}

export interface ExternalParticipantSpec {
  key: ParticipantKey;
  /** For whatever answers as it: passed along in `awf inbox`'s `route` items, never read by awf. */
  labels?: JsonObject;
}

export interface ExternalParticipantRef extends ParticipantRef {
  /** Closes its routes and ends every question open to it, `released`; `false` when it was released already. */
  release(reason?: string): Promise<boolean>;
}

export interface ParticipantDirectory {
  /** Connects a participant outside the run; an occupied or reserved key rejects. */
  connect(spec: ExternalParticipantSpec): Promise<ExternalParticipantRef>;
  /** Finds an agent or connected participant visible in this workflow scope. */
  get(key: ParticipantKey): Promise<ParticipantRef | null>;
}
```

```ts
const coordinator = await workflow.participants.connect({
  key: "coordinator",
  labels: { audience: "operator" },
});
await workflow.messages.allow({
  between: [investigator, coordinator],
  purpose: "report findings that hold up; ask when the logs can't settle it",
  timeoutMs: 2 * 60 * 60_000,
});
```

`AgentRef` also extends `ParticipantRef`, and messaging accepts `ParticipantRef` endpoints. A ref
is branded with a symbol exported only from `@agentswf/contract/participant`, which a workflow
cannot import, so only one the engine issued type-checks (built in story 029). Runtime validation
ensures references belong to the current scope. Agents and outside participants share one key
namespace within that scope, so `connect` rejects an occupied key. A reserved key, `operator`, `awf`, `system` or `user`, which
an agent could read as authority, is refused from the start, so that no workflow comes to rely on
it: by `connect`, by `agents.open`, so no agent's `wf send` arrives "from operator", and by a call's
`participants` map, so a child never sees an `operator` either.

An outside participant is named by the key it was connected under, across the whole run: unlike an
agent's, it is not qualified by call path, so `connect` rejects a key any participant holds anywhere in the run, an agent's or an outside
participant's, a child call's included. One passed into a child call under another local key keeps that name
in the record and the CLI; the local key exists only inside the child. No agent anywhere in the
run may take a key an outside participant holds, so a route's two ends never read alike in the
record. To the holder's commands
every outside participant is a coordinator: `awf inbox`'s `coordinator` field, `--as` and the
`no-coordinator` code all mean this key.

`connect` records the participant and its `labels` in the run log (`participant-connected`), and
opens the socket `awf reply` and `awf send` reach the run through. It waits for no one and says
nothing about who answers: a run with nobody holding its coordinator is fine, its messages wait in
the run log and its questions until they are answered. `labels` is any JSON object, written for the
holder; awf only passes it along.

An outside participant differs from an agent where an agent's behaviour hangs on an operation:

| | An agent | An outside participant |
| --- | --- | --- |
| Messages to it | held in an inbox until a turn boundary; unread ones keep a stage busy, and at most 16 | in the run log only: no inbox in memory, no cap, no busy stage, nothing dropped |
| Reading | shown at its next turn | `awf inbox`, from the run log with a cursor, both directions, during the run and after it |
| Answering | `wf reply {peer}` | `awf reply {run} {agent} [--to {id}]`, `--to` needed unless one question from that agent is open |
| Sending first | `wf send {peer}` | `awf send {run} {agent}`, over a route the workflow allowed |
| Message ids | none in the CLI | `{attempt}.{n}` in `awf inbox`, for `--to` |
| A question to it | the asker waits within its operation's deadline | open once recorded; the asker's clock stops while it waits ([[messaging#Waiting for an outside participant]]) |
| Asking | `--await-reply`, one at a time | never: it doesn't ask |
| When the workflow returns | new sends refused; its message operations in flight are awaited, and it stops when the run ends | stays connected while a question to it is open, then is released |

A question to it ends when it is answered, when its route's `timeoutMs` or the asker's shorter
`--timeout` passes, when it is released or the asker stops, when a deadline the workflow set around the
asker passes or its scope is cancelled, or when the attempt ends. It is never reminded. Releasing
the participant closes its routes and ends its open questions `released`; the workflow's return
releases it once no question to it is open, and an attempt's end closes its routes and ends its open questions `attempt-ended`.
The participant lasts the attempt: a continue connects it again, and an earlier attempt's questions
are closed.

The holder's commands and what they publish are in [[messaging#Coordinator CLI]].

## Waking a holder

A backend that can locate sessions it did not start may offer `OutsideSessionControl`, and the
engine then wakes a session holding a participant when it has new items, instead of waiting for it
to look.

The wake carries no message. It only causes the session to take a turn; the content is still read
through `awf inbox`, so what is read is unchanged and responsiveness is the only difference.
That is what makes the wake safe to repeat — a lost one costs nothing, so it is retried against
`status` rather than confirmed by the call that sent it.

The two receipts answer different questions and neither replaces the other. `status` reporting
`working` says a turn started, which is enough to stop waking. The participant's next CLI call says
the message was read. A `blocked` session is escalated rather than woken again, because no number
of turns clears a prompt that is waiting on a person.

How the adapter learns the session handle is unsettled now that no binding is installed; terminal
identity stays out of workflow code and out of the participant spec either way. Where no adapter
provides the capability, `awf inbox --wait` is the whole mechanism.

## Review loop

The parent connects an author, held by another session, and passes it into reusable review calls:

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

Send each round to the author with wf send --await-reply, and end your turn: the author's
dispositions start your next turn.
Return the verdict once nothing is open.
`,
  schema: REVIEW_VERDICT,
});
```

The session holding the author participates with the same files and the holder's commands:

```sh
awf inbox --all --as author --json --after {cursor} --wait 100
awf reply review/2026-10-22-0915 review:claude/reviewer --to 1.4 < round2.md
```

Durable findings remain in files; messages carry only coordination.

## Deliberately absent

- detached child workflows or signal-delivered child results;
- workflows presented as agents;
- running or collecting results from an outside participant, other than the calling session
  (ADR 0010);
- an outside participant asking: it answers and sends, and never awaits a reply;
- sharing a runnable parent agent with a child workflow;
- visible message ids or authority tokens in agent commands.
