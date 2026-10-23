# Answering for a coordinator

A workflow can connect a **coordinator**, a participant outside the run that its agents report to
and ask ([workflow-api.md](workflow-api.md#a-coordinator-outside-the-run)). Whatever answers for
it is the **holder**: `awf run`'s own terminal, another claude or codex session, or an app such as
a Slack bridge. This page is the holder's side: three commands on `awf`, the items they print, the
result codes, and what the cursor guarantees. The design and its reasons are in
[design/messaging.md](design/messaging.md#coordinator-cli).

```sh
awf inbox {workflow}/{id}                         # one run: what was said, both ways
awf inbox {workflow}/{id} --open                  # the questions still waiting for an answer
awf inbox --all --json --after {cursor} --wait 100   # every run here, for an app or a session
awf reply {workflow}/{id} {agent} --to {id} 'Keep two, and link them.'
awf send {workflow}/{id} {agent} 'Also check the 09:12 deploy.'
```

All three look in the current folder's `.awf/runs`, or the `--cwd` or `--run-root` given, as
`awf runs` does. A run is always `{workflow}/{id}`. A holder runs in the folder where runs start, so
an app and the cron that starts runs share a folder; one serving several folders runs a loop in
each. Every command takes `--json`, and `--as {key}` when the workflow connects more than one
coordinator.

## In a terminal

`awf run` asks a coordinator's questions itself when its stdin and stderr are a terminal and
`--json` isn't given: each message to the coordinator is a line, and each question a prompt,
oldest first. An empty line leaves the question for another holder. A question another holder
answers first, or that closes, is passed over. Under a cron there is no terminal: questions wait
in the run log for `awf reply`.

## `awf inbox`

Reads what the run log holds, so a holder that starts late, or after the run ended, still sees it
all. Items come oldest first, across runs too, each run's in its log's order. `--all` reads every
run in the folder that connected a coordinator; `--workflow {name}` and `--as {key}` narrow it.
`--wait {seconds}`, at most 300, waits when nothing is new; a session's shell tool stops a command
after 120 s by default, so it passes 100. `--open` is a snapshot of the questions waiting now, with
no cursor and no waiting.

Text is for a person. `--json` prints one item per line, `InboxItemJson`
(`packages/contract/src/records.ts`), each with `v`, `run`, `at`, and outside `--open` a `cursor`:

| `kind` | Fields |
| --- | --- |
| `route` | `state` (`opened`, `closed`), `coordinator`, `agent`, `direction` (`both`, `to-coordinator`, `from-coordinator`), `purpose`, `timeoutMs`, `labels`; closed, its `reason` |
| `message` | `coordinator`, `id`, `from`, `to`, `text`; a question has `asks`, and `until` when it closes unanswered at a limit; one the coordinator sent with `awf send` has `via` |
| `answered` | `coordinator`, the question's `id`, the `answer`, and `via`: `terminal`, `command` or `test` |
| `expired` | `coordinator`, the question's `id`, and `reason`: `timeout`, `released`, `cancelled` or `attempt-ended` |
| `ended` | an attempt ended: `attempt` and `outcome`, or `interrupted` when its process died |

Message ids are `{attempt}.{n}`. A coordinator's answer is an `answered` item only. An agent is
named by its peer address. A route's `direction` says whether `awf send` may reach the agent at
all. Readers ignore kinds and fields they don't know; `v` changes only when one is renamed or
removed.

**The cursor.** Opaque, for the run or the `--all` filter it was made with; another's is refused.
Without `--after`, everything is read, so a first call misses nothing. From a saved cursor, a holder
sees every item after it in every run here: a new run, one that connects late, and one continued
with `awf run --continue` included. Save the cursor after handling a batch: after a crash, or
being down or asleep, reading on from it loses nothing. An item may come twice, never zero times.
An attempt whose process died reads as `interrupted`: each question still open in it gets an
`expired` (`attempt-ended`), so no holder waits on an answer no one can take.

It fails `not-found` for no such run, `no-coordinator` for a run that ended without connecting one
(or that `--as`), and `bad-cursor`, in that order; with `--json`, `{ v: 1, code, error }`. A live run
that has not connected one yet is just empty.

## `awf reply` and `awf send`

The text is the last argument, or stdin without one, so an app passes a chat message through
unchanged. Neither waits for the agent: its answer comes back in `awf inbox`.

`awf reply` answers a question. `--to {id}` names it, as `awf inbox` printed it; it may be left out
only when that agent has exactly one question open to this coordinator. A late answer to an old
question never lands on a newer one: a `--to` naming anything but an open question from that agent
is `expired`. Anyone may answer, and the first answer wins.

`awf send` messages an agent first, over a route the workflow allowed. To an agent between turns
it starts the next turn, a model call; to an idle one it opens a message operation; to one
awaiting this coordinator's answer it is held, and comes with that answer, as the command says.

Both print one line, or with `--json` `HolderResultJson`: `delivered` with the id an `awf inbox`
item names (for a reply the question's, for a send the new message's), or a refusal. The first code
that applies, in this order:

| `code` | Meaning |
| --- | --- |
| `delivered` | the agent will see it |
| `not-found` | no run `{workflow}/{id}` here |
| `ended` | the run has ended, or for `awf send`, the workflow has returned |
| `no-coordinator` | no coordinator by that key: not connected yet, released, or never; a reserved key such as `operator` included |
| `unknown-agent` | the run has no agent at that address |
| `ambiguous` | no `--as` when the workflow connects more than one; no `--to` when the agent has more than one open question; the choices are listed |
| `expired` | not an open question from that agent to this coordinator |
| `no-route` | the workflow allows no route from this coordinator to the agent |
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
sandboxes its agents. A message from the coordinator carries a peer's authority plus what the
route's purpose grants, never the operator's.

A session can learn the job from the `awf-coordinator` skill
(`packages/engine/skills/awf-coordinator`).
