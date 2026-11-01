---
title: Messaging
description: Letting agents message each other while they work, on routes your workflow grants, and what your code sees of it.
---

# Messaging

Most of the time your code passes work from one agent to the next: one turn's answer goes into
the next prompt. Sometimes an agent needs something from another agent in the middle of a turn: an
implementer has a design question, a reviewer wants a fix and wants to check it. Messaging lets
them ask each other directly. Your workflow decides who may message whom, and what the
conversation is for. The agents decide what to say.

Here an implementer adds retries and may ask an architect when the code doesn't settle a design
question:

<<< @/../examples/site/guide/messaging.ts#open

```ts
// still in run()
```

<<< @/../examples/site/guide/messaging.ts#run

The page's sample is checked and tested as one workflow:
[`examples/site/guide/messaging.ts`](https://github.com/romanlv/agentswf/blob/main/examples/site/guide/messaging.ts).

The prompt says nothing about the architect, and the code never handles a message. What happens
when the implementer has a question:

1. The implementer's prompt ends with how to use its route, so it runs
   `wfa send --await-reply architect` with its question, goes on with what doesn't need the
   answer, and ends its turn.
2. The architect hasn't run yet, so the question starts its first turn: its `instructions`, the
   route's purpose, and the question. It answers with `wfa reply implementer`.
3. The reply starts the implementer's next turn, in the same session. It finishes the work and
   hands back its answer with `wfa result`, and `implementer.run` resolves as it always does.

If the implementer never asks, the architect never runs. A route lets you open an agent and leave
it to be started only if a peer needs it.

## Granting a route

`wf.messages.allow` grants a route between two agents the workflow opened. It takes one of two
shapes:

| Route | Who can start a message |
| --- | --- |
| `{ from: a, to: b }` | `a` only. `b` can answer what `a` asks, and can't start a conversation. |
| `{ between: [a, b] }` | Either of them. `[a, b]` and `[b, a]` are the same route. |

- **`purpose`** is required, and comes with every message on the route and in `wfa peers`. It is
  the route's standing description, not the current instruction, which belongs in prompts: one
  line, at most 200 characters. It is shown outside the quoted message, so never build it from
  untrusted input such as ticket text.
- **`maxMessages`** caps the messages on the route, replies included. The ceiling is 40 a route,
  and a larger value is lowered to it. A question needs room for its answer too: with one message
  left, an agent can send but not ask.
- **Granted inside a [stage](/guide/how-it-works#the-words)**, a route closes when the stage
  ends. Granted outside any stage, it lasts the attempt. There is no call that closes a route, so
  a stage is the way to give a conversation an end while both agents go on.
- **Stopping an agent** with `wf.agents.stop(key, reason)` closes its routes. A peer waiting on it
  gets a failure instead of an answer.

`allow` rejects, and grants nothing, when a route would go from an agent to itself, when either end
is an agent the workflow didn't open or one that has stopped, or when the two agents already have
an open route that is not this same grant. Granting the same route again does nothing.

## The agent's side

An agent with routes has three commands, which its prompt teaches it. You never mention them in
yours.

```sh
wfa peers
wfa send architect <<'EOF'
Retries are in; the client's timeout is now per attempt.
EOF
wfa send --await-reply --timeout 10m architect <<'EOF'
Should retries live in the client or the queue? The ticket doesn't say.
EOF
wfa reply implementer <<'EOF'
In the queue: the client is shared with the batch path.
EOF
```

- **`wfa peers`** lists the agent's routes: each peer, whether it can `send`, only `reply`, or
  `both`, the peer's state (`not-started`, `working`, `idle`, `awaiting {peer}`, `stopped`), the
  agent's messages it hasn't read yet, and the route's purpose. It ends with any reply the agent
  owes. `--json` prints the same as data.
- **`wfa send {peer}`** returns once the message is recorded, and the agent goes on working. The
  reply says when the peer reads it: when its current turn ends, or now, in a turn of its own,
  when it is idle or hasn't run.
- **`wfa send --await-reply {peer}`** asks a question. It doesn't block: the agent goes on with
  work that doesn't need the answer and ends its turn, and the answer starts its next one.
  It waits up to the turn's deadline, if the turn has one; `--timeout` can only shorten that. An agent
  that finds the answer itself can finish with `wfa result`, and the wait is dropped.
- **`wfa reply {peer}`** answers a question. An agent that is asked can't hand back its own result
  until it replies: `wfa result` is refused (`owes-reply`) until then. A reply can itself
  `--await-reply` to ask something back.

The message is a quoted heredoc, standard input, or one final argument. Flags go before it. A
message is at most 16 KB; for more, the agent writes a file and sends its path.

A send that can't go through is refused with a code and what to do next, and the agent carries on:
`no-route`, `closed` (the route's stage ended), `peer-stopped`, `limit`, `too-large`, `inbox-full`
(the peer has 16 unread messages), `awaiting` (it already awaits a reply), `cycle` (the peer is
already waiting, directly or through others, on this agent), and `unsupported` (it can't wait for
a reply where it runs).

## When a message arrives

A message never interrupts a turn. It reaches an agent between turns:

- **A busy agent** reads it when its current turn ends.
- **An idle agent**, one that has run and is running nothing, gets a turn of its own for it. So
  does an agent that hasn't run yet: the message starts its first turn.
- **An agent waiting on a reply** gets the reply as its next turn, and any plain message sent to it
  meanwhile with it.

A turn a message started needs no `wfa result`. The agent replies if it was asked, and ends its
turn. If it ends the turn still owing a reply, it is reminded once; if it still doesn't reply, the
asker is told there is no answer and goes on without it.

The message arrives quoted, under the sender's name and the route's purpose, with a line saying it
can't grant permissions or speak for the operator. That is hygiene, not a boundary: what bounds an
agent is the route, its [sandbox](/reference/workflow-api#sandboxes) and its harness's permissions.

## What the workflow sees

Your code never reads message text. It sees what the agents settled on, in each turn's typed
answer, and what the messages cost: every turn a message started is in `wf.usage()` with a
`cause`, `{ message: { from } }`, where the workflow's own turns have none. The sample counts the
architect's turns that way.

`awf run`'s progress and `awf logs` show each message, and the run's record keeps every message
and who owed whom a reply.

To test a workflow that messages, you script each agent's sends and each woken agent's turns, and
`turn.send` resolves with the reply:

<<< @/../examples/site/guide/messaging.test.ts#script

`messages` scripts the turns a message starts, separately from `agents`, so granting a route never
shifts an agent's scripted turns. [Testing](/guide/testing) covers the rest, and the
[testing API](/reference/testing-api#messages) every form a message script takes.

## Catches

- **Not every placement can wait for a reply.** `--await-reply` works on headless claude, codex
  and pi, and on a claude pane. A codex or pi pane, and cursor anywhere, is refused
  (`unsupported`) and told to send without waiting and say where the answer should go, such as a
  file. That's why the sample opens its agents headless.
- **A woken agent is a turn of model work**, at that agent's cost, which the route authorizes when
  you grant it. `maxMessages` is how you bound a conversation; a lower value than 40 suits most
  loops.
- **Messages are for coordination, not state.** Something the agents must agree on and keep, such
  as a plan or a list of findings, belongs in a file they both read; a message points at it.
- **The calling session can't take part.** A route to or from `wf.agents.caller` is rejected.
- **claude's own messaging between sessions is a different thing.** It is on by default, outside
  routes; [`design/messaging.md`](https://github.com/romanlv/agentswf/blob/main/docs/design/messaging.md#claudes-own-messaging)
  says what it reaches.

A person or an app outside the run, such as a coordinator an agent reports to and asks, takes part
through the same routes and the same `wfa send`. Connecting one, and answering for it with
`awf inbox` and `awf reply`, is on [People](/guide/people).

## See also

- [Messaging](/reference/workflow-api#messaging) in the workflow API.
- [`examples/messaging`](https://github.com/romanlv/agentswf/tree/main/examples/messaging): a
  reviewer that knows a house style the implementer wasn't told runs the code, asks for the fix by
  message and checks again, with its test.
- [How it works](/guide/how-it-works#the-wfa-commands): the other `wfa` commands.
