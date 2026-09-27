# Workflow interface map

This directory designs the interface; it does not specify an implementation. Stage 0 moved the
source into `packages/`; what lives here is the map, not the code.

`wf` has three distinct interfaces. Keeping them separate makes it clear which capabilities belong
to workflow code, which belong to the engine, and which are visible to the agent running inside a
harness.

| Audience | Interface | Source |
| --- | --- | --- |
| Workflow author | Public TypeScript interface | [`packages/contract/src/workflow/`](../../packages/contract/src/workflow/) |
| Engine and harness adapter | Internal TypeScript interface | [`packages/harness/src/adapter.ts`](../../packages/harness/src/adapter.ts) |
| Agent inside a session | Prompt, skills, harness tools, and result CLI | Described below |

The scenarios under [`examples/`](../../examples/) use only the public interface. They do not know how
a terminal session is started or how an answer is collected.

## Public interface for workflow authors

A workflow exports a `WorkflowDefinition` with metadata and one `run` function:

```ts
const workflow: WorkflowDefinition<Args, Result> = {
  meta: { name, description },
  async run(context, args) {
    return orchestrate(context, args);
  },
};
```

`WorkflowContext` provides:

- `agents` — open, reattach to, or stop logical agents.
- `participants` — connect outside sessions or resolve participants visible in this scope.
- `messages` — grant one-way or two-way messaging routes between participants.
- `call` — run a child workflow in its own scope.
- `parallel` — apply an async operation with bounded local concurrency.
- `steps` — run a named operation or sleep.
- `signals` — wait for external text or schema-validated JSON.
- `usage()` — snapshot completed agent-operation times and sessions for the run. Tokens and cost
  are read when the run ends and returned by the engine, not to workflow code.
- `log()` — record workflow diagnostics.

An agent is opened with a run-scoped logical key, instructions, a runtime, and optional skills: a
path, or a public skill in a git repository, each copied to the agent, which then has exactly those
and none of the operator's ([story 007](../stories/007-agent-skills.md)). Its working directory
and deadline inherit from the current workflow scope:

```ts
const reviewer = await context.agents.open({
  key: "reviewer:42",
  instructions: "Review the change and record findings in the ledger.",
  runtime: "reviewer",
  skills: [{ path: new URL("./skills/air-code-review", import.meta.url) }],
});
```

`AgentRef` has three ways to perform work:

- `run()` queues one turn and waits for its terminal outcome. Its id is generated when omitted, and
  one standard missing-answer nudge runs unless `nudge: false` disables it.
- `enqueue()` durably queues detached work and returns a `TurnRef` for later observation,
  cancellation, or an unanswered-result nudge. Detached turns require a caller-supplied id.
- `compact()` asks the agent to summarize retained context. Only an `answered` outcome replaces
  the previous context.

The public call surface is:

| Object | Calls |
| --- | --- |
| `AgentDirectory` | `open(spec)`, `attach(key, runtime?)`, `stop(key, reason?)` |
| `ParticipantDirectory` | `connect(spec)`, `get(key)` |
| `AgentRef` | `run(spec)`, `enqueue(spec)`, `compact(spec)` |
| `TurnRef` | `result`, `nudge(options)`, `cancel(reason?)` |
| `Messaging` | `allow(access)` |
| `Steps` | `run(spec, operation)`, `sleep(spec)` |
| `Signals` | `receive(spec, schema?)` |
| `WorkflowContext` | `call(spec)`, `parallel(items, operation, options?)`, `usage()`, `log(message, fields?)` |

Every turn ends as `answered`, `unanswered`, `blocked`, `timed-out`, `failed`, or `cancelled`. An answered turn
contains either text or JSON validated against the supplied `OutputSchema`. Every outcome carries
its own usage record with delivery and settle times. Spend is not on it: a harness writes its last
request after the answer is accepted, so the engine reads spend once the run ends and returns it with
the run's result ([story 002](../stories/002-cost-and-time-accounting.md)). Unknown spend stays
absent; known zero remains distinct from unavailable.

Runtime aliases are engine configuration, not workflow definitions. A workflow normally names an
alias and may constrain its harness or model. The resolved harness, model, and selected alias are
available on `AgentRef.execution` and remain fixed for that logical agent.

## Internal interface for the engine and adapters

`adapter.ts` is the seam between the workflow engine and a specific agent harness. It is published
as the `./adapter` subpath rather than through `index.ts`, so a caller reaches it deliberately.

The engine is configured with:

- `AgentRuntimeConfig.aliases` — central runtime aliases.
- `AgentRuntimeConfig.host` — the one run host that owns placement, inspection, continuation, and
  cleanup for a run.

The engine opens one run through `host.openRun()` and each logical agent through the run's
`openAgent()`, with the logical key, resolved execution, working directory, instructions, and
labels. Behind the host, an adapter declares the harnesses it drives and the capabilities it can
honestly report, and the host calls its `activate()`. The returned `HarnessSession` can report
status, start turns, compact context, and close. A `HarnessTurn` exposes its eventual native
outcome, continuation delivery, nudge, and release.

| Object | Calls |
| --- | --- |
| `AgentRunHostFactory` | `openRun(spec)` |
| `AgentRunHost` | `openAgent(request)`, `inspect()`, `close(reason?)` |
| `AgentSessionAdapter` | `activate(request)` — called by the host, not the engine |
| `HarnessSession` | `status()`, `start(turn, binding)`, `compact(id, prompt, deadline)`, `close(reason?)` |
| `HarnessTurn` | `settled`, `deliver(prompt)`, `nudge(spec)`, `release(reason, deadline)` |
| `OutsideSessionControl` | `status(session)`, `wake(session)` — optional, see below |

The engine, not the adapter, owns logical-agent identity, runtime alias resolution, queue ordering,
idempotency, global admission, workflow usage collection, and the public `run()` convenience
operation. The adapter owns translation to native harness commands and reconciliation of terminal
state with an actual reported result.

### Session adapters, not a Herdr dependency

`pane | headless` is legacy vocabulary. It named behavior a workflow could depend on — `pane`
retains an interactive terminal session, `headless` drives the harness as a direct process — and
[`foundation.md`](../foundation.md) §6 has since taken it off every surface, because exposing it let
two logical peers in one run take different lifecycle and observability models. `BackendKind`
survives in `packages/harness/src/types.ts` only so the frozen experiments remain runnable. Nothing
live reads it, and nothing new should.

Herdr is the first and default terminal host because the experiments exercised its lifecycle and
liveness behavior. It is not an engine dependency or a workflow capability. Operator configuration
may install a tmux host instead, and direct-process execution already demonstrates a session
without a terminal multiplexer. A future adapter may use neither, provided it satisfies the same
session interface and reports unsupported capabilities honestly.

An adapter that can locate sessions it did not start advertises `outsideWake` and exposes
`outside`. That is how a connected outside session is woken when it has unread messages; it does
not deliver anything, and [`composition.md`](composition.md) holds the semantics.

The configuration admits exactly one run host. That keeps selection outside workflow code: the
operator chooses the host, and every logical agent in that run crosses the same interface.
Installing both Herdr and tmux does not introduce a second routing language; the operator picks
which one opens the run.

The engine reaches sessions only through the run host; `single-session-host.ts` places one
`AgentSessionAdapter` behind that seam, and `session-core.ts` holds the session lifecycle shared
behind the adapter. The `AgentSessionDriver` shapes survive so the archived experiments
remain runnable, and nowhere else. The shared harness table supplies provider-neutral interactive
commands. Herdr's agent-kind mapping stays in the Herdr implementation, where a tmux or raw-PTY
implementation does not need to know it.

## What an agent inside a session sees

The model does **not** receive `WorkflowContext`, `AgentRef`, runtime aliases, usage records, spend
information, or another way to control the workflow.

At activation it receives, through harness-specific mechanisms:

- its working directory;
- the workflow-supplied instructions;
- the native tools and permissions granted by the harness adapter.

For each operation it receives the turn prompt and, for structured work, the required JSON Schema.
A nudge is another prompt in the same logical operation sequence. A compaction is also a prompt,
but its accepted answer is retained as context rather than returned as ordinary workflow data.
Allowed messaging routes and their purposes are included in its instructions or authenticated
inbound messages.

The engine-owned CLI provides result submission, route discovery, and messaging:

```sh
wf result <call-id> '{"verdict":"approve"}'
wf result <call-id> < result.json

wf peers
wf send reviewer 'Findings are ready in REVIEW.md'
wf send reviewer 'Please review the revision' --expect-response
```

See [`messaging.md`](messaging.md) for delivery, response, wake-up, and failure semantics.
See [`composition.md`](composition.md) for child workflow scopes and outside-session bindings.

The model supplies the call id it was given and nothing else. It cannot answer for another agent
by naming that agent's call: the launcher it runs holds a socket the engine opened for this agent,
so the engine learns who is answering from the connection rather than from the argument. Agents
that share a user are not otherwise separated, unless they are in different sandboxes; see
[`permissions.md`](permissions.md).

| Identifier | Visible to | Purpose |
| --- | --- | --- |
| `TurnId` | Workflow and engine | Idempotent queueing of the logical turn |
| Call id | Agent, adapter and engine | Name the one result slot an invocation answers |
| Usage operation id | Engine and workflow result | Account for attempts, nudges, and recovery |

The call id is scoped to one operation, not just the logical agent, so a delayed command from an
earlier operation cannot submit a result for the next queued operation. It is not a secret: it
travels in the prompt, and a submission naming a call the connecting agent does not own is refused.

JSON must come from exactly one source: the argument or standard input. This supports files and
generated output without adding filesystem behavior to the CLI itself. Supplying both sources,
neither source, or empty input is an error.

The engine installs one launcher per agent and puts its path in the prompt; the adapter's whole
duty is to deliver that prompt and let the agent execute the path. A pane's environment and `PATH`
are not channels a harness can be relied on to deliver, so nothing the return channel needs may
depend on one. `wf result` validates the JSON against the open schema. On rejection it exits
nonzero with a field-level error; the result slot stays open so the agent can correct the value and
call it again during the same operation. An accepted value atomically closes the slot. A missing,
closed, expired, or already-answered call is rejected, as is one belonging to another agent. Normal
terminal output is not an accepted result.

One operation always has one final result. If its prompt asks several questions, its schema collects
their answers into one object or array. If the workflow needs independently settling answers, it
queues separate operations; the engine activates and binds each one in order.

Turn completion and result submission are separate signals. When the harness reports that the
agent is idle but the result slot has no accepted value, the attempt is `unanswered` and the engine
reactivates that slot for one standard nudge before prompting the same session to submit the missing
result, using the same operation binding and schema. A caller can customize that attempt or disable
it with `nudge: false`. If the nudge also settles without an accepted value, its outcome is
`unanswered`.

One socket per agent is enough while a session answers one call at a time. A long-lived session
answering several leans on the pair: the connection proves which agent, the call id proves which
call.

## Capability gap

The interface names an agent's skills, and the run records them, but it does not describe the harness-native tools, shell
commands, filesystem access, network access, or approval policy available to the model. Those are
currently adapter launch details. Consequently, this interface can answer which skills an agent
gets, but it cannot yet provide a complete auditable list of everything that agent may call.
[`permissions.md`](permissions.md) covers the sandboxes that narrow an agent's files, network and
environment, which are built, and designs the harness-level rules and tool grants that would close
the rest.

Messaging is defined by the public `Messaging` interface, the internal `HarnessTurn.deliver` seam,
and the agent-bound commands documented in [`messaging.md`](messaging.md).
