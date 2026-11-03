---
title: wfa
description: "The agent's command: every wfa command an agent runs in its session, its flags, exit codes, refusal codes and limits."
outline: [2, 3]
---

# wfa

`wfa` is the agent's command. An agent runs it in its own session, from its shell, to hand back
its answer, call your tools and message its peers. You never type it, and your workflow never
mentions it: every turn's prompt teaches the agent the commands that turn can use. Read this page
to know what an agent can do in a run, and what it is told when something is refused.
[How it works](/guide/how-it-works#the-wfa-commands) shows where `wfa` fits.

The agent runs `wfa` by a full path, the launcher awf installs for that agent when it opens. The
launcher holds the agent's connection to the run, so the connection, not anything the agent types,
says which agent is calling. Run without the launcher, `wfa` exits 2. Prompts show the path, and
this page shortens it to `wfa`.

```text
usage: wfa result <call-id> --<name> '<value>' ...
       wfa result <call-id> <<'WF_JSON'
       <json>
       WF_JSON
       wfa tool <name> --<option> '<value>' ...
       wfa tool <name> <<'WF_JSON'
       <json>
       WF_JSON
       wfa waiting <call-id> --reason <text> [--timeout <duration>]
       wfa peers [--json]
       wfa send [--await-reply [--timeout <duration>]] <peer> <<'EOF'
       <message>
       EOF
       wfa reply [--await-reply [--timeout <duration>]] <peer> <<'EOF'
       <answer>
       EOF
```

## Common to every command {#common}

- **Exit 2 is a usage error**: an unknown command, a missing call id, peer or tool name, standard
  input over 1 MiB or not closed within 30 seconds, or, for `waiting`, `peers`, `send` and
  `reply`, a flag the command doesn't take. Nothing reached the run. The usage is printed to
  standard error. `result` and `tool` pass their flags to the run, which reads them by the schema:
  an unknown flag is refused `invalid-result` or `invalid-input`.
- **A duration** is a positive whole number with `ms`, `s`, `m` or `h`: `90s`, `10m`.
- **`wfa` never sends a request twice.** When the answer to a request is lost, it says so, and
  says whether the request may have taken effect.
- **While the agent owes a peer a reply or awaits one**, an answer leads with a line saying so,
  such as `wfa: you owe reviewer a reply (wfa reply reviewer).`, so the agent gets it back after
  its harness compacts the conversation. `wfa tool` puts that line on standard error, keeping
  standard output for the result; `wfa peers` says it in its table instead.
- **Every command but `wfa tool` waits up to 30 seconds** for the run's answer.

Any command can also be refused with one of these codes:

| Code | Meaning |
| --- | --- |
| `invalid-request` | The request was malformed: not one line of JSON, or a field of the wrong shape. |
| `unsupported-version` | The launcher and the engine disagree on the protocol version. |
| `unsupported-command` | The command isn't available here, such as `wfa waiting` on a turn that doesn't offer it. |
| `request-too-large` | The request is over the run's size limit, about 2 MiB. |
| `internal-error` | The run couldn't record or answer the request, or had 64 connections open; try again later. |

## wfa result {#result}

Hands back the turn's answer. Every turn that asks for an answer uses it; the prompt names the
call id and teaches the fields. [Agents](/guide/agents#a-typed-answer) covers typed answers and
when the fields are taught as flags.

```sh
wfa result <call-id> --verdict 'approve' --notes 'Tests pass.'
wfa result <call-id> <<'WF_JSON'
{"verdict": "approve", "notes": "Tests pass."}
WF_JSON
wfa result <call-id>
```

- **As flags**, when the answer's schema is an object of 1 to 6 fields, each a string, number,
  integer, boolean or enum, with a lowercase name. `--name 'value'` and `--name=value` both work;
  a number or boolean is converted by its type. A flag the schema doesn't name, a flag given twice,
  or a value outside the taught range is refused with the usage line.
- **As JSON on standard input**, in a quoted heredoc, for any schema.
- **With nothing**, for a turn that asks for no fields.

Standard input is read only when nothing follows the call id.

| Exit | Meaning |
| --- | --- |
| 0 | Accepted. The turn ends `answered`. |
| 1 | Refused, with a code and what to do next; or the request failed on the way. |
| 2 | A usage error. |

| Refusal | Meaning |
| --- | --- |
| `invalid-result` | The answer didn't fit the schema. The turn stays open; the agent fixes it and runs `wfa result` again. |
| `unknown-operation` | No open call has that id. Usually a mistyped id; the agent checks it and tries again. |
| `wrong-agent` | The call id is another agent's. |
| `expired-operation` | The turn's deadline passed. |
| `closed-operation` | The turn already ended. |
| `owes-reply` | A peer asked this agent a question; it replies first, then runs `wfa result` again. |
| `no-result` | The call id is a turn a message started, which takes no result: the agent replies if asked and ends its turn. |
| `tool-running` | One of the agent's tool calls is still running; it runs `wfa result` again once the call answers. |

A turn that awaits a peer's reply can still finish with `wfa result`; the wait is dropped.

## wfa waiting {#waiting}

Says the agent is still on long work, such as a build, when it is nudged for its answer. It holds
off the next nudge. It is offered only where the harness confirms what it was sent, a claude TUI agent
today, and not a sandboxed one without a run-local home; elsewhere it is refused
`unsupported-command`. [In a claude TUI](/guide/timeouts#in-a-claude-tui) explains the nudge it answers.

```sh
wfa waiting <call-id> --reason 'Running the full test suite' --timeout 10m
```

| Flag | |
| --- | --- |
| `--reason <text>` | Required. Not blank, at most 2,048 bytes. |
| `--timeout <duration>` | How long to hold off. Default 2 minutes, at least 30 seconds, and never past the turn's deadline. |

A wait never moves the turn's deadline. The acknowledgement prints when the wait ends and the
turn's deadline, if it has one, in Unix milliseconds.

While the agent awaits a peer's reply, `wfa waiting` changes nothing: it exits 0 and says the
reply is already awaited, and a `--timeout` given with it is ignored.

Exits 0 when granted, 1 when refused or when the answer was lost (the wait may have been granted;
nothing was retried), 2 on a usage error. It is refused with the same codes as
[`wfa result`](#result), except `invalid-result`.

## wfa tool {#tool}

Calls one of the [tools](/guide/tools) your workflow gave the agent, and prints what the handler
returned. The prompt teaches each tool's name, description and input.

```sh
wfa tool add_finding --file 'src/report.ts' --line '41' --problem 'formatDate is never called'
wfa tool label_item <<'WF_JSON'
{"id": "b2", "labels": ["ops", "cron"]}
WF_JSON
wfa tool list_findings
```

The input is given as [`wfa result`](#result)'s is: as flags for an input of up to 6 simple
fields, as JSON on standard input for any other, or nothing for a tool without `input`.

The handler's result is the only thing on standard output: a string as it is, any other JSON value
as JSON, nothing as nothing. Everything else goes to standard error.

| Exit | Meaning |
| --- | --- |
| 0 | The handler returned; its result is on standard output. |
| 1 | The call failed: the handler threw, or returned what isn't JSON or is over 64 KiB. The message is on standard error. |
| 2 | A usage error. |
| 3 | Refused, or never reached the workflow: the handler didn't run. |
| 4 | The call timed out or was cancelled, or its answer was lost: it may have run, so check before calling again. |

| Refusal (exit 3) | Meaning |
| --- | --- |
| `no-operation` | The agent isn't in a turn; a tool can be called only while it works on one. |
| `result-accepted` | The turn's answer is accepted, so the turn is ending. |
| `tool-busy` | Another call of this agent's is running; it calls again once that one answers. |
| `unknown-tool` | No tool by that name; the refusal lists the agent's tools. |
| `invalid-input` | The input didn't fit the schema. The refusal says what was wrong. |

`internal-error` exits 4, since the call may have run. The other common refusals exit 3.

### Time {#tool-time}

`wfa tool` waits as long as the call takes. A handler has 30 seconds by default, or its own
`timeout`, always within the turn's deadline; `timeout: false` leaves only the turn's
deadline. When that passes, the handler's signal aborts; a
handler that ignores it gets 5 more seconds, then the call ends `timed-out` and exits 4.

The harness may stop waiting on the shell command first. These are the harnesses' own limits,
not awf's:

| Harness | A long shell command |
| --- | --- |
| claude | moved to the background after 2 minutes |
| cursor | moved to the background after 30 seconds |
| codex | handed back to the agent to poll after 10 seconds |
| pi | no limit unless the model sets one |

An agent that then calls again with the same tool and input while the first call runs is given
that call's answer, once. A call made after it ended runs the handler again.

### Limits {#tool-limits}

| | Limit |
| --- | --- |
| Tools per agent | 16 |
| A tool's name | lowercase letters, digits and `_`, starting with a letter, at most 48 characters |
| A tool's description | not empty, at most 1,024 bytes |
| A tool's input schema | an object, at most 8,192 bytes |
| One call's input, and its result as JSON | at most 64 KiB each |
| Calls at once | one per agent |
| A handler's time | 30 seconds by default, then 5 seconds to settle after its signal aborts |

The first four are checked when the agent opens.

## wfa peers {#peers}

Lists the agent's [message](/guide/messaging) routes.

```sh
wfa peers
wfa peers --json
```

One row per route: the peer, what the agent can do on it, the peer's state, how many of this
agent's messages the peer hasn't read yet, and the route's purpose. It ends with any reply the
agent owes. `--json` prints the same as data:

```json
{
  "peers": [
    { "peer": "architect", "can": "send", "state": "idle", "queued": 0, "purpose": "Design questions about the retry change" }
  ],
  "owes": []
}
```

| Field | Values |
| --- | --- |
| `can` | `send` on a route from this agent, `reply` on one only to it, `both` either way |
| `state` | `not-started`, `working`, `idle`, `awaiting` (with `awaits`, whose reply), `stopped` (with `reason`), or `outside`, a [participant outside the run](/guide/people) |
| `queued` | this agent's messages the peer hasn't read; always 0 for `outside` |
| `owes` | the peers this agent owes a reply |
| `awaits` | the peer whose reply this agent awaits, and `until`, when the wait ends, if it does |

`wfa peers` takes no other flag. It exits 0, 1 when refused or failed, and 2 on a usage error.

## wfa send {#send}

Sends a peer a message, or with `--await-reply` asks it a question.
[Messaging](/guide/messaging) covers routes and when a message arrives.

```sh
wfa send architect <<'EOF'
Retries are in; the client's timeout is now per attempt.
EOF
wfa send --await-reply --timeout 10m architect <<'EOF'
Should retries live in the client or the queue?
EOF
wfa send architect 'Retries are in.'
```

The message comes from a quoted heredoc, standard input, or one final argument; given an argument,
standard input isn't read. Flags go before the message, before or right after the peer. A message
that starts with `--` goes in a heredoc. A heredoc's final newline is dropped.

| Flag | |
| --- | --- |
| `--await-reply` | Ask a question: the peer owes a reply. |
| `--timeout <duration>` | Only with `--await-reply`. Shortens the wait for the reply; it can't lengthen it. |

`wfa send` returns once the message is recorded. The acknowledgement says when the peer reads it:
when its current turn ends, now in a turn of its own if it is idle or hasn't run, or with the reply
it awaits.

**`--await-reply` doesn't block.** The agent goes on with work that doesn't need the answer, then
ends its turn; the reply starts its next turn. The wait lasts until the turn's deadline, if it has
one, or the `--timeout`, whichever is sooner. An agent that finds the answer itself can finish with
`wfa result`, and the wait is dropped.

**Where `--await-reply` works:**

| Harness | Headless | TUI |
| --- | --- | --- |
| claude | yes | yes, where the pane confirms delivery; not a sandboxed claude TUI agent without a run-local home |
| codex | yes | no |
| pi | yes | no |
| cursor | no | no |

Elsewhere it is refused `unsupported`, and the agent sends without waiting and says where the
answer should go, such as a file.

Exits 0 when sent, 1 when refused or when the answer was lost, 2 on a usage error. A message the
run couldn't confirm may have been queued, and `wfa` says not to send it again; one that never
reached the run says to try again.

| Refusal | Meaning |
| --- | --- |
| `no-operation` | The agent isn't in a turn. |
| `no-route` | No route to that peer, or only one it can reply on. |
| `peer-stopped` | The peer has stopped. |
| `closed` | The route closed when its stage ended, or the stage or workflow is finishing. |
| `too-large` | The message is over 16 KB; the agent writes a file and sends its path. |
| `awaiting` | The agent already awaits a reply. |
| `unsupported` | It can't await a reply where it runs. |
| `cycle` | The peer already waits, directly or through others, on this agent. |
| `limit` | The route has used its messages; or it has room for one more but not a question and its reply. |
| `inbox-full` | The peer has 16 unread messages; try after its turn ends. |

## wfa reply {#reply}

Answers a question a peer asked. Takes the same message forms and flags as
[`wfa send`](#send); with `--await-reply` it asks something back.

```sh
wfa reply implementer <<'EOF'
In the queue: the client is shared with the batch path.
EOF
```

An agent that was asked can't hand back its own answer until it replies: `wfa result` and
`wfa waiting` are refused `owes-reply`. A turn a message started needs no `wfa result`: the agent
replies and ends its turn. If it ends the turn still owing, it is reminded once; if it still
doesn't reply, the asker is told there is no answer.

Exits as `wfa send` does.

| Refusal | Meaning |
| --- | --- |
| `no-operation` | The agent isn't in a turn. |
| `none-owed` | That peer asked nothing open, or was answered already; to message it, `wfa send`. |
| `expired` | The peer stopped waiting, or stopped. |
| `closed` | The route closed, or with `--await-reply`, the stage or workflow is finishing. |
| `too-large` | The reply is over 16 KB. |
| `awaiting`, `unsupported`, `cycle` | As for `wfa send`, only with `--await-reply`. |
| `limit` | With `--await-reply`, the route has room for the reply but not a question back. |

## Message limits {#message-limits}

| | Limit |
| --- | --- |
| A message | 16 KB |
| Messages on a route, replies included | 40; a route's `maxMessages` can only lower it. A question counts its reply too. |
| A peer's unread messages | 16 |
| A route's purpose | one line, at most 200 characters |
| A turn a message starts | 15 minutes of its own, or less where a stage's deadline ends sooner; an asker waiting on its reply can lengthen it |

## See also

- [Tools](/guide/tools) and [Messaging](/guide/messaging), what these commands are for.
- [Agents](/guide/agents), the turn and its answer.
- [Timeouts and nudges](/guide/timeouts#nudges), where `wfa waiting` fits.
- [`awf` commands](/reference/awf), the operator's side.
