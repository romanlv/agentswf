---
title: Workflow API
description: "Every call a workflow can make today, from agentswf/workflow, with its options and defaults."
outline: [2, 3]
---

# Workflow API

Every call a workflow can make today, its options, defaults and refusals. A workflow imports them
from `agentswf/workflow`. This page specifies; the guide teaches. Start at
[How it works](/guide/how-it-works) for the words (workflow, run, agent, turn, outcome, harness,
TUI, stage, nudge), and follow each section's link to the guide page that explains the idea.

The types, with every field documented, are in
[`packages/contract/src/workflow`](https://github.com/romanlv/agentswf/tree/main/packages/contract/src/workflow),
and [`examples/`](https://github.com/romanlv/agentswf/tree/main/examples) has complete workflows.
A workflow's tests use [`agentswf/testing`](/reference/testing-api).

## At a glance

**The workflow file**

| Call | Returns |
| --- | --- |
| [`defineWorkflow({ meta, run, prepare?, id?, present?, report? })`](#defineworkflow) | the workflow, as the file's default export |
| [`defineWorkflow({ …, file, events, starts? })`](#events) | a workflow whose runs take events |

**Agents**

| Call | Returns |
| --- | --- |
| [`wf.agents.open({ key, runtime, instructions?, skills?, sandbox?, cwd?, layout?, keepPane?, tools?, timeout? })`](#agents-open) | an agent |
| [`agent.run({ prompt, schema?, timeout?, label?, nudge? })`](#agent-run) | `{ outcome }`, in the agent's same session |
| [`agent.compact({ prompt, timeout? })`](#agent-compact) | an outcome; the harness's own compaction |
| [`agent.set({ model?, effort?, timeout? })`](#agent-set) | an outcome; later turns run at these |
| [`agent.fork({ key, runtime?, instructions?, layout?, keepPane?, tools?, timeout? })`](#agent-fork) | a new agent on a copy of this one's session |
| [`agent.execution`](#agent-execution) | the agent's harness, model, effort and placement now |
| [`agent.close(reason?)`](#agent-close) | `true` once closed; `false` if an earlier `close()` closed it |
| [`wf.agents.caller({ key })`](#agents-caller) | the session `awf run --here` was typed in, or `null` |
| [`wf.agents.forkCaller({ key, runtime?, instructions?, layout?, keepPane?, timeout? })`](#agents-forkcaller) | a new agent on a copy of the session `awf run` was started from, or `null` |
| [`tool({ description, input?, handler, timeout? })`](#tool) | a tool, for `open`'s and `fork`'s `tools` |

**Composing work**

| Call | Returns |
| --- | --- |
| [`wf.parallel(items, (item, i) => …, { concurrency?, label?, timeout? })`](#parallel) | results in item order |
| [`wf.sandboxes.open({ key, cwd?, read?, write?, network?, sockets?, webSearch?, srt? or docker? })`](#sandboxes-open) | a sandbox, for `open`'s `sandbox` |
| [`wf.decisions.decide({ key, model, state, questions, timeout? })`](#decide) | `{ answers, record }` |
| [`choice(…)`, `yesNo(…)`, `score(…)`](#decide) | a decision question |
| [`wf.messages.allow({ from, to, purpose, maxMessages?, timeout? })`](#messages-allow) | routes granted; also `{ between: [a, b], … }` |
| [`wf.participants.connect({ key, labels? })`](#participants-connect) | a participant outside the run; `.release(reason?)` |

**Stages and time**

| Call | Returns |
| --- | --- |
| [`wf.stage(name, { result, summary? }?, async () => …)`](#stage) | the stage's value; reused on a continue |
| [`wf.stop(reason)`](#stop) | never; ends the attempt `stopped` |
| [`wf.sleep(name, "14d" or date)`](#sleep) | once the time recorded under `name` has come |
| [`wf.now()`](#now) | the run's time; a test's virtual clock in a test |

**Waiting**, in every workflow; one with events parks while it waits

| Call | Returns |
| --- | --- |
| [`wf.receive({ label? })`](#receive) | the events not yet acknowledged |
| [`wf.race(name, { branch: source or "2d", … }, { label? })`](#race) | `{ key, [key]: what won }`, recorded under `name` |
| [`wf.select({ branch: source, … }, { label? })`](#select) | each event a branch takes, one at a time |
| [`wf.timer(name, "2d" or date)`](#timer) | a timer, a source; `timer.cancel()` |
| [`wf.signal(name)`](#signal) | one declared event, as a source |
| [`wf.at(() => date or null)`](#at) | a select's branch, due at a time the state holds |
| [`wf.after("3h")`](#after) | `now()` plus a duration, as a `Date` |
| [`wf.started`](#started) | the event that started the run |
| [`agent.is(e)`, `participant.is(e)`, `timer.is(e)`, `signal.is(e)`](#is) | narrows an event |

**A workflow with events**

| Call | Returns |
| --- | --- |
| [`agent.start({ prompt, schema?, meta?, … })`](#agent-start) | a turn not awaited; its end arrives as `agent:ended` |
| [`agent.turn`, `turn.cancel(reason?)`](#agent-turn) | the started turn, until a wait takes its end |
| [`wf.agents.open({ …, keepAlive: { window?, onTimeout? } })`](#keepalive) | the run stays live after the agent's turns |
| [`wf.participants.connect({ key, labels?, to: "code" })`](#participant-to-code) | a participant whose replies come to the code; `.post(text)` |
| [`wf.emit(target, run, name, data, { eventId? })`](#emit) | `"accepted"`, `"duplicate"` or `"refused"`; any workflow emits |

**The run**

| Call | Returns |
| --- | --- |
| [`wf.log(message, fields?)`](#log) | nothing; a line in the progress view and `awf logs` |
| [`wf.usage()`](#usage) | this scope's finished operations |
| [`wf.allowance(harness)`](#allowance) | what is left of a harness's plan |
| [`wf.runId`, `wf.attempt`, `wf.cwd`, `wf.deadline`](#run-context) | the run's id, the attempt's number, its directory and deadline, a `Date` |

**Results and errors**

| Name | What it is |
| --- | --- |
| [Outcomes](#outcomes) | how a turn ended: `answered`, `unanswered`, `blocked`, `timed-out`, `failed` or `cancelled` |
| [Deadlines](#deadlines) | `timeout`, a duration or a `Date`, never past the bound around it |
| [`duration(text)`](#waiting-on-time) | a string read from data, checked, as a `Duration` |
| [`DeadlineExceededError`](#deadlines) | what `parallel`, `decide` and a call past its scope's deadline reject with |
| [`DecisionError`](#decide) | a decision that was sent and didn't answer |
| [`Ending`](#ending) | how an attempt ended, `parked` included, as `present` and `report` get it |
| [Types](#types) | the types and constants `agentswf/workflow` exports |

[Deprecated](#deprecated) lists the old forms that still work, and what replaces each.

## A workflow file

```ts
// summarize.ts
import { defineWorkflow } from "agentswf/workflow";
import Type from "typebox";

export const SUMMARY = Type.Object({ summary: Type.String() }, { additionalProperties: false });

export default defineWorkflow({
  meta: { name: "summarize", description: "Summarize one file." },
  async run(wf, args: { file: string }) {
    const agent = await wf.agents.open({ key: "reader", runtime: "claude" });
    const { outcome } = await agent.run<Type.Static<typeof SUMMARY>>({
      prompt: `Read ${args.file} and summarize it in two sentences.`,
      schema: SUMMARY,
    });
    return outcome.answered ? outcome.value : { summary: `no answer: ${outcome.reason}` };
  },
  // Turns the command line into args: `awf run summarize.ts -- src/index.ts`.
  prepare: ({ argv }) => ({ file: argv[0] ?? "README.md" }),
  // Optional: what a person sees at the terminal instead of the record.
  present: (result) => result.summary,
  // Optional: Markdown saved beside the run as report.md.
  report: (result) => (result ? `# Summary\n\n${result.summary}\n` : undefined),
});
```

The guide: [Workflows](/guide/workflows).

### defineWorkflow {#defineworkflow}

`defineWorkflow(spec)` returns the workflow; the file exports it as its default.

| Field | |
| --- | --- |
| `meta` | `{ name, description, version? }`. `name` names the folder its runs are kept in: letters, digits, `.`, `_`, `@` and `-`, starting with a letter or digit. `version`, optional, is semver; [`stage`](#stage) says what it guards. |
| `run(wf, args)` | The workflow. `args` and the result are JSON. |
| `prepare({ argv, cwd })` | Turns the command line (`argv` after `--`, and `cwd`) into `args`. Required when `run` takes arguments: a workflow whose `args` aren't `null` without `prepare` fails `tsc`. Left out, the workflow takes none: its args are `null`, and any argv is refused. A throw ends the run before any agent opens. A run an event starts has no argv, and gets what `prepare` makes of none. |
| `id(args)` | Optional. The run's id, such as a ticket's key: letters (either case), digits, `.`, `_`, `@` and `-`, starting with a letter or digit, at most 128 characters; an id differing from another only in case is refused. `awf run --id` overrides it. With neither, awf makes one, except for a workflow with `starts`, whose run is then refused: its senders name its runs. A run's ref is `{workflow}/{id}`. |
| `present(value, ending)` | Optional. What a completed attempt prints. Without it, or when it returns `undefined` or throws, `awf run` prints the whole record, `output.json`; `--json` always prints the record. |
| `report(value, ending)` | Optional. Markdown saved as `report.md` beside the run. Called however the attempt ended, so a stopped run can still hand off what its stages found: `value` is `undefined` unless it completed. `undefined` writes no report. |
| `file`, `events`, `starts` | A workflow whose runs take events: see [Events](#events). |

<a id="ending"></a>`ending` says how the attempt ended. Every kind has `stages`, one per stage the
attempt entered: `stage`, `source` (`"ran"` or `"reused"`), `outcome` (`succeeded`, `stopped` or
`failed`), `attempt` (the one that ran it), `spanMs`, `summary?` and `value?`. Beyond that:

| `kind` | Fields |
| --- | --- |
| `completed` | `value`. |
| `parked` | `label?`, its last wait's label, and `until?`, an ISO time: a workflow with events waiting with nothing to do. |
| `stopped`, `failed`, `timed-out`, `cancelled` | `stage?`, the stage it ended in; `reason`; `continue`, the command that goes on; `needs?`, the stages whose values `--values` must give to start part-way, each `{ stage, schema }`, when it stopped for them. |

The result, every agent's usage and how the attempt ended are kept in `output.json`, in
`.awf/runs/{workflow}/{id}` under the working directory, for failed and cancelled runs too.
[The record](/guide/how-it-works#the-record) says what else a run keeps.

## Agents

The guide: [Agents](/guide/agents), [Harnesses](/guide/harnesses).

<a id="opening-one"></a>

### wf.agents.open {#agents-open}

<<< @/../examples/site/reference/workflow-api.ts#open

| Field | |
| --- | --- |
| `key` | Required. The agent's name in this run, such as `review-security`. Opening the same key again returns the same agent when every field given matches; a field that conflicts rejects. `operator`, `awf`, `system` and `user` are reserved. A key with a colon is [deprecated](#deprecated): a colon is kept for awf's own event names. |
| `runtime` | Required. An alias, `"claude"` or `"codex"`; `{ harness, model, effort?, placement?, metered? }`; or `{ alias, harness?, model?, effort?, placement?, metered? }` to constrain an alias, where `harness` and `model` must match it and `effort` replaces its effort. |
| `instructions` | Standing instructions, given once when the agent opens. |
| `skills` | Exactly the skills this agent gets: `{ path }`, an absolute path or `file:` URL of a directory holding a `SKILL.md`, or `{ repo: "owner/repo", skill, ref? }`. Left out, it has what it would have without awf: yours on the host, none in a sandbox. |
| `sandbox` | A sandbox from [`wf.sandboxes.open`](#sandboxes-open), or an inline spec for a private one. Left out, the agent is unsandboxed. |
| `cwd` | Where the agent works; `wf.cwd` by default, which `awf run --cwd` sets. |
| `layout`, `keepPane` | Where its pane appears, and whether it stays once the agent is done: [Where panes go](#where-panes-go-layout-and-keeppane). |
| `tools` | What it can ask your code to do mid-turn: [`tool`](#tool). |
| `timeout` | Bounds the open, as for [`run`](#agent-run); the enclosing scope's by default. |

The `runtime` fields:

| Field | |
| --- | --- |
| `harness` | `"claude"`, `"codex"`, `"pi"` or `"cursor"`. |
| `model` | The harness's own model name. |
| `effort` | In the harness's own words: claude's `low` to `max`, codex's `low` to `ultra`, pi's `off` to `max`. cursor takes none: name the variant as the model (`gpt-5.6-luna-high`). Left out, the harness uses its default. |
| `placement` | `"tui"`, the default: the harness's own TUI, kept between turns, in a terminal pane in [Herdr](https://herdr.dev) you can watch and type into; or `"headless"`, a process per turn. |
| `metered` | `true`: required for headless claude. [Subscription and metered](/guide/harnesses#subscription-and-metered) says why. |

The aliases `awf run` installs are `claude` (claude, `sonnet`) and `codex` (codex,
`gpt-5.6-sol`). Both open in their TUI unless `placement` says otherwise.

<a id="giving-it-work"></a>

### agent.run {#agent-run}

<<< @/../examples/site/reference/workflow-api.ts#run

| Field | |
| --- | --- |
| `prompt` | Required. The turn's prompt. |
| `schema` | A JSON Schema, such as a TypeBox one, the answer must fit. The agent answers with [`wfa result`](/reference/wfa#result); a refused answer can be sent again within the turn. Without it, the answer is a string. |
| `timeout` | Bounds the whole turn, nudges included: a [duration](#waiting-on-time) from the call, a `Date` to end by, or `false` for no bound of its own. Never past the enclosing [deadline](#deadlines). |
| `label` | The turn's name in the progress view and the record. |
| `nudge` | On by default: an agent that stops without an answer is nudged to give it. `false` turns it off. `{ prompt }` replaces the nudge's opening line; the lines on how to answer still follow. |

The type argument, `run<Type.Static<typeof X>>`, gives the answer its TypeScript type; a TypeBox
schema doesn't carry one on its own. A wait on a [participant](#participants-connect)'s answer
moves the turn's bound out by the wait's length, within the deadlines around it.

Every `run` on the same agent continues its session, so it remembers its earlier turns.
<a id="sessions-talk-to-the-same-agent-again"></a>[Loops](/guide/parallel-and-loops#round-after-round) builds on that. How a
nudge reads and when it comes: [Timeouts and nudges](/guide/timeouts).

### Outcomes {#outcomes}

`run` settles every ending on the agent's side as an outcome. It rejects only on misuse or a
scope that has ended:

- the enclosing scope's deadline has passed, or the scope was cancelled (`DeadlineExceededError`);
- the agent is closed (`logical agent is closed`): stopped, or after a turn of it failed or timed
  out;
- the agent has a [started turn](#agent-turn) no wait has taken the end of;
- it is called from a tool's handler the agent is in;
- a continue is stopping for stage values it found missing.
[What each ending means](/guide/agents#what-each-ending-means) says what each leaves of the agent.

| `kind` | Fields |
| --- | --- |
| `answered` | `value`, the checked answer. |
| `unanswered` | `reason`. The agent stopped without an accepted answer, even after a nudge. |
| `blocked` | `reason`. The agent is showing a question only a person can answer, such as a permission prompt. |
| `timed-out` | `reason`. The turn's deadline passed. |
| `failed` | `reason`, `retryable` and `login?`. `retryable` is `false` for every turn that runs today; only a [started turn](#agent-start) whose attempt ended before it did is `true`. `login` is set when the harness has no login, or it was refused: `{ harness, provider?, run }`, with `run` saying what the operator should run. |
| `cancelled` | `reason`. The run, an enclosing scope or [`agent.close()`](#agent-close) stopped it. |

Every outcome also has `answered`, `true` only for `answered`, and `usage`, the operation's
record: its times, sessions and settings. Checking `answered` narrows `outcome.value` to the
schema's type, and every other outcome to one with a `reason`:

<<< @/../examples/site/reference/workflow-api.ts#isanswered

A turn that fails or times out closes its agent, which takes no more turns; the calling session
is the exception. A missing login fails every agent on that harness the same way, so a workflow
that shouldn't go on stops on it:

<<< @/../examples/site/reference/workflow-api.ts#login

<a id="compacting-keep-the-agent-shrink-its-context"></a>

### agent.compact {#agent-compact}

Runs the harness's own compaction, as `/compact` with a focus does. `prompt` says what to keep and
what to drop; the next `run` goes on in the compacted session.

<<< @/../examples/site/reference/workflow-api.ts#compact

- **Fields:** `prompt`, required; `timeout`, as for `run`.
- **`answered`** means it compacted. `value` is the summary from claude and pi, `""` from codex,
  which keeps it encrypted, and `""` from cursor.
- **Any other outcome** leaves the context as it was, so going on is usually right.
- **Where:** claude, codex and pi, in their TUI or headless; cursor in its TUI only. pi only
  summarizes what is older than its last 20k tokens, so a short pi session fails "nothing to
  compact". The calling session's ref, a [`CallerRef`](#agents-caller), has none.
- It runs after the agent's earlier turns.

<a id="switching-model-or-effort-set"></a>

### agent.set {#agent-set}

Switches the model, the effort or both for every later operation, as `/model` or `/effort` does.
The session and its context stay.

<<< @/../examples/site/reference/workflow-api.ts#set

- **Fields:** `model`, another model of the same harness; `effort`; `timeout`, as for `run`.
- **`answered`** means the switch is in force, and [`agent.execution`](#agent-execution) shows the
  new settings.
- **It is refused** for an effort the harness doesn't list and on a cursor TUI agent. The calling
  session's ref has no `set`. Another harness or placement is another agent.
- **A TUI agent whose switch fails or times out is closed**, as after a failed turn.
- **Switching the model costs the cache**: the next turn reads the whole context at full price.

<a id="forking-new-agents-that-start-from-what-one-knows"></a>

### agent.fork {#agent-fork}

Opens a new agent on a copy of this agent's session, so it knows what this agent knew without
being told again, and reads that context from the provider's cache
([the design record](https://github.com/romanlv/agentswf/blob/main/docs/adr/0009-a-fork-is-a-new-agent-on-a-copy-of-the-session.md)).

<<< @/../examples/site/reference/workflow-api.ts#fork

- **The copy is taken when `fork` is called**, after the agent's earlier operations. From then on
  neither sees the other's turns.
- **A fork has its parent's** harness, model, effort, placement, working directory, sandbox,
  skills and tools. It may name its own `instructions`, `tools` (`{}` for none) and `runtime`,
  `{ placement?, metered?, effort? }`, as [`open`'s](#agents-open) fields: never a harness or
  model, since it continues its parent's session on them. It never inherits `layout` or
  `keepPane`: without them it gets a tab of its own. `timeout`, as for [`run`](#agent-run), bounds
  taking the copy and opening the fork.
- **It rejects** before the parent's first turn, once the parent is closed, and after a `set`
  queued before it that didn't take. Every harness forks, in its TUI or headless, sandboxed too.
- **The same key** with the same parent and spec returns the same agent.

### agent.execution {#agent-execution}

The agent's settings now: `harness`, `model`, `effort?`, `placement?`, `metered?`, `alias?` when
it was opened through one, and `caller: true` for the calling session, whose `model` is `""`. As it
was opened, then as the last answered `set` left them.

### Where panes go: layout and keepPane {#where-panes-go-layout-and-keeppane}

Each TUI agent gets a tab of its own in the run's Herdr workspace, closed once it is done. `layout`
places it elsewhere as it opens, or at its first turn in a workflow with events
([Where panes go](/guide/harnesses#where-panes-go)):

<<< @/../examples/site/reference/workflow-api.ts#layout

- **A new tab**: `{ session?, workspace?, tab? }`. `session` is the terminal session, the run's by
  default. `workspace` is `"run"` (the default), `"origin"`, where `awf run` was typed, or
  `{ name }`, found or made. `tab` defaults to the key.
- **Beside another agent**: `{ beside: key, side: "right" | "below", share? }` splits that agent's
  pane; `share`, 0.2 to 0.8, is the new pane's part, 0.5 by default.
- **Refused at `open`:** `layout` or `keepPane` on a headless or sandboxed agent, and a malformed
  value (an unknown field, a `side` other than `right` or `below`, a `share` out of range, an agent
  `beside` itself).
- **A well-formed layout that can't be placed**, such as beside an agent with no pane, falls back
  to a tab of its own and never fails the agent. The run's closing lines say which agent fell back
  and why.
- **`keepPane`**, `"never"` (the default), `"on-failure"` (when its last operation wasn't
  answered) or `"always"`, keeps the pane once the agent is done. Its harness is left running and
  released: what you type into it is yours. awf never closes a kept pane.

### agent.close {#agent-close}

<a id="agents-stop"></a>

<<< @/../examples/site/reference/workflow-api.ts#close

`agent.close(reason?)` closes an agent the workflow is done with, so it doesn't sit idle until the
run ends. A turn it is running ends `cancelled`, its pane is closed or, as `keepPane` says, kept,
and its key can't be opened again. It resolves `true` once the agent is closed, a turn that failed and
closed it included, and `false` if an earlier `close()` did. Closing the calling session hands it back to its operator then rather than at
the end of the run.

<a id="the-calling-session"></a>

### wf.agents.caller {#agents-caller}

`awf run --here`, typed in a claude, codex, pi or cursor session in a Herdr pane, starts the run in
a tab of its own, and the run can drive that session as an agent
([the design record](https://github.com/romanlv/agentswf/blob/main/docs/adr/0010-the-calling-session-is-an-agent.md)).
The guide: [Calling session](/guide/calling-session).

<<< @/../examples/site/reference/workflow-api.ts#caller

- **`null`** means there is no calling session: refuse, or open an agent of your own.
- **The same key** returns the same agent; another key rejects.
- **It is the operator's session**, so its ref is a `CallerRef`: an agent without `compact` or
  `set`. Called anyway, from JavaScript, `set` is refused and `compact` ends `failed` with the
  session as it was. It takes no `instructions`, and
  stays usable after a turn that fails, is cancelled or times out. The operator interrupting a turn
  settles it `cancelled`. Where the harness's interrupt can't be recognised, an unanswered turn
  isn't nudged by default. Its forks are [`forkCaller`](#agents-forkcaller)'s, and take no `tools`.
- **When the run ends**, the session gets one message saying how and where the run's records
  are. A run that is killed sends none.

<a id="forking-the-session-that-started-the-run"></a>

### wf.agents.forkCaller {#agents-forkcaller}

Opens an agent that knows what the session `awf run` was started from knows, without spending that
session's context on the work. The session waits on `awf run` as an ordinary command and reads the
result as its output. The guide: [Calling session](/guide/calling-session).

<<< @/../examples/site/reference/workflow-api.ts#forkcaller

- **Fields:** those of [`fork`](#agent-fork) but `tools`: `key`, `runtime`, `instructions`,
  `layout`, `keepPane` and `timeout`. Root scope only.
- **`null`** means there is no session to fork, and the run's output says why.
- **The copy** holds the session up to the command that started the run; with `--here`, after the
  run's turns to it. The fork runs on the model the session last ran, with awf's launch flags and
  the operator's skills, not their settings or MCP servers.
- **Under codex's default sandbox**, the run is inside it and TUI agents can't reach Herdr. The
  [`awf-run` skill](https://github.com/romanlv/agentswf/tree/main/packages/engine/skills/awf-run)
  says how each harness waits on a long run.

<a id="tools-the-agent-calls-your-code"></a>

### tool {#tool}

A tool is a function in your workflow an agent calls while it works, with
[`wfa tool`](/reference/wfa#tool), and reads
what it returns. Holding a tool is what lets the agent call it. The guide: [Tools](/guide/tools).

<<< @/../examples/site/reference/workflow-api.ts#tool

| Field | |
| --- | --- |
| `description` | Required. What it is for, as the agent reads it in its prompt. |
| `input` | An object schema. A TypeBox schema carries no TypeScript type, so give it as the type argument, `tool<Type.Static<typeof X>>`, which types the handler's input. Left out, the tool takes none, and the handler gets `{}`. |
| `handler(input, call)` | Required. Runs once per accepted call; what it returns is what the agent reads. `call` has `id`, `agent` (the caller's key, a fork's own) and `signal`, aborted when the call's budget passes or its turn ends. |
| `timeout` | Each call's budget, 30 s by default; `false` leaves only the turn's deadline. |

- **The agent's prompt teaches its tools**, in every turn: each one's name and description, and how
  to call it. A simple input, up to 6 strings, numbers, booleans or enums, is taught as flags,
  `wfa tool close_item --id <text> --status done|wontfix --why <text>`; any other as JSON.
- **The result:** a string prints as is, other JSON as JSON, nothing as nothing; a throw fails the
  call, not the run. Input that doesn't fit the schema is refused before the handler runs, and the
  agent corrects it.
- **Keep the handler short:** it runs while the agent waits. A shell command that runs long is
  backgrounded by claude after 2 minutes and cursor after 30 s, and handed back to codex to poll
  after 10 s. An agent that calls again with the same input while the call runs gets its answer,
  once; a call after it ended runs it again, so a handler past 10 s should be safe to repeat.
- **It can't give work to the agent that called it**, which is in a turn: `run`, `start`,
  `compact`, `set`, `fork`, `close` and `cancel()` on its started turn throw, as they do on
  an agent whose handler ran this one's, and so does `wf.receive()`. It may run another agent,
  except in the message turns a stage runs after its body, where no code can.
- **Limits:** names match `^[a-z][a-z0-9_]{0,47}$`; at most 16 tools an agent, 1 KiB a
  description, 8 KiB a schema, and 64 KiB for a call's input and for its result.
- **On a reopen**, tools match by name, description and input schema, never by handler: matching
  ones take the new handlers and budgets. A fork has its parent's unless it gives its own.
- **Recorded:** each call, its input and its result or error are in the run's event log, and
  `awf logs` shows them.

## Composing work

### wf.parallel {#parallel}

`Promise.all` with a concurrency limit and a deadline, which the engine tracks and shows. Results
come back in item order. The guide: [Parallel](/guide/parallel-and-loops).

<<< @/../examples/site/reference/workflow-api.ts#parallel

- **`concurrency`**, a positive integer, defaults to all at once. **`label`** names the group in
  the progress view ("review 2/3"). **`timeout`** bounds the whole group, as
  for [`run`](#agent-run).
- **When its deadline passes**, the turns still running end `timed-out`, and `parallel` rejects
  with `DeadlineExceededError`: the results already gathered are dropped.
- **It's fail-fast.** If one item throws, the others are cancelled and `parallel` rejects. Outcomes
  don't throw, so in the pattern above one bad agent never stops the rest.
- **It nests.** An empty list resolves to `[]`.

### Deadlines {#deadlines}

A run has no deadline unless `awf run --timeout 2h` gives it one, as `wf.deadline`. Everything
inside inherits it. A call that takes `timeout` sets its own bound: a
[duration](#waiting-on-time), `"10m"`, counts from the call; a `Date` is the time it ends by,
but not on a [tool](#tool) or a [route](#messages-allow), whose bound is per call; `false` means
no bound of its own. Whatever it gives, the bound never reaches past the stage, `parallel` or run around the call: a later one is cut to it, so
`agent.run({ prompt, timeout: "2h" })` inside a `parallel` with `timeout: "20m"` has twenty
minutes at most. The guide:
[Timeouts and nudges](/guide/timeouts).

When a deadline passes, turns under it end `timed-out`, and `parallel` and `decide` reject with
`DeadlineExceededError`, which `agentswf/workflow` exports. Without any deadline, turn liveness
still stops a turn that stalls. An agent waiting on a participant's answer isn't working: its
clock stops while it waits, within any deadline around it. When the run ends, for any reason,
every agent it opened is closed and every sandbox torn down; only kept panes and the calling
session stay.

<a id="sandboxes"></a>

### wf.sandboxes.open {#sandboxes-open}

The guide: [Sandboxes](/guide/sandboxes).

<<< @/../examples/site/reference/workflow-api.ts#sandbox

| Field | |
| --- | --- |
| `key` | Required. The sandbox's name in this run. |
| `cwd` | Its working directory, `wf.cwd` by default; always readable inside. |
| `read` | Host paths visible read-only, at the same path, beyond the working directory. |
| `write` | Host paths visible and writable. `"."` makes the working directory writable. |
| `network` | Domains reachable beyond each harness's model API: exact, or `*.example.com` for its subdomains only. No scheme, port, path or IP address. |
| `sockets` | Host unix sockets the agents may connect to: a socket, or a directory of them, where they may create their own if it is also in `write`. srt only; docker refuses it. |
| `webSearch` | `true` keeps the harnesses' model-side web tools, which are off inside otherwise. |
| `srt` or `docker` | Required, exactly one: `srt: {}`, Anthropic's sandbox-runtime on your machine; `docker: { image? }`, a container running as your user. There is no default. |

An inline spec on `open` takes the same fields but `key` and `cwd`, and is always private.

- **Web search runs on the model provider's servers**, past any `network` rule, so with
  `webSearch: true` it can carry out what the agents read. claude's `WebFetch` goes with it.
  cursor keeps its web tools either way, and pi has none.
- **Agents sharing a sandbox can read each other's files**, their homes and skills included.
  Under docker they share one container; under srt each agent is wrapped on its own, and they meet
  only in the writable paths.
- **Logins:** claude needs `CLAUDE_CODE_OAUTH_TOKEN` and cursor `CURSOR_API_KEY` in your
  environment, as their logins live in the keychain; codex and pi copy theirs in.
- **git works.** A writable worktree can commit, but its hooks and config can't be changed from
  inside.
- **`awf run --sandbox box.json`** puts every agent of the run in one sandbox instead; a workflow
  that opens its own is then refused.
- A sandbox closes when the run does, after every agent in it.

<a id="decisions"></a>

### wf.decisions.decide {#decide}

Asks a decision model closed questions about a piece of state and returns a probability for every
possible answer, in about 200 ms, with no agent involved. The state is billed once per call, so
ask all your questions together. The guide: [Decisions](/guide/decisions).

<<< @/../examples/site/reference/workflow-api.ts#decide

| Field | |
| --- | --- |
| `key` | Required. Names the call in its record; not unique. |
| `model` | Required. A decision model alias: `jev` is [Jev](https://docs.typesafe.ai/concepts/system-one) through OpenRouter, which needs `OPENROUTER_API_KEY` in the environment or a `.env` where you run `awf`. |
| `state` | Required. What every question is about: a string, a JSON object or an array. |
| `questions` | Required, at least one. Each is answered on its own. |
| `timeout` | As for [`run`](#agent-run); the scope's by default. |

The questions. `instructions`, an option's description and a level are text, or a JSON object of
structured text:

- **`choice(instructions, options)`**: `options` maps each name to a description, or `null`. Its
  answer has `choice`, the most likely (the first on a tie), and `probabilities` by name.
- **`yesNo(instructions, { yes, no }?)`**: its answer's `yes` is the probability of yes.
- **`score(instructions, levels)`**: `levels` lowest first. Its answer has `level`, the most
  likely index (the lowest on a tie), `expected`, the probability-weighted level, and
  `probabilities`, one per level.

`decide` resolves to `{ answers, record }`. A decision that was sent and didn't answer rejects with
`DecisionError` (its `record` attached) or `DeadlineExceededError`; a spec the engine refuses, such
as an unknown alias, rejects with an `Error` before anything is sent. Set your own threshold on the
probabilities: the
[findings](https://github.com/romanlv/agentswf/blob/main/docs/findings/system-one-models.md) show
Jev is reliable at matching text to options, and not at anything that needs reading code.

<a id="messaging"></a>

### wf.messages.allow {#messages-allow}

Grants a route on which one agent may message another, or a participant, while both work. Your
code grants the route and reads typed results; what the agents say is between them. The guide:
[Messaging](/guide/messaging).

<<< @/../examples/site/reference/workflow-api.ts#allow

| Field | |
| --- | --- |
| `from`, `to` | One way: `from` may message `to`, which answers when asked. |
| `between: [a, b]` | Both ways, sharing one count. Give this or `from` and `to`. |
| `purpose` | Required. Shown with every message on the route. |
| `maxMessages` | Lowers the ceiling of 40 messages a route an attempt, replies included. |
| `timeout` | A [duration](#waiting-on-time), only on a route to a participant: a question closes unanswered after this long. Without it, a question waits until answered; an agent's `--timeout` can only shorten it. |

- **Scope:** granted inside a stage, a route closes with the stage; otherwise with the attempt. A
  pair has one open route at a time; granting it again must match, or it rejects.
- **Agents use `wfa`**, which their prompt teaches them: [`wfa peers`](/reference/wfa#peers),
  [`wfa send {peer}`](/reference/wfa#send), `wfa send --await-reply {peer}` to ask, and
  [`wfa reply {peer}`](/reference/wfa#reply). The answer to a question starts
  the asker's next turn.
- **A message arrives between turns**, never into a running one. An idle agent gets a turn of its
  own for it; a busy one gets it with its next turn. An agent that is asked a question can't give
  its result until it replies.
- **`--await-reply`** works on headless claude, codex and pi, and on a claude TUI agent that
  confirms what it is sent. Elsewhere it is refused `unsupported`, a codex TUI agent included, and the agent
  sends without waiting.
- **Recorded:** `wf.usage()` marks each operation a message started, and `awf run`, `awf logs`
  and `awf runs` show the messages.

claude's own messaging between sessions is a different thing, on by default:
[`design/messaging.md`](https://github.com/romanlv/agentswf/blob/main/docs/design/messaging.md#claudes-own-messaging)
says what it reaches.

<a id="a-coordinator-outside-the-run"></a>

### wf.participants.connect {#participants-connect}

Connects a participant outside the run, such as a coordinator, that agents report to and ask. Who
answers for it is chosen when the run starts, not here: `awf run`'s terminal, another claude or
codex session, or an app. [Answering for a participant](/guide/people) is the other side.

<<< @/../examples/site/reference/workflow-api.ts#connect

- **`key`**, required, may not be reserved (`operator`, `awf`, `system`, `user`) or held by any
  agent or participant in the run.
- **`labels`** is any JSON object for whatever answers; awf passes it along in `awf inbox` and
  never reads it.
- **Agents talk to it as to any peer:** `wfa send coordinator` reports, and
  `wfa send --await-reply coordinator` asks; the answer starts the agent's next turn, in the same
  session, hours later if need be. The guide: [People](/guide/people).
- **It stays connected** past the workflow's return while a question to it is open, so the run
  waits for the answer. `coordinator.release(reason?)` ends it sooner, closing its routes and its
  open questions; it resolves `false` when already released.
- **Run in a terminal**, `awf run` asks each question there. Otherwise the answer comes from
  `awf reply`, by a session or an app reading `awf inbox`.

## Stages and time

<a id="stages"></a>

### wf.stage {#stage}

A run is one piece of work, kept in `.awf/runs/{workflow}/{id}`, and each `awf run` of it is an
attempt. A stage is a named step whose result the run keeps, so
`awf run file.ts --id {id} --continue` reuses what succeeded and picks up at the stage that
didn't. The guide: [Runs](/guide/runs#stages), [Durability](/guide/durability).

<<< @/../examples/site/reference/workflow-api.ts#stage

- **A stage's only output is its return value.** With `result`, a schema, it must fit it, when
  recorded and whenever a continue reuses it; without, the stage returns nothing. `summary(value)`
  is its line in the progress view and the record.
- **A reused stage isn't run.** No agent is asked anything, and a variable assigned inside it stays
  unset.
- **Code between stages runs on every attempt**, so keep it safe to repeat. Push, post, compact or
  create inside a stage.
- **One stage at a time, each name once per attempt.** Names are lowercase letters, digits, `.`,
  `_`, `@` and `-`, starting with a letter or digit, at most 128 characters. Parallel work and
  loops go inside a stage. A workflow with events names a stage by its one effect instead, and
  enters it as often as it likes ([stages by content](#events)).
- **`meta.version`** guards reuse: a record from another major version (another minor under
  `0.x`), or one whose value no longer fits its schema, stops the continue at that stage, and
  `--from-stage {stage}` redoes from there.

The full model is in
[`design/runs-and-stages.md`](https://github.com/romanlv/agentswf/blob/main/docs/design/runs-and-stages.md).

### wf.stop {#stop}

`wf.stop(reason)` ends the attempt `stopped` rather than failed. Inside a stage, a continue redoes
that stage; between stages, a continue checks again. Don't catch it: caught, it fails the stage
that caught it. Write `return wf.stop(reason)` where TypeScript should know the code after it
isn't reached. [Stopping with a reason](/guide/workflows#stopping-with-a-reason) says when to use
it; [Runs](/guide/runs) has the exit codes.

### wf.sleep {#sleep}

`wf.sleep(name, when)` waits until `when` and goes on. `when` is a
[duration](#waiting-on-time) from the first call under `name`, or a `Date`. The time is recorded under `name` the first time, so a
rerun waits for what is left of it, and returns at once once it has passed. A sleep in a loop is
named per round. In a workflow with events, it is a race of one timer of its own,
`{name}@sleep`, and the run parks while it waits; without events, it waits in its process. It
throws in a stage or a tool's handler, and sleeps share their names with races.

### wf.now {#now}

`wf.now()` is the run's time. Workflow code reads it, not `Date.now()`, so a test's virtual clock
is the one it reads.

## Events

A workflow with `events` takes events its senders address to a run by id, waits for them, and
parks between them. The guide teaches the model: [Events](/guide/events); running the senders and
`awf tick`: [Hosting events](/guide/hosting-events). This part specifies the calls.

<<< @/../examples/site/reference/workflow-api.ts#events

```sh
awf emit --target case.ts --id checkout-timeouts dd.changes '{"case":"checkout-timeouts"}' --event-id 83d34d7
```

The fields `defineWorkflow` adds:

| Field | |
| --- | --- |
| `events` | Required. Each event's name and the schema of its data. A name with a colon fails `tsc`: `agent:ended`, `participant:reply` and `timer:due` are awf's own. |
| `starts` | The events that may start a run with an id that has none; any other is refused then. Absent, any event starts one; an empty list is refused when the workflow loads. |
| `file` | `import.meta.path`, required with `starts`: where a sender holding the workflow, as `wf.emit` does, finds it, and so which project its runs live in, the nearest directory above it holding `.awf/`. Without it, `awf run` and `awf emit --target` find it by the path they are given, and `wf.emit` to it throws. |

- **Ids.** The sender names the run: `awf emit --id`, or `wf.emit`'s second argument; `wf.runId`
  is the id and the ref is `{workflow}/{id}`. Without `id(args)` or `--id`, `awf run` refuses a
  run of a workflow with `starts`, and makes an id for one without, as for a plain run. Event ids and stage names are lowercase letters, digits, `.`, `_`, `@` and `-`, at most 128
  characters, so a stage named by an event id (`close-{id}`) is always valid. Ids starting `awf.`
  are awf's own.
- **Starting by hand.** `awf run {file} --id {id} -- {args}` makes the run with those args and
  starts it, detached in its project; it runs to its first wait, which returns nothing, and parks.
  It ignores `starts`, and a run already there is only woken.
- **Parking.** A wait with nothing else of the run working (no turn, decision, sandbox or other
  stage) and nothing to take ends the attempt `parked`, and the process exits. Code running beside
  the wait, outside any awf call, is cut off. The next event the wait takes, or `awf tick` once
  its time is due, continues the run from the top.
- **Agents on a wake** reopen on their kept sessions, without their instructions again, and a TUI
  agent's pane opens at its first turn. Before that turn, in an attempt, it can't be forked or
  compacted, and an agent `beside` it gets a tab of its own. An agent with skills or a sandbox,
  whose home is made anew, starts a new session, as one whose harness changed does.
- **Stages by content.** A succeeded stage is reused wherever and however often its name is
  entered, in any attempt and any version of the code, while its value fits. A wait goes outside
  a stage: [`wf.race`](#race) is recorded under its own name.
- **`--from-stage {stage}`** on a continue redoes that stage and every one after it, as in a plain
  run, but a later record moves to `replaced/` as the code reaches its stage, not all at once. The
  stages before it are reused by content. Its own record moves as its new one is written. After it, in this
  attempt and every later one, a stage first entered after it whose record an attempt before the
  redo wrote runs again, its record replaced; one never entered keeps its record. So an attempt
  that parks partway leaves the next wake, which carries no flag, to redo the rest. The mailbox is
  untouched: a race keeps its recorded answer, but an event a `receive` or `select` took and
  acknowledged isn't taken again, so a stage that handled one isn't reached and keeps its record.
  An attempt that would park, or return, before reaching the stage stops instead, `never reached`.
  It takes no `--values`, and a new run takes no `--from-stage`.
- **`return`** ends the run for good: later events for it are refused.
- **Without `events`** a workflow waits as any does, with `receive`, `race`, `select`, `timer` and
  `sleep`, but never parks: it waits in its process. It declares no name, so `wf.signal` takes
  none, and `agent.start`, `keepAlive` and a participant routed to the code throw, saying why.

### wf.receive {#receive}

`wf.receive(options?)` acknowledges what its last call returned, then waits for and returns the
events not yet acknowledged, in arrival order. The first call takes the event that started the
run, if one did. After a crash, the first call returns the unacknowledged batch again, alone. It
throws in a tool's handler.

| Option | |
| --- | --- |
| `label` | What `awf runs` shows while the run waits here or is parked at this wait: a string, or a function asked when the wait begins. |

Each event has:

| Field | |
| --- | --- |
| `id` | Its id: the sender's `eventId`, or one awf made, starting `awf.`. |
| `name` | A declared name, or `agent:ended`, `participant:reply` or `timer:due`. |
| `data` | Typed by its schema; for awf's own, as [`agent.start`](#agent-start), [a participant routed to the code](#participant-to-code) and [`wf.timer`](#timer) say. |
| `from` | An agent's or participant's key, a timer's name, the sending run's ref for `wf.emit`, or `operator` for `awf emit`. |
| `at` | When it was appended, an ISO time; for `timer:due`, when the timer was due. |

### agent.start {#agent-start}

`agent.start(spec)` takes what [`run`](#agent-run) takes, plus `meta`, any JSON, and returns once
the turn is launched, at the run's root scope only. Its end arrives at a wait as `agent:ended`, from
the agent's key, with `turn`, the `outcome`, checked against `schema` as `run`'s is, and `meta`
(`null` when absent). A turn started before a park is started again by the wake's rerun.

### agent.turn {#agent-turn}

`agent.turn` is the started turn until a wait takes its end, restored on a continue for an end no
wait took, and `null` otherwise. Meanwhile the agent refuses `start`, `run`, `compact`, `set`,
`fork` and messages from other agents. `agent.turn.cancel(reason?)` stops it, and resolves once
its `cancelled` end is in the mailbox, or `false` at once when it had ended already; a tool call
it has running is aborted through `call.signal`, and the end waits for the handler, at most 5 s
more. A wait takes its end by naming the agent, `{ done: agent }`: an agent has at most one
started turn.

### is {#is}

`agent.is<Meta, T>(e)` is `true` for that agent's `agent:ended` and narrows its `meta` and outcome.
`participant.is(e)`, on a participant routed to the code,
is `true` for its replies; `timer.is(e)` for its `timer:due`; `wf.signal(name).is(e)` for an event
of that name.

### keepAlive {#keepalive}

An agent opened with `keepAlive` keeps the run live, not parked, for a window after each turn it
runs, awaited, started or a message's. Its pane and the run's process stay, so a message then is a
warm turn in the same pane, and its end opens a new window.

<<< @/../examples/site/reference/workflow-api.ts#keepalive

- **`window`**, a [duration](#waiting-on-time) such as `"90s"`, is how long the run stays live
  after the agent's last turn, an hour by default: the life of claude's prompt cache on a
  subscription.
- **`onTimeout(agent)`** is called once the window passes, if a turn ended since it last ran, at
  a wait with nothing to take and nothing working, which awaits it in its own scope. A turn it
  runs opens no window, though a message it has a peer send is that peer's turn, and an answer the
  peer sends back after the handler's turn has ended opens this agent's window again. A throw is
  logged, and the run parks anyway.
- **The run parks** once no window is open and no handler is due. A turn that fails or times out
  closes the agent, and a closed agent holds no window. Every agent's pane stays with the run: none
  is released alone.
- **In a workflow without events**, whose runs never park, `open` refuses it. On a reopen it takes
  the new spec; left out, the agent keeps what it has.

The run's terminal shows "live until {time}" on the row of each idle agent whose window is open;
`awf runs` shows the run live and waiting.

### A participant routed to the code {#participant-to-code}

`wf.participants.connect({ key, labels?, to: "code" })` turns each message to the participant into
`participant:reply` from its key, with `text` and `author?`, taken at a wait rather than by an
agent. `awf send {ref} --as {key} --event-id {message id} {text}` delivers one, and continues a
parked run. `participant.post(text)` writes to it without a turn: an item in `awf inbox`. A parked
run keeps it connected.

### Waiting on time {#waiting-on-time}

A **duration**, the type `Duration`, is a decimal and `s`, `m`, `h` or `d`: `"90s"`, `"10m"`,
`"1.5h"`, `"14d"`. Every call that takes a length of time takes one, a `timeout` as a timer. A unit
typo fails `tsc`, and a number that isn't plain throws; a bound also refuses one of no length,
`"0s"`, which a timer takes as now. A string read from data is
checked with `duration(text)`, which returns it as a `Duration` and throws, saying the grammar,
for anything else: `const every = duration(event.data.every)`. A timer is a time recorded once under a
name; due, it fires into the mailbox as `timer:due`, from
its name, at its due time. A **source** is something a wait can take: a timer, a declared event
(`wf.signal(name)`), a participant routed to the code, or an agent (the end of the turn it
started). Three waits take sources, beside `receive`:

<<< @/../examples/site/reference/workflow-api.ts#race

<<< @/../examples/site/reference/workflow-api.ts#sleep

<<< @/../examples/site/reference/workflow-api.ts#select

What a branch hands back: a reply as its `text` and `author`, a turn's end as its `outcome` and
`meta`, a timer's as its `name`, each with the event's `id` and `at`; a signal, the event.

### wf.race {#race}

`wf.race(name, branches, options?)` waits for the first of its branches and answers
`{ key, [key]: … }`: `if (next.reply)` and `switch (next.key)` both narrow.

| Argument | |
| --- | --- |
| `name` | Required. Where the answer is recorded. Shared with sleeps; a race's own timers are `{name}@{branch}`. |
| `branches` | Required, at least one, none named `key`. Each is a [source](#waiting-on-time) or a duration. |
| `options.label` | What `awf runs` shows while the run waits here: a string, or a function asked when the wait begins. |

- **It takes only what it names:** the rest stays in the mailbox for a later wait, and doesn't wake
  a run parked at the race.
- **Recorded under `name`**, so a rerun gets the same answer back and walks on: a race in a loop is
  named per round, and a name answers once an attempt. Races and sleeps share their names.
- **Of two ready, the earlier `at` wins**; of two branches taking one event, the first declared.
- **A branch given a duration** is a timer of the race's own, `{name}@{branch}`, cancelled when
  another branch wins; a `wf.timer()` passed in is the code's to cancel. A branch takes a duration,
  not a `Date`, and not [`wf.at`](#at): a fixed time is `wf.timer(name, date)`.
- It throws in a stage or a tool's handler.

### wf.select {#select}

`wf.select(branches, options?)` is an async iterable: it yields each event its branches take,
one at a time, as `{ key, [key]: … }`, until the loop returns or breaks.

| Argument | |
| --- | --- |
| `branches` | Required, at least one, none named `key`. Each is a [source](#waiting-on-time) or a [`wf.at`](#at). |
| `options.label` | A string, or a function asked at each wait: what `awf runs` shows. |
 An event is acknowledged
when the loop asks for the next; after a crash, the one taken and not acknowledged comes back once.
What no branch names stays in the mailbox. A branch is a source, not a duration: a timer in a loop is `wf.timer()`'s. It throws in a stage or a tool's
handler.

### wf.timer {#timer}

`wf.timer(name, when)` returns its source at once.

| Argument | |
| --- | --- |
| `name` | Required. Where the time is recorded; no `@`, which a race's own timers use. |
| `when` | Required. A duration from the first call under the name, or a `Date`. |

The timer has `name`, `due` (an ISO time), `cancel()` and `is(e)`; its branch hands back `name`,
`id` and `at`.

- **The first call names the time:** a later one, in this attempt or any other, gets the recorded
  timer, and one asking another time is logged and ignored. So a timer per round is named per
  round, and a fixed time is a duration or a `Date` from the run's files: one built from `now()`
  differs on every rerun.
- **`timer.cancel()`** stops it, and a `timer:due` of it not yet taken is withdrawn; the name stays
  cancelled.
- In a `receive` loop, `timer.is(e)` tells its event, or `e.name === "timer:due"` with `e.from`,
  its name, for one an earlier attempt made.

### wf.signal {#signal}

`wf.signal(name)` is one of the workflow's declared events, as a source; its branch hands back the
event, typed by its schema. A name `events` doesn't declare fails `tsc`, and throws.

### wf.at {#at}

`wf.at(read)` is a select's branch due at a time the run's state holds: `read` returns a `Date`,
or `null` for none, and is called at each wait, so the branch follows the state as the code moves
the time. It answers `{ at }`, the time it came for.

<<< @/../examples/site/reference/workflow-api.ts#at

- **It isn't a timer:** nothing is recorded under a name, there is nothing to cancel, and it lives
  as long as its loop. Events ready at the wait, timers' among them, come before it.
- **A time returned once isn't returned again** by a branch of that name, so a handler that leaves
  the state alone doesn't fire on every pass. After a crash, a time returned and not acknowledged
  comes back once, if the state still says it.
- **`read` is cheap and synchronous**, and reads state that outlives the process (files, or what
  is rebuilt from them): a parked run wakes in a new one and reads it again. `wf.now()` and
  `wf.after()` throw inside it, as does returning anything but a valid `Date` or `null`.
- A race refuses it.

### wf.after {#after}

`wf.after(duration)` is `now()` plus a [duration](#waiting-on-time): a time for the state to keep,
where it is set, as `wf.at` reads it.

### wf.started {#started}

`wf.started` is the event that started the run, typed by `events`; absent for a run started by
hand.

### wf.emit {#emit}

`wf.emit(target, run, name, data, { eventId? })` sends an event to the run `run` of the workflow
`target`, imported from its file, so a wrong name or shape fails `tsc`; `awf emit --target {file}`
checks the same at run time ([Sending events with `awf emit`](/guide/hosting-events#sending-events-with-awf-emit)). Either returns `accepted`; `duplicate`, the id is in the run's mailbox
already; or `refused`, the run returned, or it has none and `starts` doesn't list the event. A name
`target` doesn't declare, or data its schema refuses, throws. An id
names one occurrence for good; without one, nothing deduplicates the event. A sender is refused
when `prepare` refuses no argv. Any workflow can emit; the target is one with events, and a
target without `file` throws: `wf.emit` finds a workflow by it.

A parked run's `until` in `awf runs` is the earliest timer, or time read from state, its wait
takes, and `awf tick` continues it once that is due: [`awf tick` on a schedule](/guide/hosting-events#awf-tick-on-a-schedule).

## The run

<a id="logging-and-usage"></a>

### wf.log {#log}

<<< @/../examples/site/reference/workflow-api.ts#log

`fields` is a JSON object.

### wf.usage {#usage}

`wf.usage()` returns this scope's finished operations and its descendants', in the order they were
dispatched: each one's agent, settings, times, sessions, stage and label, and for one a message
started, `cause`. Costs are priced after the run, from each agent's tokens: each stage's line gains
what its agents cost, and one summary closes the run. `output.json` keeps the tokens, each stage's
share and the price table used.

<a id="plan-allowance"></a>

### wf.allowance {#allowance}

`wf.allowance(harness)` reads what is left of a harness's plan now, as `awf allowance` does, with
no model turn, on the login the run's agents get. It returns one harness of
`awf allowance --json`'s report: `read: "plan"` with each window's `usedPercent`, its `resetsAt`
and, for a window that limits only some models, which; or `read: "none"` with a `reason`, which
means unknown, not room to spare. A harness awf doesn't know throws. The read isn't recorded: a
continue reads again, and a stage keeps one.

```ts
// examples/event-sketches/dd-tick.ts
// A window of some models' only, as `week (Fable)`, doesn't limit the triage's sonnet.
const plan = await wf.allowance("claude");
if (plan.read === "plan" && plan.windows.some((w) => !w.models && w.usedPercent >= 80))
  return { changed: 0, skipped: "claude's plan is over 80% used" };
```

### wf.runId, wf.attempt, wf.cwd, wf.deadline {#run-context}

- **`wf.runId`** is the run's id, the same in every attempt.
- **`wf.attempt`** is which `awf run` of the run this is: 1, then one more for each continue.
- **`wf.cwd`** is the working directory, which `awf run --cwd` sets.
- **`wf.deadline`** is the run's deadline, a `Date`, absent unless `awf run --timeout` sets one.
  Read it with `wf.deadline.getTime()`.

## Types

What `agentswf/workflow` exports for a workflow's own signatures, beside the calls above.

| Name | |
| --- | --- |
| `WorkflowContext<Events>` | `wf`, typed by the workflow's `events`. Bare, `WorkflowContext` is any workflow's, for a helper that takes whichever it is passed. |
| `AgentRef` | An agent the run opened or forked: a `CallerRef`, and `compact` and `set`. |
| `CallerRef` | What [`caller`](#agents-caller) returns, and what every agent is: `key`, `execution`, `run`, `fork` (taking no `tools`), `start`, `turn`, `is` and `close`; a source, and a peer for [`allow`](#messages-allow). A helper for any agent, the calling session included, takes one. |
| `EventSchemas` | What `events` is: each name's schema. |
| `TurnOutcome<T>` | An [outcome](#outcomes), `T` the answer's type. |
| `OutputSchema<T>` | A JSON Schema carrying the type `T` of what it accepts: annotate a TypeBox schema with it, `const X: OutputSchema<Type.Static<typeof x>> = x`, and `run`, `stage` and `events` take its type. |
| `JsonValue`, `JsonObject` | What args, results, stage values, `meta` and tool results are. |
| `Workflow<Args, Result, Events>` | What `defineWorkflow` returns. |
| `DeadlineExceededError`, `DecisionError` | Errors, with `code` `"deadline-exceeded"` and `"decision-failed"`. |
| `Duration`, `Timeout` | A [duration](#waiting-on-time); and a call's [bound](#deadlines), `Duration \| Date \| false`. |
| `WaitOptions` | The options of `receive`, `race` and `select`: `label?`, a string or a function. |
| `TOOL_LIMITS` | The tool limits: `name` (a pattern), `tools` 16, `descriptionBytes` 1024, `schemaBytes` 8192, `defaultTimeoutMs` 30000, `inputBytes` and `resultBytes` 65536. |

## Deprecated

These still compile and work until 0.1.0. Each attempt that uses one logs it once, as a warning
naming what replaces it. An old bound given with its replacement, `timeoutMs` or `deadline` with
`timeout`, or `keepAlive`'s `timeoutMs` with `window`, is refused rather than merged.

| Old form | Instead |
| --- | --- |
| `labels` on `open`, `fork` and `forkCaller` | Drop it: nothing reads an agent's labels. A participant's `labels` stay. |
| `meta.whenToUse` | Drop it: nothing reads it. |
| `id` on `run`, `start`, `compact` and `set` | Drop it: a later attempt doesn't know it, and a [stage](#stage) keeps a call from running twice. |
| A started turn as a wait's branch, `{ done: turn }` | Name the agent, `{ done: agent }`, and cancel with `agent.turn?.cancel()`. |
| `turn.is(e)` | `agent.is(e)`. |
| `wf.stage(name, () => wf.receive())` | [`wf.race(name, …)`](#race), which is recorded under its name, outside a stage. |
| `isAnswered(outcome)` | `outcome.answered`, which narrows the same way. |
| `defineExecutableWorkflow({ definition: { meta, run }, prepare })` | `defineWorkflow({ meta, run, prepare })`. |
| An agent's or participant's key with a colon, `review:security` | `-` in its place, `review-security`: a colon is kept for awf's own event names. The warning names each such key, and the key to use. |
| `wf.agents.stop(key, reason?)` | [`agent.close(reason?)`](#agent-close) on the agent's ref. |
| `placement`, `metered` and `effort` beside a fork's or `forkCaller`'s `key` | The same in its `runtime`: `fork({ key, runtime: { placement: "headless", metered: true } })`. Given beside `runtime`, they are refused. |
| `timeoutMs` on `open`, `run`, `start`, `compact`, `set`, a [tool](#tool) or a [route](#messages-allow) | `timeout`, a [duration](#waiting-on-time): `timeout: "10m"`. |
| `deadline: { unixMilliseconds }` on `open`, `run`, `start`, `compact`, `set`, `parallel` or `decide` | `timeout`, a `Date`: `timeout: new Date(ms)`. |
| `nudge: { deadline }` | Drop it: the turn's `timeout` bounds its nudges too. |
| `keepAlive: { timeoutMs }` | `keepAlive: { window }`, a duration such as `"90s"`. |
| `wf.deadline.unixMilliseconds` | `wf.deadline.getTime()`. `wf.deadline` is now a `Date`, the one change here to a value rather than a field: its `unixMilliseconds` still reads the same time, and logs once. |
| `EventWorkflowContext<Events>`, `EventAgentRef`, `EventAgentOpenSpec`, `EventAgentDirectory` | `WorkflowContext<Events>`, `AgentRef`, `AgentOpenSpec`, `AgentDirectory`: every workflow has one of each. Types log nothing. |

A test's old forms, such as `reply.silent()` and `run.stopped`, are on
[the testing API page](/reference/testing-api#deprecated).

What's next is in [`docs/status.md`](https://github.com/romanlv/agentswf/blob/main/docs/status.md).
