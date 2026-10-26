---
id: "035"
title: "An agent calls a tool the workflow's code handles"
summary: "A workflow gives an agent named, typed tools; the agent calls one with wf tool mid-turn, the workflow's handler runs, and its return value is the tool's result."
type: story
status: in-progress
depends_on: []
---

# An agent calls a tool the workflow's code handles

## Outcome

Today an agent reaches its workflow's code only by ending a turn with a result. Mid-turn it can
message other agents and outside participants, but it can't tell its own workflow anything, and it
can't ask the workflow for anything. So a workflow that needs a decision from the agent before the
turn ends, or that wants to give the agent something only its code can do, works around it with
files: the Datadog watcher's design has its investigator close a case by writing `verdict.json` for
code to find later.

After this story, a workflow gives an agent tools: each one has a name, a description, an input
schema and a handler in the workflow's code. The agent calls a tool mid-turn, the handler runs with
the checked input, and what it returns is the tool's result, which the agent reads and goes on. The
tool is the permission: holding it is what lets the agent call it, so no grant is needed.

## How it works

```text
workflow code                         engine                          agent (pane or headless)
─────────────                         ──────                          ────────────────────────
agents.open({ tools: { close_case } })
await investigator.run({ prompt })  ─► the prompt lists the tools ──► reads: close_case — "Close…"
                                                                       runs: wf tool close_case
                                                                             --status 'noise' --why '…'
                                      ◄── wire: { command: "tool" } ──┘
                                      the agent's current operation? holds the tool? input fits?
handler(input, call) ◄────────────────┤  (in the operation's scope, under the tool's timeout)
  …short, bounded work…               │
  return "Closed."  ─────────────────►│ records the call ─────────────► prints: Closed.
                                                                       goes on with its turn
```

- **Tools are given at open**: `agents.open({ tools: { name: tool({ description, input, handler }) } })`.
  `input` is an object schema, TypeBox or JSON Schema as `run()`'s `schema` is, and `tool()` types
  the handler's argument from it, as `run()` infers its result from `schema` (Q10).
- **The agent calls with `wf tool {name}`**, with its input as flags in single quotes,
  `--status 'noise' --why '…'`, when the input is simple, or as JSON in a quoted heredoc, which is
  always accepted; with nothing after the name for a tool that takes no input. `wf result` takes its
  answer the same two ways (Q9). It goes over the agent's existing socket, so it works for every
  harness, pane or headless, in a sandbox or not, with nothing to configure.
- **Every operation's prompt teaches them**, as a harness lists MCP tools: each tool's name and
  description, so the agent knows what it is for, then a usage line for a simple input or the schema
  for any other, and how to call one.
- **The handler runs during the turn**, while the agent waits in its shell for the result. It must be
  short: the tool's timeout bounds it, and it can't give the agent that called it work, since that
  agent is in a turn.
- **A bad call is the agent's to fix.** An unknown tool or input that doesn't fit is refused by the
  engine, and `wf tool` prints why; the handler doesn't run. A handler that throws gives the agent
  the error as the tool's failure; the run goes on.
- **Recorded** in the run's event log: the call, its input, the result or error, and how long the
  handler took.

What the agent reads, in a turn (the prompt, then the lines the engine adds; the launcher's full
path shortened to `wf`, and the call id, a UUID, to `c-7f3a`):

```text
{the workflow's prompt}

When the answer is ready, return it by running:

wf result c-7f3a --verdict noise|real --confidence <integer, 1 to 5> --summary <text, at least 1 character>

Put every value in single quotes; a ' inside a value is written '\''.

You have tools the workflow runs for you. Call one with:

wf tool <name> --<option> '<value>' ...

- close_case: Close the case when the engineer says it's fixed or noise.
  wf tool close_case --status closed|noise --why <text>
- list_open: The cases still open, one per line.
  wf tool list_open
```

M1 tested this lesson with the usage line first and the description after it, on one line; the
description first, as MCP lists a tool, is what task 1 fixes. It also taught waiting for the result,
one call at a time, the no-input form and the exit codes; those are gone. The usage lines show the
no-input form, the shell waits anyway, and the rest is what `wf tool` prints when it happens, so
task 7's live check is run on this shorter lesson. The quoting rule is said once, under the first
block taught with flags, so a turn with a simple result and no tools gets it too, and a message
turn's tools block carries it. Usage lines show a value's placeholder bare, as M1 did; the call
form and the rule say to quote it. A result or a tool whose input isn't
simple is taught as today's result is: the heredoc and the schema, `wf result c-7f3a <<'WF_JSON'`,
or the tool's description with `input: {schema}` under it, and the call form gains a second line,
`wf tool <name> <<'WF_JSON'`, whenever any tool is taught that way. A message turn gets the same tools block,
without the result block. The wording is fixed at task 1.

The Datadog watcher's case run, which reads `verdict.json` today, would close a case from the thread
like this (`kase.close` is the watcher's own helper):

```ts
const investigator = await workflow.agents.open({
  key: "investigator",
  runtime: "claude",
  tools: {
    close_case: tool({
      description: "Close the case when the engineer says it's fixed or noise.",
      input: outputSchema(Type.Object({ status: Type.Union([Type.Literal("closed"), Type.Literal("noise")]), why: Type.String() })),
      handler: ({ status, why }) => {
        kase.close({ status, why, by: "thread", at: new Date().toISOString() });
        return "Closed. Reply in one line, then end your turn.";
      },
    }),
  },
});
```

The first question people ask is how this relates to [[034-event-driven-runs|story 034]]. It doesn't
depend on it. A tool is how an agent reaches the code mid-turn; an event is how anything reaches a
run. Once both exist, a handler that wants work done after the turn can emit an event to its own run
instead of doing the work itself (`workflow.emit` with no target, the form 034 leaves out), as the
sketch in `docs/research/workflow-styles.md` does. 034 has landed, so this story takes the rules in
"With story 034" (task 8); the untargeted emit is a published form this story doesn't design, so it
is a follow-up of its own.

## Scope

In scope:

- `tools` on `AgentOpenSpec` and `AgentForkSpec`, the tool's spec and its handler's types in the
  contract;
- the wire's `tool` request and its response; `wf tool {name}`;
- input as flags for a simple schema, for `wf tool` and `wf result`, the usage line in the prompt in
  place of the schema, and JSON still accepted;
- the engine: binding a call to its agent's current operation, checking the agent holds the tool and the input fits, running the handler in the
  operation's scope under its timeout, returning its result or failure, and cancelling it with its
  operation;
- the tools lesson;
- the rules in "With story 034", and the Datadog sketch's `tools`;
- the tool records in the run's event log, and how `awf logs` shows them;
- workflow-testing: a scripted agent calls a tool, in a turn or a message turn, and gets its result;
- `examples/tools`, a workflow whose agent closes an item through a tool, with its test and a cheap
  live eval, as the proof.

Out of scope:

- `wf mcp`, a stdio MCP server over the same `tool` request, so claude, codex and pi show the tools
  natively: a later story, with the spec and the records unchanged (Q1);
- the Datadog watcher's `close_case`: its case run, in its own repository, adopts the tool once
  this lands;
- `workflow.emit` to the run's own mailbox from a handler: a follow-up on
  [[034-event-driven-runs|034]]'s mailbox, with its own design; `dd-case.ts`'s `emitToSelf` stays a
  stub;
- `use` for the harness's own tools and MCP servers (`docs/design/permissions.md`); tools from the
  workflow need no grant;
- tools for the calling session of `awf run --here`, which the run finds rather than opens, and for
  `forkCaller`'s fork, whose spec leaves `tools` out; tools an outside participant calls;
- stopping a fork's copied command from acting as its parent, for `wf tool` as for `wf send` and
  `wf reply` (Q4);
- a pi fork as a session of its own, and usage no longer read from the shell's session variable:
  [[agent-identity]];
- tool calls as OTel spans ([[030-otel-export|story 030]]);
- streaming results, or a result from a handler past its budget, which is dropped; long work goes
  after the turn.

## Context and evidence

- Fact: an agent answers its turn through `wf`, the launcher the engine installs, by its full path,
  with the JSON in a quoted heredoc, because a quoted argument broke on shell quoting (story 002)
  (`operationPrompt`, `packages/engine/src/workflow-runner.ts`).
- Fact: the launcher holds one socket per agent, and the connection is what identifies the agent
  (`packages/engine/src/agent-launcher.ts:9-19`). The environment was tried first and dropped: a
  codex pane runs its shell commands under its app-server, not the process Herdr started, so neither
  the pane's environment nor its `PATH` reaches them (commit `38dd03a`). A sandboxed pane also starts
  from an emptied environment (`packages/sandbox/src/pane.ts:36`).
- Fact: the wire has four request types and five commands, `result`, `waiting`, `peers`, `send` and
  `reply` (`ControlRequest`, `packages/contract/src/wire.ts:53`), at `WIRE_VERSION` 4, which the
  holder wire's requests share (`wire.ts:326-352`). `result` and `waiting` name a call id, and
  `result` is refused in a message turn (`no-result`, `messaging.ts:723`); `send` and `reply` bind to
  the agent's current operation, a turn or a message turn (`Messaging.current`,
  `packages/engine/src/messaging/messaging.ts:700`), and are refused without one (`no-operation`,
  `wire.ts:91`); `peers` answers at any time. A tool call must work in both kinds of turn, so it
  binds as `wf send` does. Every decoder rejects a field it doesn't know (`extraFields`,
  `wire.ts:680`), each with its own list.
- Fact: a fork starts from its parent's session and may reach its parent's socket with a command from
  its copied context (ADR 0009), which keeps only the accounting right: a session the fork reports
  there isn't counted as the parent's. A copied `wf send` or `wf reply` binds to the parent's current
  operation, so it sends as the parent, or settles a reply the parent owes; with no operation it is
  refused, as it is while a reused fork base sits idle. A copied `wf result` is refused, since its
  call ids are for ended operations (`unknown-operation`, `expired-operation` or
  `closed-operation`, `packages/engine/src/result-slots.ts:213-216`, `315-319`).
- Fact: the client gives up on a response after 30 s (`packages/wf/src/client.ts`), and the engine
  ends every control connection 30 s after it opens (`CONNECTION_TIMEOUT_SECONDS`,
  `packages/engine/src/control-plane.ts:18`). The timer is armed at `open()`, and the frame is decoded
  only after it ends (`answerFrame`), so a longer lifetime for a tool call is set once the frame
  decodes.
- Fact (M2): no harness kills a waiting `wf tool` by default while its session lives. claude moves a shell command to the
  background at 2 minutes, cursor at 30 s; codex hands it back at 10 s for the agent to poll, and
  ends it with the session if the agent doesn't; pi has no limit.
- Fact: the client refuses a response over 256 KiB (`MAX_RESPONSE_BYTES`, `client.ts:12`).
- Fact: `wf` never resends a request: `client.ts` sends once, and the failures of `wf waiting`,
  `wf send` and `wf reply` say nothing was retried (`packages/wf/src/cli.ts:162,265`; `UNRECORDED`, `messaging/text.ts:253`). A request that
  never reached the engine fails as `NotSentError`.
- Fact: `wf` prints the line saying what the operation owes or awaits at the start of stdout on
  success, and of stderr on a refusal (`owingLine`, `text.ts:192`; `succeeded()` and `refused()`,
  `cli.ts:324`, `332`).
- Fact: the routes are taught in every operation's prompt in a few lines (`routeLesson`,
  `text.ts:163`; `lesson()`, `messaging.ts:1357`, and for a message turn `1232`), beside
  `messaging.lesson` (joined in `executeWaitingOperation`). The
  schema's bounds in the prompt are what made first answers valid (E5,
  the comment in `operationPrompt`); in M1 a usage line carrying every bound did as well as the schema.
- Fact: a socket callback doesn't run in the operation's async scope (`scopes`, the
  `AsyncLocalStorage` in `workflow-runner.ts`). Nothing maps an operation to its `ExecutionScope`:
  `#stageScopes` holds only stages, a `parallel` scope shares its parent's messaging scope
  (`executeParallel`), and a top-level operation has none. The scope is at hand where the operation
  starts (`executeWaitingOperation`, `executeMessageOperation`).
- Fact: a stage seals its scope when its body returns, then drains its message turns
  (`scope.seal()`, then `drainMessages`, in `workflow-runner.ts`), and `run()` in a sealed scope
  throws (`assertAccepting`).
- Fact: `run`, `compact`, `set` and `fork` queue on the agent's tail (`queue()` in
  `workflow-runner.ts`).
  One called from the calling agent's own handler would wait for the turn, which waits for the
  handler. `agents.stop` doesn't queue: it cancels the operation and waits for it to end, then for the
  channel's open connections (`stopAgent`), the tool call's among them.
- Fact: `open` reattaches by key when every supplied field matches, an omitted field not
  constraining, and rejects a conflict (`assertCompatibleAgent`);
  a fork with the same key, parent and spec is the same fork, its spec compared whole
  (`isDeepStrictEqual` in `fork`; `agents.ts:393`, ADR 0009). A handler is a
  closure, never equal to the one before it. Each attempt opens its agents afresh.
- Fact: `forkCaller` took the same `AgentForkSpec` as `fork`; task 1 gave it `Omit<AgentForkSpec,
  "tools">`.
- Fact: a scripted agent in workflow-testing calls the real wire mid-turn (`turn.send()`,
  `packages/engine/src/workflow-testing/host.ts:191-233`, `274`), and its turn has a `signal`
  (`script.ts:42`).
- Fact: an MCP tool's input schema must be an object (`inputSchema.type: "object"`).
- Fact: the watcher's case run (`agent/workflows/datadog-watcher/case.ts`, braintrust, uncommitted)
  is written on 034, and reads the investigator's `verdict.json` when a turn ends, "until the
  investigator has a close_case tool" (`case.ts:60`); a close is `kase.close({status, why, by,
  at})` (`case-state.ts:207`).
- Fact: `permissions.md` plans `use?: readonly CapabilityRef[]` (`tool:shell`, `mcp:github`) for
  tools the harness has, and calls those the agent's tools; tools from the workflow are code it owns,
  not capabilities handed over.
- Constraint: published formats, written and reviewed at task 1 before any is built: the tool spec,
  `ToolCall`, the wire's requests, responses and codes, the commands' usage and output, exit codes,
  the lesson's text, the event-log records, tool names and limits, and what a `wf result` given
  flags writes as its candidate's `raw` (`records.ts:47`): the arguments as given, as a JSON array
  of strings, whether or not they convert.
- Assumption: agents call a tool taught in the prompt as reliably as they call `wf result` (M1).

## Code map

### contract

- `packages/contract/src/workflow/agents.ts` — `tools` on `AgentOpenSpec` and `AgentForkSpec`, and
  `forkCaller` given `Omit<AgentForkSpec, "tools">`, and a fork whose parent is the calling
  session, by `forkCaller` or by `caller()`'s ref, whose `fork` takes `AgentForkSpec`, refused at
  run time when it has `tools`; `ToolSpec`, `ToolCall`, `tool()`, `TOOL_LIMITS`; `open`'s and
  `fork`'s matching rule for tools.
- `packages/contract/src/schema.ts` — `canonicalSchema`, the form a tool's schema is compared and
  measured in.
- `packages/contract/src/wire.ts` — `ToolRequest` and its decoder, `ToolResponse` and
  `TOOL_CODES`, and their rows in `ResponseFor` and the answers table; `tool-running` in
  `RESULT_CODES`; `GivenInput` on `ResultSubmitRequest` and `ToolRequest`; `RESPONSE_CODES`;
  `WIRE_VERSION` 5, which the holder wire's requests take too.
- `packages/contract/src/records.ts` — `RunEvent`: `tool-called`, `tool-ended`, `tool-refused`, and
  their versions in `RUN_EVENT_VERSIONS`.

### wf

- `packages/wf/src/cli.ts`, `client.ts` — `wf tool {name}`, its usage, its exit codes, the owing
  line on stderr, and no client timeout for a tool call; `wf result` and `wf tool` sending flags as
  given, beside JSON.

### engine

- `simple-input.ts`, new — the simple-input rule, the usage line, and reading flags by a schema,
  for `wf result` and `wf tool` alike (task 2).
- `workflow-runner.ts` — `operationPrompt`'s usage line for a simple result schema; tools kept per
  agent; the operation's `ExecutionScope` kept by operation id
  where the operation starts; the matching rule for tools in `assertCompatibleAgent`, and
  on fork in place of the whole-spec comparison; the handler run in the operation's scope with an async-local
  stack of the agents whose handlers it is in, kept per operation id beside its scope; `tools` taken
  out of an `open` or `fork` spec before it is cloned or kept, since `forkAgent`'s
  `structuredClone(spec)` throws on a function, and held with the agent, out of `forkedFrom.spec`
  and its comparison; in `operationPrompt`, the tools block after the
  result block.
- `messaging/messaging.ts` — the agent's current operation (`Messaging.current`), which a call binds
  to; a message turn's tools block, joined where its lesson is (`messaging.ts:1232`); `wf result` refused while
  a call runs, and a call refused once a result is accepted.
- `messaging/text.ts` — the tools lesson's text and the tool refusals' texts.
- `control-plane.ts` — a second handler slot beside `attach(messaging)` (`control-plane.ts:38`); a
  `tool` frame's connection lifetime re-armed once it decodes; the `result` path passing flags on as
  it passes `request.raw` now. Until tasks 2 and 3, a `tool` request is refused
  `unsupported-command` and a result given as flags `invalid-result`.
- `result-slots.ts` — a result's flags converted by the slot's schema in `evaluateGiven`, and
  the accepted state `result-accepted` reads.
- `run-event-log.ts`, `logs-command.ts` — the records and how they print.
- `workflow-testing/script.ts`, `host.ts`, and `@agentswf/harness/testing`'s scripted agents —
  `tool()` on a turn and on `ReceivedMessage`, and `"tool"` in host's `Omit` list (`host.ts:55`).

### examples

- `examples/tools/` — the proof workflow, its `*.test.ts`, and a `*.eval.ts`.

### docs

- `docs/workflow-api.md`; `docs/design/permissions.md`, which calls the harness's tools its
  capabilities, not its `tools`.

## Proposed design

In `packages/contract/src/workflow/agents.ts`, abridged:

```ts
interface ToolSpec<I extends JsonObject = JsonObject> {
  description: string;
  /** An object schema; absent, no input, and the handler is given `{}`. */
  input?: OutputSchema<I>;
  /** Returns the result; nothing prints nothing. Throws to fail the call. */
  handler(input: I, call: ToolCall): Promise<JsonValue | void> | JsonValue | void;
  /** Absent, 30 s; `false`, only the operation's deadline. */
  timeoutMs?: number | false;
}
type ToolCall = { readonly id: string; readonly agent: AgentKey; readonly signal: AbortSignal };
/** Types the handler's input from `input`, carried as `run()`'s `schema` carries its type. */
function tool(spec: ToolSpec<NoInput> & { input?: undefined }): ToolSpec<NoInput>;
function tool<I extends JsonObject>(spec: ToolSpec<I> & { input: OutputSchema<I> }): ToolSpec<I>;
type NoInput = Record<string, never>;
type AgentTools = Readonly<Record<string, ToolSpec>>;
```

`input` carries its type through `OutputSchema`'s carrier, as `run()`'s `schema` does, so a TypeBox
schema is wrapped in `outputSchema(...)`; an unwrapped one gives the handler a `JsonObject`, and a
tool with no input `NoInput`, so its handler can't expect fields. `handler` is a method, so a typed
tool is a `ToolSpec` too; the price is that an annotation on an inline handler, one not written with
`tool()`, goes unchecked.

In `packages/contract/src/wire.ts`, abridged:

```ts
/** As `wf` was given it: JSON from standard input, or the words after the call id or name. */
type GivenInput = { raw?: string; args?: never } | { args?: string[]; raw?: never };
type ResultSubmitRequest = { version: 5; command: "result"; operationId: string; session?: string } & GivenInput;
type ToolRequest = { version: 5; command: "tool"; tool: string; session?: string } & GivenInput;
type ToolResponse =
  | { kind: "tool-result"; output?: string; owing?: string }
  | { kind: "tool-failed"; outcome: "failed" | "timed-out" | "cancelled"; error: string; owing?: string }
  | Rejection<ToolCode | EnvelopeCode>;
const TOOL_CODES = ["no-operation", "result-accepted", "tool-busy", "unknown-tool", "invalid-input"];
```

`output` is what `wf tool` prints, absent when the handler returned nothing; `error` is the line it
prints on stderr, naming the next action, as a rejection's `error` does. `wf tool` maps them to its
exit codes: `tool-result` 0, `tool-failed` `failed` 1, `timed-out` and `cancelled` 4, a rejection 3,
`internal-error` 4.

- **Binding.** A call binds to the current operation, a turn or a message turn, of the agent whose
  socket it arrives on, as `wf send` does, and is refused without one (`no-operation`). A fork that
  runs its parent's copied launcher calls as its parent: with the parent idle, as a reused fork base
  is, it is refused; with the parent in a turn, it runs in that turn, with the parent's handlers and
  `call.agent`. That is accepted, not guarded (Q4). So is a shell command that calls after its
  operation ended, or from the background: it binds to whatever operation is current when it
  arrives, as `wf send` does.
- **Names** match `^[a-z][a-z0-9_]{0,47}$`, which an MCP tool name allows with room for the
  `mcp__{server}__` prefix claude gives it, so `wf mcp` later renames nothing; unique per agent.
- **Limits** (`TOOL_LIMITS`), each refused at `open` or `fork`: at most 16 tools; a description up to
  1 KiB; an input schema that is an object, up to 8 KiB in that canonical form; a `timeoutMs` that
  is neither a positive integer nor `false`. The lesson goes in every prompt, and these keep it
  bounded.
- **Checks, in order**, each a refusal that runs no handler (`TOOL_CODES`): the agent has a
  current operation (`no-operation`); a result is already accepted for the operation
  (`result-accepted`); a call of this agent still runs (`tool-busy`), unless this is the same call
  again, the same tool with the same input, which joins the running call once and gets its answer,
  unrecorded; the tool is the agent's (`unknown-tool`); the input is a JSON object within 64 KiB
  that fits the schema, or is none for a tool that takes none (`invalid-input`, with the schema's
  errors, as `wf result` gives them).
  `tool-busy` keeps a waiting call from holding one of the 64 connections all agents share
  (`control-plane.ts:17`); claude may run shell commands in parallel, and calls again. The join is
  for codex, whose shell hands a slow command back with nothing left to read it from, so the agent
  calls again (task 7): the handler runs once all the same.
- **Simple input**, for a tool's input and for a turn's result alike: an object of at most 6
  properties, each a string, a number, an integer, a boolean or an enum, with no constraint but
  `required`, `minimum`, `maximum` and `minLength`, the bounds awf's schema has
  (`packages/contract/src/schema.ts:8`); a property's `description`, `title` and `default` keep it
  simple but aren't shown. An enum is an `enum` of strings, typed `string` or typeless, or an
  `anyOf` of string `const`s, as TypeBox writes a union of literals; an `enum` with any other value
  isn't simple. Its usage line carries every bound, since a schema's bounds left out
  of the prompt made first answers invalid (E5). A string `const` is an enum of one;
  `additionalProperties` doesn't change it; each property's name matches `^[a-z][a-z0-9_]*$`, so
  it reads as a flag. The usage line: `<text>`, `<text, at least 3 characters>`,
  `<number>`, `<integer, 1 to 5>`, `<integer, at least 1>`, `<number, at most 0.5>`, `true|false`,
  `noise|real`; an optional property is in
  brackets, `[--note <text>]`. A boolean is written as any value, `--draft 'true'`. Any other schema
  is taught as JSON, and flags for it are refused with the schema.
- **Reading the input.** `wf` knows no schema: it sends its arguments as given, or the JSON, and the
  engine converts flags by the schema and checks the input, so every check below is the engine's:
  for `wf result` a refusal is `invalid-result`, exit 1, and for `wf tool` `invalid-input`, exit 3,
  each with the usage line. `--name 'value'` and `--name=value` both
  set a property, a number or boolean converted by its type, and anything else is refused: a word
  that isn't a flag, as a value split by a broken quote leaves; a flag the schema doesn't have; a
  flag given twice. JSON comes on standard input, as the heredoc teaches it; `wf result`'s JSON
  argument goes, since a word after the call id is now a flag or refused. `wf` reads standard input
  only when nothing follows the name or call id and it is a pipe or a file, as a heredoc is, and
  reads it to its end, so a heredoc after flags is never read; a command with
  nothing piped had `/dev/null` as standard input under all three harnesses M1 ran, so `wf tool
  list_open` returns at once. A pipe left open, which M1 didn't see, is read as `wf result` reads
  one today: given up after 30 s, exit 2 (`readCliStdin`, `cli.ts:428`; `STDIN_TIMEOUT_MS`, `cli.ts:40`); panes
  are checked in task 7. The word after `--name` is always its value, `--why '--force was used'`
  included. A call with no input is `{}`: a schema that accepts `{}`, a tool with no input or only
  optional properties, takes it; one with a required property refuses it with its usage line or
  schema.
- **The budget** is the tool's `timeoutMs`, 30 s when absent, or less when the operation's deadline
  comes first, and then `wf tool` answers with the deadline; `false` leaves only the deadline (Q11).
  A `tool` frame's connection lifetime is re-armed when it decodes, to the budget plus the 5 s
  settle plus a margin, or to none when the budget is the deadline and there is none, so the
  engine's answer is written before the connection is cut. `wf tool` has no timeout of its own: the
  engine answers once the call settles, and a dropped connection ends it. A call past its harness's
  own limit for a shell command (M2) isn't lost: claude and cursor move the command to the
  background and the agent reads its output there; codex hands it back for the agent to poll, past
  10 s by default; task 7 checks that agents do.
- **The result.** A string prints as is, any other JSON value as JSON, `undefined` nothing; within
  64 KiB encoded, else the call fails, its error saying the result is too large. A value that isn't JSON, such as a
  `Date`, a `bigint`, `NaN` or a cycle, fails the call with that as its error. A thrown error fails
  the call with its message. The run doesn't fail because a handler did; the record keeps the
  error.
- **What `wf tool` answers**, one kind each, with its exit code, so a script tells them apart
  without reading the text, and an agent reads the line `wf tool` prints on stderr, which says what
  happened and what to do (for `unknown`, that it may have run, so check before calling it again;
  for `tool-busy`, to wait for the call running): `ok` (0); `failed`, the handler ran and threw or returned what can't be
  sent (1); `refused`, it didn't run (3), an envelope error and a request that never reached the
  engine included; `unknown`, a timeout, a cancel or a dropped connection, so it may have run (4).
  An `internal-error` is always `unknown` too: the code says nothing of whether the handler ran, and
  `answerFrame` gives it when writing a record fails (`control-plane.ts:353`, `388`), as
  `tool-ended`'s may after the handler ran.
  Exit 2 stays a usage error, as for every `wf` command; the other commands keep exiting 1 on a
  refusal. The result is the only stdout; the owing line goes to stderr.
- **Where the handler runs.** In the scope of the operation the call came in, kept by the engine
  when the operation starts, so a stage it is in tags its work, its deadline bounds it, and its
  cancellation reaches it; an operation with no scope runs it in none, not in whatever scope the
  socket callback carries. It shares the process with the workflow's code: the two interleave at
  every `await`, and nothing orders a handler's effects against code outside it.
- **What a handler may not do.** Give work to, or stop, an agent whose handler it is in, the calling
  agent or any agent up the chain when handlers run each other: `run`, `compact`, `set`, `fork` and
  `agents.stop` on one, and `cancel()` on its started turn, throw at once, an `Error` saying the agent is in a tool call (`agent-in-tool`
  here), as a started turn's refusal is (`#refusedWhileStarted`), found by an async-local stack
  of those agents. The stack crosses the socket: when an operation starts, the engine keeps the
  stack current there beside the operation's scope, by operation id, even when the scope is none,
  and a call into that operation runs its handler with the kept stack plus its own agent. So when
  A's handler runs B, B's handler can't run A. `run` and the others would wait for the turn that waits for the handler; a stop would wait
  for the call's own connection, and a cancel for the turn's calls, its own among them, to settle.
  `workflow.receive()` in a handler is refused, since it would take
  events meant for the run's loop. A handler may run a different agent within its budget, except in a
  message turn a stage drains after its body, whose scope is sealed, where `run()` throws as it does
  for any code there.
- **The end of the operation.** While a call runs, the agent's `wf result` and `wf waiting` are
  refused (`tool-running`, added to `RESULT_CODES`), saying a tool call is still running and when it will be settled. When the
  budget passes or the operation is cancelled, its deadline passes, the agent stops or the attempt
  ends, `call.signal` aborts. A call is settled once its end is recorded: when the handler returns
  or throws, or 5 s after its abort if it ignores the signal. After an abort the outcome is the
  abort's cause, `timed-out` or `cancelled`, whatever the handler then returns or throws, and `wf
  tool` answers once the call is settled, exit 4, saying it may have run. Then `tool-running` lifts and the operation can
  end; a handler still running after that runs on unobserved, and its result is dropped. `run()`
  resolves only once its turn's calls have settled. An operation that ends on its own while a call
  runs, as a message turn does when the agent ends its turn, or a turn the harness cut, aborts
  `call.signal` as `cancelled`, and its end waits for the call to settle, so the agent's next
  operation never starts with a call of the last one running.
- **No resend.** `wf tool` sends a call once, as every `wf` command does. If the connection drops
  after the handler ran, its failure says the call may have run, so the agent doesn't call again
  blindly. A turn run again after a crash is a new operation, so its calls get new ids: a handler
  whose effect must happen once makes it safe to repeat, or keys it by what the effect is about,
  not by `call.id`.
- **Reopen and fork, within an attempt.** Tools match by name, description and input schema, the
  schema compared in a canonical form, its JSON with keys and `required` sorted, which drops
  TypeBox's non-enumerable `~kind` and `~optional`, so a TypeBox and a JSON Schema form of one schema match (`parseJsonSchema` checks a schema
  but returns it as given, so this is new); handlers and `timeoutMs` are never compared. `open` with the same key and matching
  tools reattaches, and its handlers and budgets replace the earlier ones; different tools conflict,
  as any other field does; `tools` left out doesn't constrain, as any omitted field, and keeps what
  the agent has. So an agent's tool set is fixed for the attempt from its first `open`. `attach(key)`
  returns the agent with the tools and handlers it was last opened with. A fork has its parent's tools
  unless its spec gives its own (Q3), the handlers its parent had when it forked; a later reopen of
  the parent doesn't change the fork's. A `fork` that returns the same fork, its tools matching,
  replaces its handlers and budgets as `open` does: its own tools' with the ones it gives, an
  inherited set's with the parent's now. A repeat `fork` that leaves `tools` out doesn't constrain,
  as with `open`, and keeps the fork's tools and handlers.
- **The lesson** goes in every operation's prompt, a turn or a message turn, as the routes lesson
  does (`messaging.ts:1357`), so a compaction never loses it and nothing tracks what was taught. It
  lists each tool's name and description, then a usage line for a simple input or the
  schema for any other, and how to quote a value; nothing else, since the usage lines show the rest
  and `wf tool` says what went wrong when it does; its text is in "How it works", fixed at
  task 1. An agent without tools gets none.
- **Records**, in the run's event log, as their neighbours are written, keyed; `call` is
  `ToolCall.id`, and `tool-ended` names its call by it:
  - `tool-called` `{ call, callPath, stage?, operationId, agent, tool, input }`, once the checks pass;
    a call that joins the one running writes nothing;
  - `tool-ended` `{ call, callPath, stage?, operationId, agent, tool, outcome: "ok" | "failed" |
    "timed-out" | "cancelled", error?, result?, durationMs }`, the call's keys repeated as
    `request-ended` repeats its question's, so `awf logs --agent` and `--stage` keep it;
    `durationMs` from the handler's start to its end being recorded;
  - `tool-refused` `{ callPath, stage?, operationId?, agent, tool, code: ToolCode, error? }`, `agent`
    the socket's, `error` what `wf tool` printed for `invalid-input`,
    for each `TOOL_CODES` refusal of a decoded `tool` request; an envelope refusal goes unrecorded,
    as a `send`'s does. Written as `message-refused` is: `callPath` the agent's,
    `operationId` absent for `no-operation`;
  - input and result kept whole, both within 64 KiB.
- **Across a continue**, nothing is replayed: the calls are history, tools are given again when the
  code opens the agent again, and a reused stage doesn't run its handlers again.

### With story 034

034 landed first, so this story makes these hold (task 8), and the sketch's `withTools` stub
(`examples/event-sketches/dd-case.ts:62-77`) becomes `tools` on the spec:

- a started turn's `agent:ended` is written once its calls have settled, and `cancel()` resolves
  once they have;
- a call in flight counts as a turn running, so the run doesn't park;
- `start()` from a handler on an agent it is in, and `cancel()` on that agent's started turn, are
  refused `agent-in-tool`, which is checked before 034's own refusals.

Decided (2026-10-25):

- Q1, `wf tool` in this story. MCP teaches better, as the harness lists each tool with its schema and
  checks the input, but claude, codex and pi each take a server their own way, cursor only from
  `.cursor/mcp.json` in the working directory or `~/.cursor/mcp.json`, and the agent can't call a
  tool by its bare name through the shell anyway, since `wf` runs by its full path. `wf mcp` can
  follow over the same request.
- Q2, no resend, as above.
- Q3, a fork has its parent's tools with the handlers they had when it forked, and `call.agent` is
  the fork's key, so a handler that must act differently checks it; the two share whatever the
  handlers hold. `fork({ tools })` replaces the set, and `tools: {}` gives none. A fork with no tools
  by default was rejected: its session would remember tools it can't call.
- Q4, a fork's copied command isn't guarded against, for `wf tool` as for `wf send` and `wf reply`.
  It acts as its parent only while the parent is in a turn; a reused fork base sits idle, and a
  read-only tool is fine to call from every fork. Every guard found costs every agent, or every fork,
  for a case only some forks hit.
- Q5, `wf tool`'s exit codes are 0, 1, 3 and 4 as above, while the other commands keep 1 for a
  refusal: only a tool call has an outcome the agent must not guess at.
- Q6, `ToolCall` is `id`, `agent` and `signal`: nothing used an engine operation id or the message
  turn's cause, and workflow code can't match either to anything it holds.
- Q7, a handler in a sealed stage's message turn can't run another agent, as no code there can; no
  scope of its own.
- Q8, the name stays `tools`, and `permissions.md` calls the harness's tools capabilities.
- Q9, flags for a simple input, `wf tool` and `wf result` alike, with JSON always accepted, decided
  by M1 (2026-10-25). The usage line is shorter than the schema it replaces, and in M1 it held its
  bounds better than the schema did. Single quotes are the rule because double quotes let the shell
  change free text (`$VAR`, backticks) with no error.

Decided at task 1 (2026-10-26):

- Q10, `tool()` per tool types the handler, and `open` and `fork` aren't generic. A generic over
  the tool map can't infer: the handler is context-sensitive and sits beside the schema it is typed
  from, so TypeScript 5.9 infers the map's entry as `unknown` or its constraint. `tool()` infers
  within one object, as `run()` does. A tool written without it still type-checks, its input a
  `JsonObject`, and an annotation on its handler goes unchecked.
- Q11, by the operator: `timeoutMs` defaults to 30 s, a tool sets its own, and `false` leaves only
  the operation's deadline; there is no cap. M2 put codex's 10 s under any useful budget anyway, and
  a backgrounded call isn't lost.

Decided at task 7 (2026-10-26):

- The same call made again while it runs, the same tool with input equal once canonical, joins it
  and gets its answer; one join per call, so a call still holds at most two of the shared
  connections, and the join isn't recorded, the call's records being the call's. Codex re-calls a
  handler past 10 s, since its shell hands the command back with nothing to poll, and no wording of
  the refusal stopped it. The other ways: a codex-only lesson line, still a re-call when the agent
  doesn't heed it; a default budget under 10 s, against Q11; or handlers that must be safe to run
  twice, which every author would pay for.

Alternatives rejected:

- MCP first — native tool lists with schemas, but a config per harness, cursor's only in files in
  the operator's repository or home; `wf tool` works the same on all four (Q1).
- Guarding forks (Q4):
  - `AWF_AGENT`, the agent's id in its process's environment, sent by `wf` — it doesn't reach a codex
    pane's shell commands, a sandboxed pane drops it, and every launch path would need its own fix;
  - the call id on every command, as `wf result` takes it — an argument on every call of every agent;
  - the parent's launcher replaced when it forks — rewritten for every fork of a base forked many
    times;
  - a launcher per operation, the call id in its path — a file per turn, and every command changes.
- A generic `wf signal {name} {json}` — the same reach with no description, schema or result for the
  agent, and a meaning the code has to guess.
- Tools at the workflow level, for every agent — holding a tool is the permission, so each agent
  gets only what it's given.
- Handlers compared on reopen — two closures are never equal, so every reopen would conflict.
- The wire's 30 s for every call — a handler near its timeout would be cut by the connection first,
  and the agent would see "closed without a response" instead of the handler's failure.
- JSON only — a schema in every prompt where a usage line says the same in less, and held its
  bounds worse in M1 (Q9).
- Flags with any quoting — codex's double quotes changed free text with no error (M1).
- Schemas only through a `wf tools` command — a second command a cheap model may skip, where the
  bounds in the prompt are what made answers valid (E5).

## Tasks at a glance

- [x] 1. The contract: the tool spec, `ToolCall`, the wire, the records, the commands' usage, the lesson; reviewed before building
- [x] 2. Flags for a simple input, on `wf result`: the engine reads them by the schema, the prompt shows the usage line
- [x] 3. A tool called over the wire: binding, checks, the handler in its scope, its budget and end
- [x] 4. The tools lesson
- [x] 5. Records and `awf logs`
- [x] 6. workflow-testing: a scripted agent calls a tool
- [x] 7. `examples/tools`, live (pi waits for its login)
- [x] 8. With story 034: a started turn's calls, parking, `start()` from a handler, the sketch's `tools`

## Open questions

Q1–Q9 are decided in "Proposed design".

None.

## To measure

- M1. **Agents call a taught tool, and in which form.** Measured 2026-10-25, headless, with a
  stand-in `wf` that checks input as the engine would (the scratchpad's `m1/`). Each trial needs
  three tool calls, one with free text holding an apostrophe, `$HOME`, backticks and backslashes, one
  with an integer and an enum, one with no input, and then a `wf result` with an enum, an integer
  from 1 to 5 and a summary of at most 60 characters.
  - Round 1, 5 trials per form on codex `gpt-6-luna` and cursor `composer-2.5`, flags told only to
    "quote values": codex double-quoted the reason 3 times in 5, so `$HOME` and `` `cron` `` were
    expanded and the calls succeeded with the wrong text; cursor 5/5. JSON 9/10, one invalid escape,
    which the engine would refuse.
  - Round 2, the lessons in the scratchpad's `m1/r2/prompts.py`, 10 trials per form on claude `claude-haiku-5-5`, codex and cursor:
    tools right first time 30/30 per harness in both forms, no free text changed; `wf result` right
    first time 30/30 with flags, 28/30 with JSON (codex's summaries over the 60 characters its schema
    allowed); every trial right in the end. The prompt was 1,583 characters with flags, 2,051 with
    JSON. A command with nothing piped had `/dev/null` as standard input; every heredoc was a file.
    codex called `close_case` twice in 2 trials of 20, and claude `list_open` twice in 10.
  - Not measured: pi, whose login had expired; panes. Both go in task 7's live eval.
  - Task 7, 2026-10-26, from the final lesson, with three tools (no input, JSON, flags) and a
    result with flags: codex and cursor headless, codex, cursor and claude in a pane, each right
    first time, 4 calls and no refusal or rejected result. Pi not run: its login had expired.
- M2. **The shell's own timeout.** Measured 2026-10-26, from source and docs, and probed on codex
  `gpt-6-luna` and cursor `composer-2.5` headless with `sleep 40` and `sleep 150` (the scratchpad's
  `m2/`):
  - claude 2.1.310: 120 s by default, 600 s at most, set by the model's `timeout`; past it the
    command is moved to the background, not killed (docs, tools reference). Not probed.
  - codex 0.164.0: `exec_command` hands control back after `yield_time_ms`, 10 s by default, 30 s
    at most, with a session id the agent polls with `write_stdin`; the command runs on, and dies
    with the session (`unified_exec.rs:60`, `unified_exec/mod.rs:68-73`). Both probes came back at
    10.2 s; the agent didn't poll, and the command never finished.
  - cursor 2026.10.22: 30 s by default, then "sent to the background" with an output file; the
    command finished in both probes, and the agent read the file.
  - pi 0.87.1: no timeout unless the model sets one, which kills the process tree (`bash.js`).
  So the budget can't sit under every harness's limit; Q11 takes it from there.

## Task execution rule

Process one task at a time. Every task repeats the checklist shown under its details. Do not begin
the next task because the current implementation merely compiles: its design must be recorded, its
diff reviewed by subagents, findings resolved, and focused verification complete.

After all tasks are complete, run story-level verification and request human review of the complete
deliverable.

## Task details

### 1. The contract

Outcome: the types, the wire, the records, the commands' usage and the lesson are written and
reviewed before anything is built.

Execution:

- [x] Plan, implement, review, resolve, verify (as in the template). Reviewed in three rounds,
  the last clean; the shapes reviewed by the operator 2026-10-26.

Work:

- M2, measured, and `timeoutMs` set from it (Q11);
- `ToolSpec`, `ToolCall`, `tools` on `AgentOpenSpec` and `AgentForkSpec`, and `open`'s matching
  rule; the wire's request, response and codes, `tool-running` in `RESULT_CODES`, `result`
  carrying flags as `tool` does; the three
  records; `wf tool`'s usage, and `wf result`'s with flags; the simple-input rule and its usage
  line; the lesson's text;
  `docs/workflow-api.md`; `permissions.md`'s wording.

Done when:

- the records and wire shapes are in `records.ts` and `wire.ts`, reviewed by the operator, M2's
  numbers in the story; `examples/tools`'s workflow type-checks, a handler's input is typed from its
  schema, a wrong input type fails `tsc`, a non-object schema fails `tsc` where it can, a handler
  returning nothing type-checks, an unwrapped TypeBox `input` types as `JsonObject`, not `never`,
  and `forkCaller` given `tools` fails `tsc`.

### 2. Flags for a simple input, on `wf result`

Outcome: an operation whose result schema is simple teaches `wf result` with flags, and the engine
reads them by the schema; JSON is still accepted. Built for `wf result` first, since it needs no
tools, and written once for both commands: the simple-input rule, the usage line, and reading flags
by a schema, which task 3 calls for `wf tool`.

Execution:

- [x] Plan, implement, review, resolve, verify (as in the template). Reviewed in three rounds,
  the last clean; live again on codex after the review fixes.

Implementation notes:

- `packages/engine/src/simple-input.ts` holds the rule (`simpleInput`), the usage line and
  `readFlags`, and the quoting rule's text; `evaluateGiven` in `result-validation.ts` takes the
  input as `wf` sent it, flags read by the slot's schema before the schema's own check.
- Reading flags checks everything the usage line says, bounds and enum values included, so a value
  it rules out is refused with that line, `expected: --verdict noise|real …`, and the quoting rule.
  A missing required flag is left to the schema's check, which names the property.
- Any annotation keyword (`description`, `title`, `default`, `examples` …) keeps a property simple;
  a number's or boolean's `const` doesn't, since the usage line has no form for it. Nor does an
  enum value that isn't a bare word (`^[A-Za-z0-9_.:-]+$`), which the line couldn't show between
  `|`s or the agent type unquoted, an object with no properties, which is open or empty, or a
  `required` name `properties` doesn't have, which no flag could give.
- A missing required flag is refused with the schema's error and the usage line. No input is `{}`
  only where the schema is an object; for any other, as a text answer's string, it is refused
  saying to send JSON in a heredoc. Flags for a schema that isn't simple say the same, with the
  schema. A word in brackets is told to leave the brackets out.
- `readGiven` and `checkGiven` in `simple-input.ts` turn what `wf` sent into a value and check it,
  for `wf result` here and `wf tool` in task 3.
- `wf` drops the "passed with < file" hint from a rejection, and the JSON error asks for a quoted
  heredoc rather than a single argument; neither form is taught any more.
- Live, 2026-10-26: `quick-check` on codex `gpt-6-luna` and cursor `composer-2.5` headless, both
  questions answered with flags first time (`--answer 391`, `--answer 400`), the candidates
  recorded as the arguments given.

Done when:

- tests, the rule: a schema is simple at up to 6 properties of the allowed kinds and constraints,
  and not at 7, a nested object, an array, or a union other than an enum; a TypeBox union of string
  literals is an enum, and so is a typeless `enum` of strings, but not one holding a number;
- tests, the usage line: it shows every property, its enum's values and every bound, as
  `<integer, 1 to 5>` and `<text, at least 1 character>`, with an optional property in brackets; a schema
  that isn't simple is taught by the heredoc and the schema, as today; a turn with a simple result
  and no tools gets the quoting rule;
- tests, reading: `--name 'value'` and `--name=value` set the input as JSON would, numbers and
  booleans converted by type; a value with an apostrophe, `$HOME`, backticks and a backslash
  arrives as written; a stray word, an unknown or repeated flag, and a value its type can't take
  are refused `invalid-result` with the usage line; a value starting with `--` is a value; flags
  for a schema that isn't simple are refused with the schema; no input is `{}`, taken by a schema
  of optional properties and refused by one with a required property; a heredoc after flags isn't
  read; JSON on
  standard input for a simple schema is still accepted; a missing required flag is refused as a
  missing property is now.

### 3. A tool called over the wire

Outcome: an agent's `wf tool` runs its handler in the operation's scope and prints the result.

Execution:

- [x] Plan, implement, review, resolve, verify (as in the template). Reviewed in five rounds,
  the last clean. Live with task 4, once the prompt teaches the tools.

Implementation notes:

- `packages/engine/src/tools.ts`, `ToolCalls`: each agent's tools, checked against `TOOL_LIMITS`
  and kept with their schemas, and the calls of each operation. The runner registers an operation
  where messaging's is (`opened`), and awaits `ended` before messaging's end, so `run()` and a
  message turn resolve only once their call has settled. The control plane routes `tool` to it
  (`attachTools`), asks it for `tool-running` before a result or a wait, and tells it when a result
  is accepted.
- A handler runs in `runIn(scope)`, the runner's `scopes.run` or `scopes.exit`, inside the
  async-local stack of agents whose handlers it is in; an operation keeps the stack it was started
  in. `refusedInTool` is checked first in `#refusedWhileStarted`, so `run`, `compact`, `set`,
  `fork` and `start` refuse `agent-in-tool` before 034's own refusal; `agents.stop` checks it too,
  and `receive()` refuses any handler.
- A repeat `fork` with `tools` matches and replaces them as a reopen does; one without keeps the
  fork's. The design's "an inherited set's with the parent's now" is dropped: a repeat that gives
  nothing changes nothing, as an `open` that gives nothing does.
- The lesson shows the schema's own key order: a schema is kept as its JSON, and compared in its
  canonical form.
- A cancel or a stop aborts a running call at once (`abort`, from the operation's stop), since the
  turn may be waiting on it; its end then waits for the call (`ended`). A call whose operation ended
  while it was being recorded isn't run, and ends `cancelled`, saying so. A handler that has
  returned counts as ended before an abort racing it.
- A message turn's later deadline reaches calls made after it (`extended`). Its credential
  write-back runs once its call has settled.
- A timeout says which bound it was: the tool's own, or the turn's deadline.
- `ToolCalls.taught` and `toolUsage` are task 4's, for the lesson.
- Accepted as is: a `wf tool` that arrives while a `wf result` is being accepted can start, and the
  turn's end then cancels it. Like messaging's, an operation that throws between registering and
  its end, before supervision starts, stays registered; nothing in that stretch throws today.
- A stop takes its own kind to the call: a deadline's stop ends it `timed-out`, a cancel's
  `cancelled`. The budget's timer and the connection's lifetime are kept within a timer's range.
- Following by construction rather than tested one by one: a cancelled turn and an ended attempt
  abort a call through the same stop as `agents.stop`, which is tested; a handler in a stage carries
  the stage's deadline as it carries its tag, both from `scopes.run`.
- Not tested here: `attach` returning the tools, since `attach` reaches only the calling session,
  which has none; a call in a sealed stage's drained message turn, which runs in that scope where
  `run()` throws as for any code there; a sandboxed agent, whose `wf` reaches the same socket; a
  reused stage after a continue, which runs no code and so no handler. `receive()` in a handler is
  tested with task 8, on a workflow with events.

Done when:

- tests, the call:
  - a valid call runs the handler once and prints its result, in a turn and in a message turn; a
    call outside an operation is refused `no-operation`;
  - flags for a simple input are read as task 2 reads them for `wf result`, by the same code, and
    refused `invalid-input`, exit 3;
  - a tool with no input is called with its name alone and its handler gets `{}`; `wf tool` with
    nothing piped, standard input a terminal or `/dev/null`, returns without waiting; with flags
    it doesn't read standard input, as `readCliStdin` skips it for an argument now; input given to
    it is refused;
  - a string, other JSON and `undefined` print as the design says, and the result is the only stdout;
  - an unknown tool, input that isn't JSON, isn't an object, is over 64 KiB or doesn't fit, and a
    call after a result is accepted are refused, exit 3, and the handler doesn't run;
  - a second call while the first runs is refused `tool-busy`, its stderr line saying to wait for
    the running call, unless it is the same call, which joins it once and prints its answer; an
    `unknown` answer's line says it may have run; the owing line goes to stderr;
  - a handler that throws, or returns a `Date` or a cycle, exits 1 with the error, and the run goes
    on; a result over 64 KiB encoded fails;
- tests, the budget and the end:
  - a handler past its budget aborts `call.signal`, and `wf tool` exits 4 with the timeout, not the
    connection's; a deadline shorter than the budget wins; `timeoutMs: false` is bounded by the
    deadline alone;
  - a call longer than the wire's 30 s and within its budget answers;
  - a cancelled turn, a passed deadline, a stopped agent and an ended attempt each abort the
    handler's signal; one that ignores it is settled 5 s later, after which `run()` resolves;
  - `wf result` and `wf waiting` are refused while a call runs;
  - a message turn that ends with a call running aborts its signal, and the next operation starts
    only once the call has settled;
  - a dropped connection exits 4; a request that never reached the engine exits 3; an
    `internal-error` exits 4, as when `tool-ended` can't be written;
- tests, the handler:
  - a handler inside a stage carries the stage's tag and deadline; one in a top-level turn runs in
    no scope;
  - `run`, `compact`, `set`, `fork` and `agents.stop` on its own agent are refused at once, as is
    `run` on A from B's handler called from A's; `run()` on another agent works; in a drained
    message turn of a sealed stage, `run()` throws; `workflow.receive()` in a handler is refused;
- tests, specs:
  - a name, a count, a description or a schema over its limit, and a `timeoutMs` that is neither a
    positive integer nor `false`, are refused at `open` and at `fork`;
  - a reopen with matching tools, one in TypeBox and one in JSON Schema, reattaches with the new
    handlers; one with different tools conflicts; one without `tools` keeps the handlers; `attach`
    returns them;
  - a fork has its parent's tools and `call.agent` is the fork's key; `fork({ tools })` replaces
    them; `tools: {}` gives none; a later reopen of the parent leaves the fork's handlers; the same
    `fork` again returns the fork with the handlers it gives, and without `tools` keeps the fork's;
    a `fork({ tools })` with handlers doesn't throw on the spec's clone; `caller()`'s ref forked with
    `tools` is refused;
  - after a continue, a reused stage doesn't run its handlers again;
  - it works for a sandboxed agent.

### 4. The tools lesson

Outcome: every operation's prompt teaches the agent's tools, with their descriptions.

Execution:

- [x] Plan, implement, review, resolve, verify (as in the template). Reviewed in three rounds,
  the last clean; live on codex and cursor.

Implementation notes:

- `toolsLesson` in `tools.ts`, from `ToolCalls.taught`: the call form, the heredoc form only when a
  tool is taught as JSON, the quoting rule only when a tool takes flags and the result block didn't
  say it, then each tool. A workflow turn's block follows its result block in its first prompt; a
  message turn's follows what it opens on. Check-ins don't repeat it: they continue the same turn,
  as the routes lesson isn't repeated either.
- A description's own lines are indented under it. An input schema of no properties,
  `Type.Object({})`, is a tool that takes no input, called and taught by its name alone, unless it
  says `additionalProperties: true`, which takes any JSON object.
- Live, 2026-10-26: `examples/tools` on codex `gpt-6-luna` and cursor `composer-2.5` headless, from
  the lesson alone: `list_open`, then both items closed with flags first time, the backup item's
  title, with its `'` and `$HOME`, arriving word for word; three `tool-called` and `tool-ended`
  records each.

Done when:

- tests: an agent with tools gets the lesson, as task 1 fixed it, in every operation, a turn and a
  message turn; one without tools gets none; each tool is listed by its name and description, then a
  usage line carrying each bound for a simple input, or its schema for any other; the tools block
  comes after the result block; the quoting rule appears once, under the result block when it uses
  flags, else in the tools block, and a message turn's tools block carries it; the heredoc call
  form appears only when a tool is taught as JSON.

### 5. Records and `awf logs`

Outcome: every call is in the run's event log with its input, result or error and duration, and
`awf logs` shows it.

Execution:

- [x] Plan, implement, review, resolve, verify (as in the template). Reviewed in two rounds,
  the last clean.

Implementation notes:

- `awf logs` shows a call on its end's line, `tool call close_item {"id":"a1"}  ok  → Closed a1.`,
  its input taken from its `tool-called` record, which is then not shown, and its duration only
  past a second; a call whose end isn't in the log shows that record, `no end yet`. A refusal shows its code and, for `invalid-input`, what the agent
  was told. "tool call" sets them apart from the harness's own tools, which `awf logs` shows as
  `tool exec …`. `--json` keeps both records.

Done when:

- tests: a call, a refusal, a failure, a timeout and a cancellation each leave their records; an
  envelope refusal leaves none;
  `awf logs` prints a call on one line.

### 6. workflow-testing

Outcome: a scripted turn, or a scripted message turn, calls `tool(name, input)` and gets the result
or the refusal, as `send()` does.

Execution:

- [x] Plan, implement, review, resolve, verify (as in the template). Reviewed in two rounds,
  the last clean.

Implementation notes:

- `Turn.tool(name, input?)` and `ReceivedMessage.tool` send a real `tool` request over the agent's
  socket with the input as JSON, as `send()` does, with no client timeout, and resolve to
  `ToolOutcome`: `result`, `failed` or `refused`. An `internal-error` throws, as an unexpected
  refusal of `send()` does. A compaction's script calls no tools.
- `examples/tools/workflow.test.ts` tests the example, and a small workflow of its own for the
  message turn, since the example has no routes.

Done when:

- `examples/tools`'s test closes an item through its tool and sees the item closed, a call with
  input that doesn't fit leaves it open, and a scripted message turn's call closes it too.

### 7. `examples/tools`, live

Outcome: a cheap model on each harness calls the example's tool from the lesson alone.

Execution:

- [x] Plan, implement, review, resolve, verify (as in the template).

Implementation notes:

- `examples/tools` runs one triager per runtime, each with three tools: `list_open`, no input;
  `label_item`, taught as JSON, since its labels are a list; `close_item`, taught with flags. The
  result is taught with flags too. `--slow={ms}` makes `list_open` take that long.
  `tests/tools.eval.ts` checks each agent closed both items, the backup one with its title word for
  word as the reason, and labelled it, and counts each agent's calls, refusals and failures from the
  records.
- Live, 2026-10-26, cheap models (codex `gpt-6-luna`, cursor `composer-2.5`, claude
  `claude-sonnet-5-5`):
  - codex and cursor headless, codex, cursor and claude in a pane: every agent right first time,
    4 calls and no refusal each; the reason with `'` and `$HOME` arrived word for word every time.
    About $0.11 at list prices for the five, run again after the join with the same result.
  - cursor, `list_open` taking 40 s: the command was backgrounded at 30 s, the agent read the
    result from it, one call.
  - codex, `list_open` taking 15 s: its shell handed the command back at 10 s, and the agent didn't
    poll it. It ran `wf tool list_open` again at 14 s, refused `tool-busy`; the first call ended at
    15 s unread; it called a third time, which ran the handler again, and polled that one. So on
    codex a handler past 10 s is called again: M2's risk, seen. Its session log says why: its first
    `exec_command` printed only the output, so nothing was left to poll, and the process was gone.
    Rewording `tool-busy` didn't change it. So the same call made again while it runs now joins it
    and gets its answer: run again, codex called at 12 s, joined, read the list at 15 s, and the
    handler ran once, no refusal.
  - Not run: pi, whose login had expired again; claude headless, billed per token.

Done when:

- `tests/tools.eval.ts` passes on codex, cursor and pi on their cheap models, in a pane and
  headless, and claude in a pane (headless claude is billed per token, which `docs/testing.md`
  keeps out where a feature doesn't need it), for a tool and a result taught with flags, a tool
  with no input, and a tool taught with JSON, its input not simple, and its first-try rate is
  recorded beside M1's; in a pane on every harness, a no-input call and a call with flags complete
  the turn, which they wouldn't if they waited on standard input.
- a handler that takes 15 s, past codex's 10 s, and one that takes 40 s on cursor, past its 30 s:
  each agent reads the result, and the handler runs once with no refusal. A join isn't recorded, so
  whether codex polled or joined is read from its session log, and its first-try count misses the
  joined call.

### 8. With story 034

Outcome: tools work with 034's turns not awaited and parking, as "With story 034" says.

Execution:

- [x] Plan, implement, review, resolve, verify (as in the template).

Implementation notes:

- Most of it held already: a started turn's operation waits for its calls before it ends, as every
  operation does (task 3), so its end, `cancel()` and the run's parking come after; the tests in
  `tools.test.ts` ("with started turns") pin it, a handler lingering 200 ms past its abort.
- `cancel()` on a started turn from a handler of its agent is refused `agent-in-tool`; it waited
  for the turn, which waits for the handler. `start()` checks `agent-in-tool` before 034's
  refusal of a `start()` in a stage, so a handler of a turn in a stage hears the first.
- A turn `start()` begins from a handler runs outside it, as nothing waits for it: its own
  handlers may then work the first agent, whose later turns it would otherwise be refused. So does
  a message turn a handler made due, by a run whose end let a held message through, or by `allow`.
- Left: a handler that starts a turn and then cancels it, while that turn's handler runs work on
  the first handler's agent, isn't refused; it waits until the settle drops the second handler,
  5 s, and leaves that work queued: a real turn that later runs on the first agent, unawaited.
  Refusing it would mean tracking which handler started a turn, and would refuse fair cancels.
- `dd-case.ts` gives `close_case` through `tools`; its handler awaits `emitToSelf` with no id and
  returns a line for the agent.

Done when:

- tests: a started turn with a call in flight writes `agent:ended` only once the call has settled,
  and `cancel()` resolves only then; a run with a call in flight doesn't park; `start()` from a
  handler on an agent it is in throws `agent-in-tool` before 034's own refusals, as does `cancel()`
  on that agent's started turn;
- `dd-case.ts` gives `close_case` through `tools`, its `withTools` stub gone, its `input`
  `outputSchema(Type.Omit(Closed, ["case", "by"]))`, since `Type.Omit` drops the type; its handler awaits
  `emitToSelf` with no id, the stub's `id` made optional, and returns a line for the agent: a
  `call.id` changes when a turn is run again after a crash, and the case's own id would drop a
  close after the case reopens, so a repeated close is the case's to absorb, as its test "a closed
  case is written up once" says; `bunx tsc --noEmit` passes.
