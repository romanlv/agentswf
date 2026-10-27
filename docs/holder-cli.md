# Answering for a participant

A workflow can connect a **participant** outside the run, such as a coordinator, that its agents
report to and ask ([workflow-api.md](workflow-api.md#a-coordinator-outside-the-run)). Whatever
answers for it is the **holder**: `awf run`'s own terminal, another claude or codex session, or an app such as
a Slack bridge. This page is the holder's side: three commands on `awf`, the items they print, the
result codes, and what the cursor guarantees. The design and its reasons are in
[design/messaging.md](design/messaging.md#coordinator-cli).

```sh
awf inbox {workflow}/{id}                         # one run: what was said, both ways
awf inbox {workflow}/{id} --open                  # the questions still waiting for an answer
awf inbox --json --after {cursor} --wait 100         # every run here, for an app or a session
awf reply {workflow}/{id} {agent} --to {id} 'Keep two, and link them.'
awf send {workflow}/{id} {agent} 'Also check the 09:12 deploy.'
```

Like `awf runs`, all three read the runs in the current folder's `.awf/runs`, or in `--cwd` or
`--run-root`, so a holder runs in the folder where runs start; an app watching several folders runs
one loop per folder. A run is named `{workflow}/{id}`, or `{id}` when one workflow has it; a run
not found there is looked for in each project awf has started a run with events in, as every
command that takes a run does. Every command takes `--json`, and `--as {key}`
when the workflow connects more than one participant.

## In a terminal

`awf run` asks the questions itself when its stdin and stderr are a terminal and `--json` isn't
given. Reports print as lines, and each question is a prompt, oldest first; one that waited behind
another shows its text again when its turn comes. An empty answer leaves the question for another
holder. A question answered elsewhere, or closed, is skipped.

With `--json`, or with no terminal, as under a cron, nothing is asked. Each question prints in the
run's progress with the command that answers it, and waits in the run log:

```
● investigator asks coordinator (1.2):
                Merge the two incidents, or keep two?
  answer: awf reply investigate/r1 investigator --to 1.2 '…'
```

## `awf inbox`

Reads what the run log holds, so a holder that starts late, or after the run ended, still sees it
all. Items come oldest first, across runs too, each run's in its log's order. With no run, it reads every
run in the folder that connected a participant; `--workflow {name}` and `--as {key}` narrow it.
`--wait {seconds}`, at most 300, waits when nothing is new; a session's shell tool stops a command
after 120 s by default, so it passes 100. `--open` is a snapshot of the questions waiting now, with
no cursor and no waiting.

Text is for a person. `--json` prints one item per line, `InboxItemJson`
(`packages/contract/src/records.ts`), each with `v`, `ref`, `at`, and outside `--open` a `cursor`:

| `kind` | Fields |
| --- | --- |
| `route` | `state` (`opened`, `closed`), `participant`, `agent`, `direction` (`both`, `to-participant`, `from-participant`), `purpose`, `timeoutMs`, `labels`; closed, its `reason` |
| `message` | `participant`, `id`, `from`, `to`, `text`; a question has `asks`, and `until` when it closes unanswered at a limit; one the participant sent with `awf send` has `via` |
| `answered` | `participant`, the question's `id`, the `answer`, and `via`: `terminal`, `command` or `test` |
| `expired` | `participant`, the question's `id`, and `reason`: `timeout`, `released`, `cancelled` or `attempt-ended` |
| `ended` | an attempt ended: `attempt` and `outcome`, or `interrupted` when its process died; a `parked` one has `label`, its last wait's, when it gave one |

Message ids are `{attempt}.{n}`. A coordinator's answer is an `answered` item only. An agent is
named by its peer address. A route's `direction` says whether `awf send` may reach the agent at
all. Readers ignore kinds and fields they don't know; `v` changes only when one is renamed or
removed.

**The cursor.** Opaque, for the run, or every run here and its `--workflow`, it was made with; another's is refused.
Without `--after`, everything is read, so a first call misses nothing. From a saved cursor, a holder
sees every item after it in every run here: a new run, one that connects late, and one continued
with `awf run --continue` included. Save the cursor after handling a batch: after a crash, or
being down or asleep, reading on from it loses nothing. An item may come twice, never zero times.
An attempt whose process died reads as `interrupted`: each question still open in it gets an
`expired` (`attempt-ended`), so no holder waits on an answer no one can take.

It fails `not-found` for no such run, `no-participant` for a run that ended without connecting one
(or that `--as`), and `bad-cursor`, in that order; with `--json`, `{ v: 1, code, error }`. A live run
that has not connected one yet is just empty. Exit codes: 0 read, 1 one of those, 2 a usage error,
3 the run's files could not be read.

## `awf reply` and `awf send`

The text is the last argument, or stdin without one, so an app passes a chat message through
unchanged. Neither waits for the agent: its answer comes back in `awf inbox`.

`awf reply` answers a question. `--to {id}` names it, as `awf inbox` printed it; it may be left out
only when that agent has exactly one question open to this participant. A late answer to an old
question never lands on a newer one: a `--to` naming anything but an open question from that agent
is `expired`. Anyone may answer, and the first answer wins.

`awf send` messages an agent first, over a route the workflow allowed. A busy agent gets it with
its next turn, and an idle one gets a turn of its own for it, a model call. One waiting for this
coordinator's answer gets it with that answer; the command says so.

Both print one line, or with `--json` `ParticipantResultJson`: `delivered` with the id an `awf inbox`
item names (for a reply the question's, for a send the new message's), or a refusal. The first code
that applies, in this order:

| `code` | Meaning |
| --- | --- |
| `delivered` | the agent will see it |
| `not-found` | no run `{workflow}/{id}` here, or in a project awf knows |
| `ended` | the run has ended, or for `awf send`, the workflow has returned |
| `no-participant` | no participant by that key: not connected yet, released, or never; a reserved key such as `operator` included |
| `unknown-agent` | the run has no agent at that address |
| `ambiguous` | no `--as` when the workflow connects more than one; no `--to` when the agent has more than one open question; the choices are listed |
| `expired` | not an open question from that agent to this participant |
| `no-route` | the workflow allows no route from this participant to the agent |
| `stopped` | the agent has stopped |
| `closed` | the route was allowed but has closed |
| `too-large` | over 16 KB |
| `limit` | the route has used the messages it allows this attempt |
| `inbox-full` | the agent has 16 unread messages |

Exit codes: 0 delivered, 1 refused, 2 a usage error, 3 the run could not be reached.

## What reaches what

`awf reply` and `awf send` reach a live run over a socket in `~/.awf/coordinator`, the operator's
alone; `AWF_COORDINATOR_DIR` moves it, never into the workflow's directory. No sandbox reaches it.
An agent without a sandbox runs as the operator's user with `awf` on its path, and can do what a
holder can, as it can do anything else on the machine; a workflow that needs the guarantee
sandboxes its agents. A message from the participant carries a peer's authority plus what the
route's purpose grants, never the operator's.

A session can learn the job from the `awf-coordinator` skill
(`packages/engine/skills/awf-coordinator`).
