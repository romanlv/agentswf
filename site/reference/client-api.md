---
title: Client API
description: "Every call of agentswf/client, what each returns and throws: emit, start, get, inbox, a run's status and wait, and ClientError's codes."
outline: [2, 3]
---

# The client API

`agentswf/client` lets a Bun program reach a workflow's runs in its own process: send events,
start runs with args, wait for them and read what they posted. `tsc` checks each call against the
workflow the program imports. This page lists every call, what it returns and what it throws;
[Programs](/guide/programs) teaches it with a webhook, a relay and a release script, and
[`packages/contract/src/client.ts`](https://github.com/romanlv/agentswf/blob/main/packages/contract/src/client.ts)
has the types, with every field documented.

## At a glance

- **Make a client:** [`client(options?)`](#client).
- **Reach runs:** [`emit(workflow, id, name, data, options?)`](#emit),
  [`start(workflow, args, options?)`](#start), [`get(workflow, id)`](#get),
  [`inbox(workflow, options?)`](#inbox).
- **Follow a run:** [`run.status()`, `run.wait(options?)`](#run).
- **Know what throws:** [`ClientError` and its codes](#clienterror). What a run decided is a
  value, never a throw.
- **Test a program:** [`fakeClient`](/reference/testing-api#fakeclient), from `agentswf/testing`.

## What a workflow needs

The client takes the workflow itself, not its name: its file's default export, giving
`file: import.meta.path`. The client finds the workflow's project from `file`, and runs every call
on the engine that project installs, which must be the client's own version. A program runs where
you would type `awf`: the same user, `HOME` and `PATH` ([Programs](/guide/programs#where-the-program-runs)).

## `client` {#client}

```ts
import { client } from "agentswf/client";

const runs = client();
```

| Option | What it is | Default |
| --- | --- | --- |
| `home` | the operator's home, where `~/.awf` is | the program's `HOME` |
| `environment` | what a launched attempt inherits, as `awf emit`'s environment does | the program's environment |

A client holds no connection and no state; make one and pass it to whatever needs it, so a test
can pass a fake instead.

## `emit` {#emit}

<<< @/../examples/site/reference/client-api.driver.ts#emit

Sends event `name` to run `id`: one of the workflow's own [events](/guide/events), which may start
the run if the workflow lists it in `starts`, or a participant's `{key}:reply` to a run that is
there. `tsc` refuses a name the workflow doesn't declare and data its schema refuses; the client
checks both again at run time.

| Option | What it is | Default |
| --- | --- | --- |
| `eventId` | names the occurrence: a resent id is a `duplicate`. Lowercase letters, digits, `.`, `_`, `@`, `-`, at most 128, not starting `awf.` | a new id |
| `source` | the integration that sent it; the event a wait returns carries it | none |

It resolves once the run has the event: when it starts or continues a run, after the attempt has
started, which can take seconds. The result is `awf emit --json`'s line:

| Field | Values |
| --- | --- |
| `ok` | whether the run has the event and needs no one; [below](#emit-ok) |
| `outcome` | `accepted`, `duplicate`, `refused` |
| `did` | what was done to the run: `started`, `nudged`, `continued`, `none` |
| `why` | with `none` or `refused`: `returned`, `not-a-start`, `stuck`, `stopped`, `cancelled`, `nothing-due`, `nudge-failed`, `launch-failed` |
| `error` | with `launch-failed`: what the attempt said before it exited |
| `ref`, `eventId` | the run, `{workflow}/{id}`, and the event's id |

### When it is `ok` {#emit-ok}

`ok` is false when the event is `refused` (the run has `returned`, or there is no run and the event
doesn't start one), or the run wasn't woken because its launch failed or the operator must step in:

| `why` | `ok` | What it means |
| --- | --- | --- |
| none | yes | started, nudged or continued |
| `nothing-due` | yes | the run is parked at a wait that doesn't take this event; a later wait will |
| `nudge-failed` | yes | the running attempt wasn't nudged, but its wait takes the event |
| `returned` | yes, if `duplicate` | the event was already taken before the run returned |
| `returned`, `not-a-start` | no | `refused`: no run will take it |
| `launch-failed` | no | the event is kept; the next event, a resend or `awf tick` launches again |
| `stuck`, `stopped`, `cancelled` | no | the run needs the operator ([Runs](/guide/runs)) |

## `start` {#start}

<<< @/../examples/site/reference/client-api.driver.ts#start

Makes sure the run with these args exists and has been launched, and resolves once its attempt has
started. `args` is what the workflow's `prepare` would return, checked by `tsc`; `prepare` never
runs, and every attempt of the run gets the args the run recorded.

| Option | What it is | Default |
| --- | --- | --- |
| `id` | the run's id | the workflow's `id(args)`, or else a new id; a workflow with `starts` and no `id(args)` throws `no-id` |

| `ok` | `did` | What it means |
| --- | --- | --- |
| yes | `started` | a new run, launched |
| yes | `exists` | a run with these args was there; launched only if it never had an attempt |
| no | `launch-failed` | the run is kept; `error` says what the attempt said. A later `start` tries again |
| no | `stuck` | its launch failed three times; the operator's turn |

Every result carries `run`, a [`Run`](#run). A run there with other args, or one an event or
`awf run` began, throws `other-args`.

## `get` {#get}

```ts
const run = await runs.get(review, "pr-7");
```

The [`Run`](#run) another call or another program started. No run with that id throws `no-run`.

## `inbox` {#inbox}

```ts
const items = await runs.inbox(review, { after: cursor });
```

What the workflow's runs posted and asked, oldest first, as `awf inbox --workflow --json` lists it.
Each item carries `ref`, `at` and a `cursor`; pass the last item's `cursor` as `after` to read on
from just after it. A cursor made for another workflow throws `cursor`.

| `kind` | What it is |
| --- | --- |
| `post` | `participant.post(text)`: `participant`, `text`, `labels` |
| `message` | a message between an agent and a participant; `asks: true` for a question open until an `answered` or `expired` item |
| `answered` | a question's answer, and what it came through |
| `expired` | a question that closed unanswered |
| `route` | a route between an agent and a participant `opened` or `closed` |
| `ended` | an attempt ended: its `outcome` and, when parked, the wait's `label` |

A person answers a question with [`awf reply`](/guide/people); the client has no reply call. A
reply event the workflow declares, `{key}:reply`, goes through [`emit`](#emit).

## `Run` {#run}

A run's handle, read from its files whenever asked: `id`, `ref` (`{workflow}/{id}`, as `awf runs`
and `awf logs` take it), and two calls.

`status()` resolves to the run as it is now:

| Field | What it is |
| --- | --- |
| `state` | as `awf runs` reads it: `running`, `parked`, `completed`, `stopped`, `failed`, `timed-out`, `cancelled`, `interrupted`, `stuck` |
| `final` | nothing will continue it on its own |
| `ending` | the last attempt's, once one has ended: `completed` with `value`, typed as the workflow's result; `parked` with its wait's `label`; or unfinished with `reason` and the `continue` command |

`final` is true for `completed`, `stopped`, `cancelled` and `stuck`; for a plain run also
`failed`, `timed-out` and `interrupted`. An event run that failed isn't final: its next event or
`awf tick` continues it.

`wait(options?)` resolves at the run's next rest after the call: it ends, parks, crashes or sticks.
It resolves at once if the run isn't running.

| Option | What it is |
| --- | --- |
| `final` | wait for the first rest that is `final` instead of the next |
| `signal` | an `AbortSignal`; the wait rejects with its reason when it aborts |

Bound a `final` wait with a `signal`: a failed event run with no next event and no `awf tick`
never becomes final. A wait also rejects when the run's files can't be read.

## `ClientError` {#clienterror}

<<< @/../examples/site/reference/client-api.driver.ts#errors

A call the program got wrong throws a `ClientError`, with a `code` and, when it was about a run,
its `ref`. Anything the run decided (a refused event, a failed launch) is in the result instead.

| `code` | Thrown when |
| --- | --- |
| `event` | the workflow doesn't take the event's name, or its schema refuses the data |
| `id` | a run or event id the grammar refuses, or one `id(args)` returns |
| `no-id` | `start` of a workflow with `starts`, with no `id` and no `id(args)` |
| `prepare` | a starting event whose `prepare` refuses no argv, an `id(args)` that throws, or args that aren't JSON |
| `file` | the workflow's `file` isn't the file that exports it as its default |
| `project` | the workflow sits directly in your home folder, not in a project |
| `no-engine` | the project has no `agentswf`, or declares one that isn't installed |
| `other-engine` | the project's `agentswf` is another version than the client's ([Install](/guide/install#updating)) |
| `no-run` | `get`, or a `{key}:reply`, of a run that isn't there |
| `other-args` | `start` of a run there with other args, or with none recorded |
| `cursor` | an `after` made for another run, workflow or filter |

An `awf` command run with `--json` uses [the same word](/reference/awf#json) for the same failure.

## See also

- [Programs](/guide/programs): the client in a webhook, a relay and a release script.
- [`examples/programs`](https://github.com/romanlv/agentswf/tree/main/examples/programs): a
  program you can run, with its test.
- [Testing API](/reference/testing-api#fakeclient): `fakeClient`, to test a program without runs.
- [`awf`](/reference/awf): `awf emit`, `awf inbox` and `awf runs`, the same calls from a shell.
