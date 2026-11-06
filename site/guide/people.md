---
title: People
description: "Letting agents report to and ask a person or an app outside the run, and answering them with awf inbox, awf reply and awf send."
---

# People

Some questions only a person can settle: merge these two incidents or keep two, ship the fix
tonight or wait for the review. A workflow can connect a **participant** outside the run, such as a
coordinator, that its agents report to and ask while they work.

Who answers is chosen when the run starts, not in the workflow: `awf run`'s own terminal, another
claude or codex session, or an app such as a Slack bot. Whatever answers is the participant's
**holder**, and it uses three commands: `awf inbox` to read, `awf reply` and `awf send` to talk back.

Here an investigator looks into an outage, reports what holds up to a coordinator, and asks it when
the logs can't settle something:

<<< @/../examples/site/guide/people.ts#connect

The sample is checked and tested:
[`examples/site/guide/people.ts`](https://github.com/romanlv/agentswf/blob/main/examples/site/guide/people.ts)
and its test.

The workflow then calls `investigator.run` once. The participant is a peer like any agent, so the
investigator talks to it as it would to another agent ([Messaging](/guide/messaging)):
`wfa send coordinator` reports, and `wfa send --await-reply coordinator` asks. Asking doesn't
block: the agent finishes what doesn't need the answer and ends its turn, and `investigator.run`
stays pending. When the answer comes, minutes or hours later, awf starts the agent's next turn with
it, in the same session. Once the agent hands back its typed answer, `investigator.run` resolves as
it always does.

## Answering in the terminal

```sh
awf run investigate.ts --id r1
```

The run is `investigate/r1`: the workflow's name and the id you gave, or one awf generates
([Runs](/guide/runs#id-attempts-and-status)). In a terminal, `awf run` asks you each question as it
comes, oldest first:

```text
● investigator asks:
                Same symptom as the 2026-10-14 incident, different service. Merge them or keep two?
reply to investigator › Keep two, and link them.
```

An empty answer leaves the question open for another holder. Under a cron, or with `--json`, nothing
is asked: the question waits in the run's record, and the progress line names the command that
answers it. `1.5` is the message's id, `{attempt}.{n}`: message 5 of attempt 1.

```text
● investigator asks coordinator (1.5):
                Same symptom as the 2026-10-14 incident, different service. Merge them or keep two?
  answer: awf reply investigate/r1 investigator --to 1.5 '…'
```

## Connecting a participant

- **`key`** is the name agents send to. `operator`, `awf`, `system` and `user` are refused, as is a
  key an agent or another participant in the run has.
- **`labels`** is any JSON object for the holder, such as the chat channel to post in. awf never
  reads it; it comes with each route in `awf inbox`.
- **The route** is a [messaging route](/guide/messaging#granting-a-route) with the participant at
  one end. With `{ from: investigator, to: coordinator }` the agent reports and asks, and the holder
  can only answer; `between` lets the holder message the agent first too.
- **`timeout`**, a duration such as `"2h"`, closes a question on the route unanswered after that
  long, on a route to a participant as on one
  [between agents](/reference/workflow-api#messages-allow).
  Without it, a question waits until it is answered.
- **`coordinator.release(reason)`** disconnects it: its routes close, and every question still open
  to it ends. Otherwise it stays connected until the workflow has returned and no question to it is
  open.

## Waiting hours

Waiting for a person isn't work, so it doesn't use up the agent's time: while it waits, its turn's
deadline doesn't count, and once the answer comes the deadline moves out by however long the wait
took. A [deadline](/guide/timeouts) your workflow set around the agent, or on the run, still holds,
and the question closes there.

A question still open when the workflow returns keeps the run open until it is answered; set
the route's `timeout` if the run shouldn't wait that long. While it waits, a headless agent has no process
running, and a TUI agent keeps its pane and process. Either way, awf bounds a turn by a week
when nothing else does, so ask from a headless agent when answers may take days, and treat a
question open longer than a week as a run to stop and start again.

In a workflow that reacts to [events](/guide/events), an agent opened with `keepAlive` keeps the run
live for a window after each turn, an hour by default: a person's `awf send` in that window is a
warm turn in the same pane rather than a cold start after the run parks.
[`examples/keep-alive`](https://github.com/romanlv/agentswf/tree/main/examples/keep-alive) shows one,
and [Events](/reference/workflow-api#events) in the workflow API has the rules.

## Answering from outside

```sh
awf inbox investigate/r1                          # one run: what was said, both ways
awf inbox investigate/r1 --open                   # the questions still waiting for an answer
awf inbox --json --after {cursor} --wait 100s     # every run here, for an app or a session
awf reply investigate/r1 investigator --to 1.5 'Keep two, and link them.'
awf send investigate/r1 investigator 'Also check the 09:12 deploy.'
```

All three read the runs in the current folder's `.awf/runs`, as `awf runs` does, so a holder runs in
the folder where runs start, and an app watching several folders runs one loop per folder. An agent
is named by its key, such as `investigator`. Add `--as {key}` when the workflow connects more than
one participant.

- **`awf inbox`** reads the run's record, so a holder that starts late, or after the run ended,
  still sees everything. Without a run, it reads every run in the folder that connected a
  participant. `--wait` waits when nothing is new; a coding agent's shell tool usually stops a
  command after 120 seconds, so a session passes 100s.
- **`awf reply`** answers a question. `--to` names it, and may be left out when the agent has only
  one open. A `--to` naming anything but an open question from that agent is refused `expired`, so
  a late answer never lands on a newer question. Anyone may answer, and the first answer wins.
- **`awf send`** messages an agent first, if the route allows it. A busy agent gets it with its next
  turn, and an idle one gets a turn of its own for it, a model call.

The text is the last argument, or standard input, so an app passes a chat message through
unchanged. Neither `reply` nor `send` waits for the agent: its answer comes back in `awf inbox`. A
refusal names its code and what to do instead; [`awf reply`](/reference/awf#reply) has the help.

### What `awf inbox --json` prints

One item per line, oldest first, each with `v`, `ref` (the run), `at`, `kind`, and outside `--open`
a `cursor`. When it fails, its last line is a [refusal](/reference/awf#json), `{v, code, error}`,
not an item: on `cursor`, read again without `--after`.

| `kind` | Fields |
| --- | --- |
| `route` | `state` (`opened`, `closed`), `participant`, `agent`, `direction` (`both`, `to-participant`, `from-participant`), `purpose`, `timeoutMs`, `labels`; closed, its `reason` |
| `message` | `participant`, `id`, `from`, `to`, `text`; a question has `asks`, and `until` when it closes unanswered at a limit; one the participant sent with `awf send` has `via` |
| `answered` | `participant`, the question's `id`, the `answer`, and `via`: `terminal`, `command` or `test` |
| `expired` | `participant`, the question's `id`, and `reason`: `timeout`, `released`, `cancelled` or `attempt-ended` |
| `post` | `participant`, `id` (`{attempt}.p{n}`), `text`, `labels`: the run's code wrote to the participant, `participant.post(text)` |
| `ended` | an attempt ended: `attempt` and `outcome`, or `interrupted` when its process died; a `parked` one has `label`, its last wait's, when it gave one |

A reader ignores kinds and fields it doesn't know. **The cursor** reads on from just after its item,
across every run here, new and continued ones included: save it after handling a batch, and a holder
that crashed or slept loses nothing. An item may come twice, never zero times, so handle each one
idempotently; a `post` that a crashed attempt made may come again under a new id.

<a id="a-participant-routed-to-the-code"></a>

### A participant's messages to the code {#to-the-code}

A workflow that declares `"{key}:reply": ParticipantReply` in its `events` takes that
participant's messages in its code instead of an agent, each a `{key}:reply` event it takes at a
wait, and the code writes back with `participant.post(text)`. It needs a workflow that reacts to
[events](/guide/events).
[`examples/approval-reminders`](https://github.com/romanlv/agentswf/tree/main/examples/approval-reminders)
waits days for an approval this way.

```sh
awf emit approval/doc-42 approvals:reply '{"text":"approved","author":"dana"}' --event-id 1730450000.123456
```

`--event-id` is the message's own id, so a resend is a duplicate, and `author` names who wrote it.
It reaches the run whether it is running or parked. A participant the workflow doesn't declare is
refused, with the names it does.

## Connecting a chat app

A chat app such as a Slack bot is its own program, built on these three commands; awf has no chat
code of its own. A sketch of one, run in each folder where runs start:

1. **Read.** Loop on `awf inbox --json --after {cursor} --wait 5m`, the first time with no cursor.
2. **A route opens.** Start a thread for it in the channel the participant's `labels` name, and
   remember which thread is which run, participant and agent.
3. **A message.** Post it in its thread. A question (`asks`) shows its `id` and, with `until`, when
   it closes.
4. **Someone replies in the thread.** Pipe the text to `awf reply {ref} {agent} --to {id} --json`
   when it answers an open question, or to `awf send {ref} {agent} --json` otherwise, and post the
   refusal back when it prints one, a line with a `code`. For a participant whose messages go to
   the code, it is
   `awf emit {ref} {key}:reply '{"text":…,"author":…}' --event-id {message id} --json`, whose
   result, without a `code`, may still say the run didn't take it: post back an `ok: false` one's
   `outcome` and `why`.
5. **Answered, expired, ended.** Mark the question answered elsewhere or closed, and say in the
   thread when the run's attempt ended.
6. **Save the cursor** after each batch, so a restart reads on from there.

Since the first answer wins, the bot, the terminal and a coding session can hold the same
participant at once.

## Catches

- **Not every placement can wait for an answer.** `--await-reply` has the same limits as between
  agents: see [Messaging](/guide/messaging#catches).
- **An unsandboxed agent can answer for the participant.** `awf reply` and `awf send` reach a live
  run over a socket in `~/.awf/coordinator`, which no [sandbox](/guide/sandboxes) can reach. An
  agent without one runs as your user with `awf` on its path, and can do what a holder can. A
  workflow that needs the guarantee sandboxes its agents.
- **A participant isn't you.** Its message carries a peer's authority plus what the route's purpose
  grants, never the authority of the person who started the run;
  [Security](/guide/security#what-agents-may-do) has the rest.
- **A run in another folder** is found without `--cwd` or `--run-root` only in a project where awf
  has started a run of a workflow with events.

## See also

- [`awf inbox`](/reference/awf#inbox) and [`awf reply`, `awf send`](/reference/awf#reply): every
  flag, refusal and exit code.
- [A coordinator outside the run](/reference/workflow-api#a-coordinator-outside-the-run) in the
  workflow API, and [participants](/reference/testing-api#participants) in the testing API: a script
  answers for the participant, free.
- A coding session learns the holder's job from the
  [`awf-coordinator` skill](https://github.com/romanlv/agentswf/tree/main/packages/engine/skills/awf-coordinator).
