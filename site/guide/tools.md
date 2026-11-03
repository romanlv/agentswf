---
title: Tools
description: Giving an agent your own code to call mid-turn, with a typed input, and what happens when a call is wrong, fails or runs long.
---

# Tools

A tool is a function in your workflow that an agent calls while it works, and reads what it
returns. Use one when the agent should hand you something as it goes rather than all at the end,
when it needs data only the workflow holds, or when a change should go through your code, such as
closing a ticket with a token the agent never sees.

## A small example

<<< @/../examples/site/guide/tools.ts#open

The reviewer gets two tools. Each finding it records lands in `findings` the moment it calls
`add_finding`, so the workflow keeps every one of them even if the turn ends `timed-out`. The turn
itself needs no schema: the findings came in through the tool.

## What the agent runs

Every turn's prompt teaches the agent its tools, after how to answer. For the workflow above the
block reads:

```text
You have tools the workflow runs for you. Call one with:

/…/wfa tool <name> --<option> '<value>' ...

Put every value in single quotes; a ' inside a value is written '\''.

- add_finding: Record one finding as soon as you are sure of it.
  /…/wfa tool add_finding --file <text, at least 1 character> --line <integer, at least 1> --problem <text, at least 1 character>
- list_findings: The findings recorded so far, one per line.
  /…/wfa tool list_findings
```

The agent runs `wfa` in its shell, the same launcher it answers with (see
[How it works](/guide/how-it-works#the-wfa-commands)):

```sh
/…/wfa tool add_finding --file 'src/report.ts' --line '41' --problem 'formatDate is never called'
```

A small input is taught as flags, as here, by the same rule as a turn's
[typed answer](/guide/agents#catches). Any other input, a list or a nested object, is taught as its
JSON Schema, and the agent sends JSON on standard input:

```sh
/…/wfa tool label_item <<'WF_JSON'
{"id": "b2", "labels": ["ops", "cron"]}
WF_JSON
```

A tool without `input` is called by its name alone.

What the handler returns is what the agent reads on standard output: a string as it is, any other
JSON value as JSON, nothing as nothing. `wfa tool` exits 0 with the result, and nonzero with
what went wrong on standard error; [`wfa tool`](/reference/wfa#tool) lists its exit and refusal
codes.

## Defining one

- **`tool()` types the handler from `input`.** `input` is an object schema. A TypeBox schema
  carries no TypeScript type on its own, so give it as the type argument, `tool<Finding>(...)`, as
  `run<T>` takes a turn's answer type. Without `input`, the handler is given `{}`.
- **`description` is what the agent reads** to decide when to call it. Say what it is for and when
  to use it.
- **The handler is given the checked input and the call**: `call.id`, unique in the run;
  `call.agent`, the key of the agent that called, a fork's own; and `call.signal`, aborted when the
  call's time is up or its turn ends.
- **It runs in your workflow's process**, with your workflow's authority, and can do anything your
  code can: write a file, call an API, run another agent.
- **Each call, its input, and its result or error** go in the run's record, and `awf logs` shows
  them.

## Errors

- **Input that doesn't fit the schema is refused before the handler runs.** The agent is told
  what was wrong and calls again; it never reaches your code.
- **A throw fails the call, not the run.** The agent gets the error's message, so write one that
  says what to do next, as `"src/a.ts:3 is already recorded"` does.
- **A result that isn't JSON** (a `Date`, a class instance) fails the call. `tool()` rejects such a
  handler at compile time.
- **A call outside a turn, or after its answer is accepted, is refused**: a tool is callable only
  while the agent works on a turn.
- **A result over 64 KiB as JSON fails the call.** Return a summary or a path, not a whole file.

## Time

The agent waits while the handler runs, so keep it short.

- **A handler has 30 seconds** by default. `timeout` sets each call's budget, `"2m"`; `timeout: false`
  leaves only the turn's deadline. The turn's deadline always bounds it.
- **When the time is up, or the turn ends, `call.signal` aborts.** A handler that ignores it gets
  5 more seconds, then its call ends without it, and the agent is told it may have run.
- **An agent makes one call at a time.** A second call while one runs is refused, and the agent
  calls again once the first answers.
- **While a call runs, the agent can't answer its turn.** Its `wfa result` and `wfa waiting`
  are refused until the call has answered.
- **The harness may stop waiting first.** Each harness moves a long shell command to the
  background or hands it back after its own limit, codex's the shortest at 10 seconds;
  [`wfa tool`](/reference/wfa#tool) has each one's. An agent that then calls again with the same
  input while the call runs is given its answer; a call made after it ended runs the handler
  again. So make a handler that can take longer than 10 seconds safe to run twice.

## What a handler can't do

- **Give work to the agent that called it.** That agent is in a turn, waiting for the handler, so
  `run`, `compact`, `set`, `fork` and `close` on it throw. Another agent can be run.
- **Wait for an event.** `wf.receive()`, `wf.race` and `wf.select` throw in a handler.

## Limits

An agent holds at most 16 tools, each named in lowercase letters, digits and `_`. These and the
other limits on a tool are checked when the agent opens, so a mistake fails there and not
mid-turn; [`wfa tool`](/reference/wfa#tool) lists them all.

## Forks, reopening and messages

- **A fork has its parent's tools** unless its spec gives its own; `tools: {}` gives none.
- **Opening the same key again** with tools must give the same names, descriptions and schemas;
  the new handlers replace the old. Left out, the agent keeps what it has.
- **An agent can call its tools when a [message](/guide/messaging) wakes it**, not only in a turn you gave it.

## Testing a tool

In [`awf test`](/guide/testing), a scripted turn calls a tool with `turn.tool(name, input)`, through the same checks
and handler a real call goes through, and gets back the result, the failure or the refusal:

<<< @/../examples/site/guide/tools.test.ts{ts}

[`turn.tool`](/reference/testing-api) has the details.

## See also

- [Tools in the workflow API](/reference/workflow-api#tools-the-agent-calls-your-code)
- [`examples/tools`](https://github.com/romanlv/agentswf/tree/main/examples/tools): an agent
  triages a backlog through three tools, one taught as JSON, with its tests
- [Agents](/guide/agents): opening an agent and giving it turns
