---
id: "032"
title: "A coordinator outside the run talks with its agents"
summary: "A workflow connects a coordinator. Agents with a route to it report findings and ask questions with wf send. Whatever answers for it (awf run's terminal, another session, or an app such as a Slack bridge) reads with awf inbox and answers with awf reply or awf send, and an agent that asked goes on in the same session."
type: story
status: ready
depends_on: ["029"]
---

# A coordinator outside the run talks with its agents

## Intent

What the operator wants. Check the design against this list.

1. **A run can reach out while it runs.** Agents tell someone outside what they found, and ask
   about what they can't decide. An agent that asks gets the answer in the same session and keeps
   going. The run doesn't stop, no fresh agents start, and nobody pastes answers into a prompt.
2. **One mechanism, whoever answers.** To the workflow, the terminal that started the run, a claude
   or codex session, and a Slack app all look the same. This is messaging from
   [[029-agent-messaging|story 029]] with one more participant, not a second way to talk.
3. **awf is not a chat platform.** Slack, threads, listeners, identities and memory across runs
   belong to apps built on awf. The operator builds one first; an existing host such as Hermes or
   OpenClaw may replace it later. awf offers them a small, stable surface with nothing
   platform-specific in it.
4. **Agents talk to a coordinator, never to "a human".** Who actually answers is the
   coordinator's business. The workflow decides which agents may talk to it, and about what.
5. **Easy to start.** `awf run` can answer questions itself in the terminal, with nothing else
   installed. A second claude or codex session can also play the coordinator while you try a
   workflow.
6. **Tried before it is published.** Apps are built against this surface, so it is tested with a
   sample app and a real host before it ships. Changing it later is expensive.

## Outcome

Something outside a run can talk with it while it runs. The workflow connects a coordinator. The
agents it allows report findings to it and ask it questions. An agent that asks waits, for hours if
needed, and then continues with the answer in the same session. The coordinator decides what to do
with each message: answer it itself, ask a person in a Slack thread, or both. awf doesn't know or
care which.

Why now: today a headless run can't reach anyone. It can stop the run (`workflow.stop`, then
`--continue --from-stage`, which starts fresh agents that see earlier answers only as prompt text),
or write a file nobody is watching. Two workflows need more:

- **Datadog watch.** A cron starts a run every 15 minutes. Its agents check Datadog logs. When they
  find something, they note it in the workflow's memory and investigate. If the finding holds up,
  they report it. The operator reads the report in a Slack thread and answers there. The workflow
  gives the route a 2-hour timeout: the next run looks again anyway, and runs that wait all night
  would pile up, one every 15 minutes.
- **workday-cli build and intake** (`tools/workday-cli/core/workflows`). Any agent may return
  `{kind:"question"}`, which stops the run until `request:answer` continues it. The owner wants
  several rounds of questions in one conversation, answered the next morning if need be, and an
  intake step that pins down a vague request before anything is built.

## How it works

Three terms:

- **coordinator**: a participant outside the run. The workflow connects it under a key, here
  `coordinator`.
- **holder**: whatever answers as the coordinator. That is `awf run`'s own terminal, another claude
  or codex session, or an app.
- **run log**: the run's event file, `turns.jsonl`. Internal; holders never read it directly.

```text
              run {id}                                      holder
 ┌──────────────────────────────────────────┐
 │ investigator ── wf send coordinator ───▶ │──▶ awf inbox ──────────▶ ┌ awf run's terminal
 │      ▲                                   │                          ├ a claude / codex session
 │      └── next turn, same session ◀────── │◀── awf reply / send ◀─── └ an app (Slack, Hermes, …)
 └──────────────────────────────────────────┘
```

In short: inside the run, agents use `wf send`, and answers come back as their next turn. Outside
it, the holder uses the same verbs on `awf`: `awf inbox` to read, `awf reply` and `awf send` to talk
back.

**1. The workflow connects the coordinator and allows routes to it.** Only agents with a route can
reach it, so the workflow picks who talks outside the run: one agent, several, or none.

```ts
const coordinator = await workflow.participants.connect({
  key: "coordinator",
  labels: { audience: "operator" },
});
await workflow.messages.allow({
  between: [investigator, coordinator],
  purpose: "report findings that hold up; ask when the logs can't settle it",
  timeoutMs: 2 * 60 * 60_000,
});
```

What `connect` does: it adds a participant named `coordinator` to the run, outside it, so routes
can point at it. It records the coordinator and its `labels` in the run log, and opens the socket
that `awf reply` and `awf send` use. It returns the handle that `messages.allow` takes. It doesn't
wait for anyone, and it doesn't say who answers. `labels` is any JSON object, written for the
holder; awf only passes it along in `route` items.

`timeoutMs` on a route to the coordinator closes a question on it unanswered after that long. The
workflow sets it, not the agent: an agent forgets a flag its prompt asked for, and one forgotten
`--timeout` would leave a run waiting forever. It is optional: without it, or an agent's own
`--timeout`, a question waits until it is answered. An agent's `--timeout` applies either way, and
the shorter of the two wins, so it can only shorten the route's. `timeoutMs` is allowed only on a
route to an outside participant; on a route between agents it is refused until something needs it.

Who answers is chosen when the run starts, not in the workflow. The same workflow run as
`awf run investigate.ts` in a terminal is interactive: every question to the coordinator is asked
in the CLI, and the run can go start to finish with all answers typed there. Run from a cron, the
questions wait for an app or a session. A workflow that never calls `connect` has no coordinator,
so its agents can't ask anyone outside, and `awf run` has nothing to prompt for.

**2. An agent talks to it like any other peer.** Nothing is new for the agent:

```sh
# report: nothing waits
wf send coordinator 'checkout-api 5xx at 4× baseline since 09:12; pool exhaustion after deploy 8f3c'

# ask: the turn ends here, and the answer arrives as the next turn in the same session
wf send --await-reply coordinator <<'EOF'
Same symptom as the 2026-10-14 subject, different service. Merge them or keep two?
EOF
```

**3. The holder reads with `awf inbox`.**

```sh
awf inbox {run}                                   # one run: what happened, for a person or a session
awf inbox {run} --open                            # the questions in it still waiting for an answer
awf inbox --all --json --after {cursor} --wait 300 [--workflow {name}] [--as {key}]   # an app
```

It takes a run, like `awf logs {run}`, `awf reply` and `awf send`. `{run}` is `{workflow}/{id}`, for
example `investigate/2026-10-22-0915`, found under the current folder's `.awf/runs`, or the `--cwd`
or `--run-root` given, as `awf run --continue` finds it. `--all` reads every run in the current
folder instead, of any workflow, which is what an app uses to find runs a cron started there;
`--workflow` and `--as` narrow it to one workflow or one coordinator key. It reads only runs that
connected a coordinator; the others have nothing for a holder. Items come oldest first, across runs
too, each run's in its log's order, and `--wait` waits up to that many seconds when nothing is new.

`--open` returns the questions still waiting for an answer right now, with `{run}` or `--all`: a
snapshot, with no cursor and no waiting. It is the view a person, a script or a second session wants
("what needs me?"). With `--all` it takes `--workflow` and `--as`, and no other filters: an app
skips the items it doesn't need, and each filter would be one more thing published.

Every form prints text for a person, and with `--json` one JSON item per line, so agents and
scripts read it without parsing prose. `--open --json` prints the `message` items of the open
questions. Each item has a `kind`:

| `kind` | What it says |
| --- | --- |
| `route` | a route to the coordinator opened or closed: the agent, which way it goes, the purpose, the `timeoutMs`, the coordinator's `labels` |
| `message` | something was sent, either way: `id`, `from`, `to`, `text`, whether it `asks` and until when. From an agent, `to` is the coordinator's key; from the coordinator, `from` is, and `via` says how it came. An answer is an `answered` item only |
| `answered` | a question was answered: its `id`, the `answer`, and `via` (`terminal`, `command` or `test`) |
| `expired` | a question closed unanswered: its `id`, and why: `timeout` (the route's or the agent's), `released` (the coordinator released, or the agent stopped), `cancelled` (a deadline the workflow set around it, or its scope cancelled), `attempt-ended` (the attempt ended, the run was stopped or passed its deadline) |
| `ended` | the run's attempt ended, and how; `interrupted` when its process died |

An agent in an item is named by its peer address, as [[composition]] writes it
(`review:claude/reviewer`). Unlike `wf peers`, an agent in a child call is always qualified, so an
address never changes once printed, even when a later child call reuses the key. Every item carries
`run`, the run's `{workflow}/{id}`. No two runs in one folder share it
(`runs.ts:134` refuses a second run into a taken directory), so any number of runs, of the same
workflow or different ones, show up side by side in one inbox. Message ids look like
`{attempt}.{n}`, because message numbers restart when a run continues in a new attempt.

`route` items mean a holder knows whom it may message before any agent writes. `message` items in
both directions mean every holder sees the whole conversation, including what another holder sent.
`answered` and `expired` items mean a Slack thread can show "answered at the terminal" or retire a
question nobody needs to answer any more. How a question was answered is one of three values and
never free text, so nothing an agent writes ends up shown as who answered.

The **cursor** is an opaque token that remembers a position in each run. It belongs to the run, or
the `--all` filter, it was made with; using it with another is refused. Without `--after`, `awf
inbox` returns everything in the run logs, so an app's first call misses nothing. Under `--all`, any
run in the folder that has new items since the cursor was made is read from where the cursor left
it, or from its start if the cursor never saw it: a new run, a run that connects its coordinator
late, and a run continued with `awf run --continue` all show up on their own. `ended` is per
attempt, so a continued run sends another one later. How the cursor keeps this, and how it avoids
re-reading runs that ended, is internal; these guarantees are published. The holder saves the cursor
after handling a batch. If it crashes, or is down or asleep while runs come and go, it reads again
from the saved cursor and loses nothing. It may see an item twice, never zero times.

Every message is in the run log before `wf send` returns, and `awf inbox` reads from there, so a
holder that starts late still sees everything. The item shape is published; the run log's format
stays internal.

**4. The holder answers with `awf reply`, or starts with `awf send`.**

```sh
awf reply {run} investigator --to {id} 'Keep two, and link them.'
awf send {run} investigator 'Also check whether the 09:12 deploy touched the pool size.'
awf reply {run} investigator --to {id} < answer.md
```

`{run}` is `{workflow}/{id}`, found as `awf inbox` finds it, and the agent is its peer address as
`awf inbox` prints it. Text comes from
the argument or from stdin, so an app can pass a Slack message through unchanged.

`--to` names the question being answered. If someone answers an old Slack message late, and the
same agent has since asked something newer, a reply without it would land on the wrong question
(`messaging.ts:575` answers the latest). So `--to` may be left out only when that agent has exactly
one open question to this coordinator; with more it is refused as `ambiguous`, and with none as
`expired`. A `--to` that names anything but an open question from that agent to this
coordinator is refused as `expired`, whatever it names: a report, a closed question, another
agent's question, an id that never existed.

`awf send` messages an agent first (Q4), over a route the workflow allowed; without one it is
refused. A message to an agent waiting between turns of an operation starts its next turn, which
costs a model call. A message to an idle agent opens a message operation, as any peer's does, and
its stage waits for that operation, so a coordinator that keeps sending keeps the stage going; the
workflow's routes are the limit (Q4). A message to an agent that hasn't started yet waits until it
does, as with any peer. One to an agent awaiting an answer is held and comes with that answer, so a
send to an agent waiting on this coordinator answers nothing; its line says the agent still awaits
the reply to `{id}`. The holder never waits for an answer: the agent's reply comes back as a
`message` item in `awf inbox`.

Both commands print one line, or with `--json` a result with a `code`. The codes are published:

| `code` | Meaning |
| --- | --- |
| `delivered` | the agent will see it |
| `not-found` | no run `{workflow}/{id}` in this folder |
| `ended` | the run has ended, or for `awf send`, the workflow has returned |
| `no-coordinator` | no coordinator by that key: not connected yet, released, or never; a reserved key such as `operator` included |
| `unknown-agent` | the run has no agent at that address |
| `ambiguous` | a bare key two agents share; no `--as` when the workflow connects more than one coordinator; or no `--to` when the agent has more than one open question to this coordinator |
| `expired` | not an open question from that agent to this coordinator: `--to` names a report, a closed question (an earlier attempt's included), another agent's question, one sent to another coordinator than `--as`, or nothing; or no `--to`, and the agent has none open |
| `no-route` | the workflow allows no route from this coordinator to the agent |
| `stopped` | the agent has stopped |
| `closed` | the route was allowed, but has closed: its stage ended, or its scope is finishing |
| `too-large` | the text is over [[messaging]]'s size cap |
| `limit` | the route has used the messages it allows this attempt |
| `inbox-full` | the agent has as many unread messages as [[messaging]] holds |

The first that applies, in the table's order, is returned, as [[messaging]]'s refusals are: a
question's own state is checked before its route's, as `wf reply` checks it, so a `--to` naming a
question that closed with its route is `expired`. `delivered` carries an id `awf inbox` names: for
a reply, the question's; for a send, the new message's. A
live run that hasn't connected the coordinator yet has no socket, so the command reads its state
(`run-state.ts`) to tell `no-coordinator` from `ended`.

`awf inbox` fails the same way (`INBOX_CODES`): `not-found` for no such run, `no-coordinator` for a run that
ended without connecting a coordinator, or that `--as`, and `bad-cursor` for a cursor made with
another run or filter. A live run that hasn't connected a coordinator, or that `--as`, isn't an
error; it just has no items yet. Under `--all` neither is ever an error.

**Speaking as which coordinator.** Both commands speak as the run's coordinator. A reply with `--to`
speaks as the coordinator the question was sent to. When a workflow connects more than one, `awf
send` and a reply without `--to` need `--as {key}`, and leaving it out is refused as `ambiguous`
with the keys listed. A missing `--as` never means the operator: operator authority, if it is ever
built, is `--as operator` and nothing else (Scope).

**Anyone may answer; the first answer wins.** The terminal, an app and another session can all
reply to the same question. The first reply is delivered and shows up as an `answered` item for
the others; any later one is refused as `expired`, or as `no-coordinator` or `ended` when that
first answer released the coordinator or let the run end.

**How the commands find runs.** All three look in the current folder's `.awf/runs`, or the `--cwd`
or `--run-root` given, as [[messaging]]'s `awf send` and `awf run --continue` do. A holder runs in
the folder where runs start, so an app and the cron it serves share a folder; a holder serving
several folders runs one loop in each. `awf inbox` reads the run logs. `awf reply` and `awf send`
reach a live run over a socket the run opens in `~/.awf/coordinator/`, named by a hash of the run's
directory, which is short enough for a socket path's 104-byte limit. The socket goes when the run
ends. Whether a run is still live is checked the way `awf runs` checks it (`run-state.ts`), so a
socket left by a killed run isn't trusted. The socket folder's layout is internal. Once a run has
ended, `awf reply` and `awf send` return `ended`, and the app starts a new run instead (see Scope).
`awf send` returns `ended` as soon as the workflow returns, since [[messaging]] refuses new sends
from then on; a reply to a question still open is delivered until the run ends.

The socket folder is private (mode 0700), not in the workflow's directory, where agents work, and
outside every sandbox. `AWF_COORDINATOR_DIR` moves it if it ever has to, and a sandbox is refused
access to the moved folder as it is to `~/.awf` today (`sandbox/src/resolve.ts:102`), whether
through `read`, `write` or `sockets`.

**5. Waiting for the coordinator doesn't count as work.** An operation's deadline limits how long
an agent works. Waiting for an answer isn't work, so its clock stops while it waits. Today a
question's wait is cut at the operation's deadline (`messaging.ts:724`), and an operation past its
deadline stops its agent (`workflow-runner.ts:2750`). For a question to the coordinator, neither
applies: the wait isn't capped by the deadline, the deadline check skips an agent waiting on the
coordinator, and when the wait ends the deadline moves out by however long it lasted (as
`extended` already does for a message operation, `workflow-runner.ts:2993-2997`). A deadline the
workflow set on the stage, `parallel` or call around it still holds (`deadlineCeiling`,
`workflow-runner.ts:2433`): the wait ends there, and the moved-out deadline stays within it.

A question waits until it is answered, its route's or its own timeout passes, the coordinator is released or the asker stops,
a deadline the workflow set around it passes or its scope is cancelled, the attempt ends, or the run
is stopped or passes its deadline; its `expired` item says which, as step 3 lists. A run has no
deadline by default (Q1); `awf run --timeout` sets one. A question still open when the workflow
returns keeps the run open, since [[messaging]] awaits operations in flight: an intake run waits
overnight for its answer. A workflow that doesn't want that sets the route's `timeoutMs`.

While it waits, a headless agent costs nothing: each of its turns is a separate process. An agent
in a pane (claude only) keeps its pane, process and sandbox open. If the run's process dies during
the wait, that is [[stopped-run-recovery]]'s problem.

**6. Agents see a coordinator, not a person.** A message from the coordinator looks like any peer's
message. It carries whatever authority the route's purpose gives it (Q2).

### Who can be the holder

The workflow is the same in every case.

1. **`awf run`'s own terminal (interactive mode).** When `awf run`'s stdin and stderr are both a
   terminal, and `--json` isn't given, the progress view shows each message to a coordinator as an
   event line and asks for a reply to each question, oldest first, for every coordinator the
   workflow connects. An empty reply skips the question and leaves it open; the prompt doesn't come
   back to it, so it is answered later with `awf reply` or by another holder. If something else
   answers first, the prompt moves on. When the workflow connects more than one coordinator, the
   prompt names the one asked, `reply to investigator as {key} ›`:

   ```text
   ● investigate   investigator asks:
                   Same symptom as the 2026-10-14 subject, different service. Merge them or keep two?
   reply to investigator › Keep two, and link them.
   ```

   With no terminal, as under a cron, questions wait in the run log until an app or a session
   answers them.

2. **An app.** The app, or a cron, starts the run with a plain `awf run`. The app loops on
   `awf inbox --all` in the same folder, so it also sees runs it didn't start itself. It maps each
   run and agent to a Slack thread. A workflow that tracks several subjects opens one agent per
   subject, keyed by the subject, so the agent's key tells the app which thread to use. Whether the
   app answers with its own agent or asks a person is up to the app. M3 builds a sample: read with
   `awf inbox --all`, post to Slack, answer with `awf reply --to`.

3. **Another claude or codex session.** It runs the same commands from its shell, with `--json`.
   Claude Code's shell tool stops a command after 120 s by default, so the skill passes
   `--wait 100`, or a longer tool timeout. A skill can teach it the job. The session that
   *started* the run can't do this:
   [[0010-the-calling-session-is-an-agent|ADR 0010]] treats it as an agent, and changing that
   belongs to [[attended-agent]].

**No "forward this to the user" flag.** Whether a person sees a message is the holder's call. A flag
would let agents decide that instead. A holder has enough to go on: whether the message is a
question, the route's purpose (which the workflow author writes for the holder, e.g. "the operator
decides merges"), and the `labels` the workflow passes to `connect`. A workflow that wants two
policies connects two coordinators, say one answered by an agent and one that goes to a person.

### Testing a workflow with a coordinator

`awf test` scripts the coordinator as it scripts an agent's messages: a function per coordinator
key, called with each message an agent sends it. It may reply, send, or return without answering,
which leaves a question open. The script is also called as each route to the coordinator opens,
which is where one that speaks first sends. When everything left in the run is waiting on the
coordinator's script and no open question has an `until`, the test ends the attempt and the
question expires with `attempt-ended`, so a test never hangs on it. A question with an `until`,
from a short `timeoutMs`, is waited for, so a test can see it expire `timeout`.

```ts
const run = await testWorkflow(investigate, null, {
  agents: { investigator: [answer("…")] },
  coordinators: {
    coordinator: (event) =>
      event.kind === "message" && event.asks ? event.reply("Keep two, and link them.") : undefined,
  },
});
```

An answer from the script shows up as `answered` with `via: "test"`. The option's name and the
message's shape are written into the testing surface in task 1, next to `messages`.

## Scope

In scope:

- the coordinator as an outside participant: connecting it, routes to it, its messages and open
  questions, all in the run log;
- waiting for the coordinator not counting against the asking agent's deadline;
- a route's `timeoutMs` for questions on it;
- interactive mode;
- the coordinator sending first, over a route the workflow allowed (Q4);
- no run deadline by default (Q1);
- the wording of the peer message wrapper, so a route's purpose can grant authority (Q2);
- `awf inbox`, `awf reply` and `awf send` with `--as`, and the coordinator socket;
- `awf test` scripting the coordinator's replies;
- a throwaway sample app outside this repository (M3), and one existing host (M2), before any of
  this is published.

Out of scope:

- anything platform-specific, and the coordinator app itself;
- memory across runs (the workflow's own files), and locking them when runs overlap;
- a scheduler: a cron calling `awf run` is enough for the Datadog watch;
- a reply after the run ended reaching the agent that asked: [[stopped-run-recovery]] and M1. Until
  then the app starts a new run, passing the thread and the old run log as input;
- the session that started the run acting as coordinator: [[attended-agent]];
- the operator sending with operator authority ([[messaging]]'s Q6, held on its M3). When built,
  it is `awf send --as operator`, a reserved key, rather than a second command, and only it may
  `--await-reply`;
- approval as a gate before work starts (foundation §7).

## Context and evidence

What the code does today:

- Messaging routes, `wf send`, `--await-reply`, `wf reply`, open questions and their records are
  built ([[029-agent-messaging|story 029]], [[messaging]]). Every endpoint is an agent and
  everything hangs on an operation: sends and replies without one are refused `no-operation`
  (`messaging.ts:498`, `:572`), and `message-sent` requires `operationId` (`records.ts:526`).
- `message-sent` is written to `turns.jsonl` before `wf send` returns (`messaging.ts:442`, `:756`;
  `runs.ts:416`). Its `message` field is a number within the attempt (`records.ts:523`). The
  route's purpose is on `route-opened`, not on each message.
- An agent's wait is `min(operation deadline, --timeout)` (`messaging.ts:724`), and an operation
  past its deadline stops its agent (`workflow-runner.ts:2750`, `:3021`). A message operation's
  deadline can already be pushed out (`extended`, `workflow-runner.ts:2993-2997`); a workflow
  operation's can't, and the run's deadline is fixed. `awf run` defaults to a 1-hour run deadline
  (`run-command.ts:9`).
- Runs live in `{folder}/.awf/runs/{workflow}/{id}` (`runs.ts:34`, `:101`), so `{workflow}/{id}`
  names one run within a folder.
- Only claude, codex and pi can `--await-reply` headless, each turn its own process
  (`claude -p --resume`, `codex exec resume`, `pi --session-id`). In a pane, only claude
  (`engine/src/messaging/limits.ts:19`).
- When an attempt ends, unread messages are recorded as undelivered and dropped
  (`messaging.ts:1079`), and unread messages keep a stage busy (`messaging.ts:309`).
  [[composition]]'s current design for outside participants also drops their unread messages, and
  counts a message delivered once `wf inbox` printed it. This story replaces both (see the table
  below).
- A reply goes to the asker's latest question (`messaging.ts:575`).
- `awf logs` reads `turns.jsonl` with `--after {cursor}`, `--json` and `--wait` up to 300 s, on
  live and ended runs (`logs-command.ts`, `run-read.ts`). `awf inbox` can reuse that reader.
- [[messaging]] designs `awf send {workflow}/{id} {agent}` for the operator, not built, held until
  its M3 finds what keeps an agent from running it, since every agent on the host has `awf` on its
  path. A run is named `{workflow}/{id}` because an id is unique only within its workflow.
- The control plane drops a connection after 30 s, and so does the `wf` client
  (`control-plane.ts:18`, `client.ts:39`). Long enough for a reply, too short to wait for messages.
- Agents without a sandbox run as the engine's user (`control-plane.ts:31`), so they can reach any
  socket the engine opens.
- Other systems: Claude Tag binds a Slack thread to one long-lived session; NanoClaw resumes the
  stored claude or codex session, starting fresh after 12 MB or 14 days; Hermes opens a thread per
  run. Claude Code deletes transcripts after 30 days by default ([[chat-threads]]).
- workday-cli asks with a 10-minute operation and a 1-hour run (`shared.ts`, `ask`), and copies
  every earlier answer into later prompts from its own ledger.

Constraints and decisions:

- `awf inbox`'s items and cursor, and `awf reply`'s and `awf send`'s arguments, stdin and result
  codes, are the interfaces apps build on.
  Write them into [[messaging]] and [[composition]] before code (`AGENTS.md`, "The rule that
  matters"), and add each field only with its implementation
  ([[0001-unbuilt-interface-leaves-the-surface|ADR 0001]]).
- Decided: chat platforms are apps on awf, outside this repository. The operator builds one first;
  an existing host may replace it.
- Decided: the workflow talks to a coordinator, not to a person.
- Decided: memory across runs is the workflow's own files.
- Decided: [[029-agent-messaging|story 029]] is done, and agents.wf is in beta. Where messaging, its
  records or its testing surface need a better shape for this story, it changes here, with no
  compatibility kept for workflows written against the old one.

## Code map

Task by task, what changes and the tests that already cover it.

### contract

- `packages/contract/src/workflow/participants.ts`: `connect`, `ExternalParticipantSpec`
  (`labels` stays; `bindingPath` goes, since the socket's place is fixed), `release`;
  reserved keys documented on `connect`, the list in `@agentswf/contract/participant`.
- The `messages.allow` spec: `timeoutMs`, on a route to an outside participant.
- `packages/contract/src/records.ts`: `message-sent` with `via` instead of `operationId` for an
  outside sender, how it came (`terminal`, `command`, `test`);
  `route-opened` with its `timeoutMs`; a question's `request-ended` (`RequestEnd`, `records.ts:493`,
  `:571`) carrying what `expired` reports: `timed-out` and `released` exist, and `cancelled` and
  `attempt-ended` are new values; a new `participant-connected` event with
  `labels`; `RUN_EVENT_VERSIONS` bumped. Internal: apps read `awf inbox`, not these.
- A new contract type for `awf inbox`'s JSON output: the published shape.
- `packages/contract/src/wire.ts`: reply and send requests on the coordinator socket, and the
  holder's result codes for both, a new list beside `SEND_CODES` and `REPLY_CODES` (`wire.ts:104`).
- `packages/contract/src/workflow/workflow.ts:80`, `agents.ts:105`, `:175`, `:181`: the run's
  deadline is published to workflow code, `WorkflowContext.deadline` required, and turn and nudge
  deadlines required too. With no run deadline, `WorkflowContext.deadline` becomes optional (Q10).
  `workflow/composition.ts:13` (a call's deadline defaults to its scope's) and
  `workflow/executable.ts` follow it; `AbsoluteDeadline` itself (`timing.ts`) stays.

### engine

- `packages/engine/src/messaging/messaging.ts`: the outside endpoint, kept out of inboxes, `busy`,
  the unread cap and `close`; its open questions; the route timeout and the uncapped wait in
  `#ask`.
- `packages/engine/src/workflow-runner.ts`: the `participants` stubs; workflow completion not
  releasing a coordinator with open questions; the deadline check skipping
  an agent waiting on the coordinator, and moving out a workflow operation's deadline after, as
  `extended` does for a message operation.
- The run's deadline becomes optional where it is read: `workflow-runner.ts` (about 30 reads of
  `options.deadline`, `deadlineCeiling` among them), `deadlines.ts`, `attempt-ending.ts`,
  `operation-liveness.ts`, `result-slots.ts`, `message-operation.ts`, and `operator-cli.ts:305`,
  where `awf run --timeout` becomes one. `run-command.ts:9` and its help line (`:32`) lose the
  1h default; `workflow-testing/index.ts:73`, `:242` lose the test's hour. No workflow in
  `examples/` reads `workflow.deadline`. `sandboxes.ts:399` hands the run's deadline to
  `SandboxContext.deadline` (`sandbox/src/seam.ts:66`), which becomes optional too. The harness
  adapters take a turn's or a message operation's deadline, both still bounded, so they don't
  change.
- `packages/engine/src/control-plane.ts`: a second listener at `~/.awf/coordinator/{hash}.sock`,
  bound to the coordinator, within `sun_path`'s 104 bytes.
- New `inbox-command.ts`, `reply-command.ts`, `send-command.ts`: `awf inbox`, `awf reply`,
  `awf send`; `inbox` reuses `run-read.ts`, and `run-state.ts` for liveness.
- `packages/sandbox/src/resolve.ts`: refuse a moved coordinator folder, as it refuses `~/.awf`.
- `packages/engine/src/run-command.ts`, `run-progress.ts`, `progress-view.ts`: interactive mode.
  None reads stdin today, so the prompt is new: a line reader on stdin beside the progress view on
  stderr. Its prompt moving on when another holder answers first comes with task 8, which makes
  that possible.
- `packages/engine/src/workflow-testing/`: `coordinators` in `TestOptions` (`index.ts:49`), beside
  `messages` (`:62`), with a script type like `MessageScript` (`script.ts:84`).

### Tests that exist

- `messaging/messaging.test.ts`: routes, refusals, questions and their ends; task 2 extends it with
  the outside endpoint, task 3 with the uncapped wait.
- `messaging-runner.test.ts`, `messaging-launcher.test.ts`: messaging through the runner and `wf`;
  the deadline skip and the coordinator staying connected after the workflow returns.
- `workflow-testing/messaging.test.ts`, `waiting.test.ts`: the testing surface; the `coordinators`
  scripts and a test that never hangs.
- `control-plane.test.ts`: the second listener and its refusals (task 6).
- `logs-command` and `run-read` tests: the reader `awf inbox` reuses (task 7).

## Proposed design

The coordinator is [[composition]]'s outside participant, with the changes below where that design
breaks for something outside the run. These go into [[messaging]] and [[composition]] first:

| | [[composition]] today | This story |
| --- | --- | --- |
| How the holder finds the run | a binding file in the workflow's directory | the current folder's `.awf/runs`, `{workflow}/{id}`; `awf inbox --all` reads them all; a socket per live run in `~/.awf/coordinator`, internal |
| Reading | `wf inbox`; printed counts as delivered; unread messages dropped when the participant is released or the run ends | `awf inbox`, backed by the run log, with a cursor; both directions; nothing lost; readable after the run |
| Answering | `wf reply {peer}`, `wf send` | `awf reply {run} {peer} [--to {id}]`, `--to` required unless one question is open; `awf send {run} {peer}` (Q4) |
| Message ids | none in the CLI | none for agents; `{attempt}.{n}` in `awf inbox`, for `--to` |
| A question to it | open once shown; the asker's wait cut at its operation's deadline | open once recorded; the asker's clock stops while it waits |
| When an open question ends | when answered | when answered, at the route's `timeoutMs` or the agent's shorter `--timeout`, on release, when its scope ends, or when the attempt ends; no reminders |
| When the workflow returns | releases it, failing what it owes | it stays connected while a question to it is open, then is released |
| Unread messages to it | an inbox with a cap; unread messages keep a stage busy | no inbox in memory: no cap, no busy stage, nothing dropped |
| Waiting for a reply itself | at most one at a time | never (it doesn't ask) |
| Nobody holding it | not covered | fine: messages wait in the run log, questions wait until answered |
| Records | none | internal: `message-sent` with `operationId` or `via`, `participant-connected` with `labels`; apps see `awf inbox`'s output only |

Messaging gains one kind of endpoint: an outside one with no operation. Routes, refusals, the
message wrapper, records and replies stay the same. Only the rows above change, where behaviour
depends on an operation.

Security: the coordinator folder is the operator's, mode 0700. Two checks keep it there. At start,
`awf run` refuses an `AWF_COORDINATOR_DIR` inside the workflow's directory. When a sandbox is
resolved, a spec that would reach the folder through `read`, `write` or `sockets` is refused, as one
that reaches `~/.awf` is; the socket is never passed into a docker or srt sandbox. That keeps
sandboxed agents out. An agent without a sandbox runs as the same user, has `awf` on its path, and
can do anything a holder can, as it can do anything else on the machine (Q6). `connect` refuses keys
that an agent might read as authority: `operator`, `awf`, `system`, `user`. Refusing them from the
start keeps any workflow from coming to rely on one.

Alternatives rejected:

- **A chat provider inside awf.** A workflow would call something like `workflow.ask("…")`, and a
  provider package (Slack first) would post to a thread and bring the reply back, the way sandbox
  providers plug in. It looks simpler to a workflow author. But awf would then have to own a
  process that listens while runs come and go, the map from threads to runs that outlives every
  run, who in a channel may speak for the operator, catching up after the laptop slept, and each
  platform's limits and credentials. That is a chat platform, and OpenClaw, Hermes and the Chat
  SDK already are one ([[chat-threads]]). It would also be a second way to talk next to messaging,
  with its own records, waits and tests.
- **`wf --coordinator {sock} reply`.** The first draft answered through `wf`, the agents' command,
  pointed at the socket. A holder is outside the run, the operator's side, so it uses `awf` and
  names the run rather than a socket path.
- **`wf inbox`**, [[composition]]'s design. It reads over the run's socket, so it needs a long wait
  the control plane can't hold, and it stops working once the run is gone.
- **`awf logs --messages-to {key}`.** No new read command, but apps would parse raw run-log
  events and look up each message's purpose themselves, and the run log's format would become the
  API.
- **An `awf coordinator` command group** (`runs`, `read`, `reply`, `send`). Needed only to avoid
  clashing with the operator's `awf send`; `--as` does that, and `awf inbox --all` replaces
  `runs`.
- **A machine-wide registry of runs** (a pointer per run in `~/.awf/coordinator`, kept 14 days, and
  a machine-unique run handle). An earlier draft let `awf inbox --all` read every run on the
  machine. Then two apps on one laptop race to answer each other's runs, and a per-folder tool
  gains global state. Scoped to the folder, `{workflow}/{id}` is already unique and the run
  directory is the only record.
- **Agents pass `--timeout` on every question.** The Datadog watch would rely on a prompt
  instruction; one forgotten flag leaves a run waiting forever. The route's `timeoutMs` puts it with
  the workflow.
- **A TypeScript client package.** Typed for a Node app, but a claude session or a Hermes skill
  still needs a command. It can wrap the commands later.
- **Pausing the run's deadline while an agent waits.** The run's deadline is a fixed value used in
  about 40 places and visible to workflow code. Only the asking agent's clock needs to stop, and
  whether the run has a deadline at all is Q1.
- **Agents with their own Slack tool.** awf couldn't tell who answered, the exchange wouldn't be in
  the run log, and every agent that talks would need chat credentials.
- **A blocking `wf ask` in the middle of a turn.** A turn held for hours breaks turn liveness
  ([[021-turn-liveness-and-limits|story 021]]). `--await-reply` already waits between turns.
- **Running the OpenClaw or Hermes gateway next to awf.** Two records of one conversation
  ([[chat-threads]]). A host drives awf, not the other way round.
- **The app starts every run itself.** Then it can't see runs a cron started. `awf inbox --all` in
  the same folder finds both.
- **An `awf run --coordinator {dir}` flag.** An earlier draft used it to place the socket and to
  say "an app answers, not this terminal". A fixed folder does the first, and "first answer wins"
  makes the second unnecessary. It also made a cron run without the flag refuse to start, though
  the app may simply not be running yet.
- **Runs connect to a server the app runs.** That finds cron runs too, but makes every holder a
  server, and a claude session can't listen on a socket.
- **A subject field on every message.** The agent key and `labels` are enough for the Datadog
  watch. A field can be added later without breaking anything.
- **A shortcut to allow a route in `agents.open`.** A second way to do what `messages.allow`
  does.

## Tasks at a glance

Anything published is written down and tried before it is built; anything that publishes nothing
is built first.

- [x] 1. Design: write the outside endpoint, the route `timeoutMs`, `awf inbox`'s items, text and
  JSON output and cursor, `awf reply`/`awf send` with `--as`, `--cwd`/`--run-root` and result
  codes, the message wrapper wording, and `awf test`'s coordinator scripts into [[messaging]],
  [[composition]] and the testing surface. Rewrite [[messaging]]'s Operator CLI and Q6 to match:
  one `awf send`, `--as operator` held. Q10's answer, into the author surface.
- [x] 2. The outside endpoint, with `awf test` scripting it so its tests run on it: `connect` with
  `labels` and reserved keys refused, routes to it with `timeoutMs`, its messages both ways and open
  questions in the run log with the record fields the code map lists, staying connected past the
  workflow's return while a question is open, `participant-connected`, the wrapper wording.
- [ ] 3. Waiting doesn't count: M1 first, as a gate; then the asker's clock stops while it waits on
  the coordinator, within any deadline the workflow set around it, and no default run deadline as
  Q10 settles it, with `awf run`'s help and the docs that state 1h.
- [ ] 4. Interactive mode in `awf run`, then a live run with real agents answered at the terminal,
  before moving on to the next tasks.
- [ ] 5. Stubs of the three commands from task 1's design (canned items, cursor and result codes),
  then the sample app (M3) against them; fold what it finds into task 1's design.
- [ ] 6. The coordinator socket: hashed name, liveness, `AWF_COORDINATOR_DIR`, the sandbox refusal.
- [ ] 7. `awf inbox`: items, text and `--json`, cursor, `{run}`, `--all`, `--open`, `--workflow`,
  `--as`, `--wait`, `--cwd`/`--run-root`.
- [ ] 8. `awf reply` and `awf send`: `--to`, `--as`, stdin, codes and their order, peer addresses,
  first answer wins, including the interactive prompt moving on.
- [ ] 9. M3 again on the real commands, then M2 on one host.
- [ ] 10. Docs: the holder's CLI reference, the skill that teaches a session the job,
  [[status]].

Tasks 3 and 4 publish nothing to apps and exercise everything underneath: the run log and the long
wait. Task 2 adds to `agentswf/testing`, for workflow authors, as designed in task 1. The holder's
commands are published only in tasks 7 and 8, after the stub run in task 5.

## Open questions

### Decided

- **Q1. What stops a run that is waiting for an answer?** Waiting for the coordinator doesn't count
  against the asking agent's deadline, and a question has no time limit unless its route sets a
  `timeoutMs` or the agent passes `--timeout` (Q8). A run has no deadline by default, for every run;
  `awf run --timeout` sets one. A deadline the workflow sets on a stage, `parallel` or call around
  the operation still bounds it, and turn liveness stops a turn that stalls
  ([[021-turn-liveness-and-limits|story 021]]); a workflow that keeps starting new work is bounded
  by spend limits ([[live-spend-limits]]). A waiting run just waits, and the operator looks at it
  and stops it. Rejected: lifting the deadline only once a coordinator connects (changes a fixed
  deadline mid-run), and keeping the 1-hour default.
- **Q2. Can the coordinator tell an agent to change what it is doing?** It has a peer's authority,
  plus whatever the route's purpose grants (e.g. "the coordinator may redirect the
  investigation"). Never the operator's: an app passes along text from a channel it can't fully
  trust.
- **Q3. Agents without a sandbox can reach the socket.** Accepted and documented. The socket stays
  out of the workflow's directory; a workflow that needs the guarantee sandboxes its agents.
- **Q4. Can the coordinator message an agent first?** Yes, over any route the workflow allowed; the
  workflow's routes are the only restriction. Consequences, accepted: a message to an agent between
  turns starts a paid turn, and a long conversation can reach the 40 messages a route allows per
  attempt.
- **Q5. The holder's API.** Three top-level commands on `awf`, matching `wf`'s verbs: `awf inbox`
  reads one run, or every run in the folder with `--all`, with an opaque cursor, and `--open`
  lists waiting questions; `awf reply` and `awf send` talk back, `--as {key}` picks the
  participant. Every command has `--json`, for agents and scripts. Published: `awf inbox`'s items,
  both directions, and cursor, and the two commands' arguments and result codes. The run log's
  format and the socket folder stay internal. Rejected: `awf logs --messages-to`, an
  `awf coordinator` group, a TypeScript client (see "Alternatives rejected").
- **Q6. Q3 again: what an agent without a sandbox can do.** With `awf` on its path, it can read
  every run's coordinator traffic, answer its own question, and message agents as the coordinator
  with whatever authority a purpose grants. Accepted, and documented: an agent without a sandbox
  can already do anything on the machine, and the models run that way are trusted not to.
  No warning on `awf run` and no extra flag. Rejected: refusing to connect a coordinator without a
  flag, and waiting for [[messaging]]'s M3 credential.
- **Q7. Can the terminal stay out of it when an app answers?** Nothing new. The terminal shows
  questions and answers as event lines; a person who wants the app to answer leaves the prompt
  empty, and an `answered` line shows who answered. Rejected: a `--no-prompt` flag on `awf run`.
- **Q8. Who limits how long a question waits?** The workflow, with `timeoutMs` on the route; an
  agent's `--timeout` can only shorten it. Rejected: leaving it to agents.
- **Q9. Which runs does a holder see?** One folder's only (the current one, or `--cwd` or
  `--run-root`), by `{workflow}/{id}`. A holder
  serving several folders runs one loop in each. Rejected: a machine-wide registry.
- **Q10. How does workflow code see a run with no deadline?** `workflow.deadline` becomes
  optional, absent when the run has none (`workflow.ts:80`). An operation's deadline, which
  defaults to its scope's (`agents.ts:105`), is then absent too unless the workflow sets one; a
  turn or nudge still passes its own (`agents.ts:175`, `:181`). It says what is true, and the
  compiler finds every place that assumed a deadline. Rejected: a far-off value, which breaks
  nothing but gives nonsense to code that shows or divides it.

The interfaces are written into [[messaging]] and [[composition]] in task 1, and tried with M3
before they are built.

## To measure

- **M1.** Reopening a headless claude and codex session after hours: does it resume, what does it
  cost once the prompt cache has expired, and does it still remember the investigation? Intent 1
  rests on it ("answered the next morning, same session"), so it gates task 3; a bad answer means
  a cheaper wake-up or a summary at resume. After days, it also decides when a reply after the run
  can reach the agent that asked.
- **M2.** One existing host, Hermes or OpenClaw, drives a run through its own extension point (a
  tool, skill or plugin that runs `awf inbox` and `awf reply`). Does this fit how the host binds a
  thread to a session, or does it need glue awf should have provided? The other host follows later
  as a check, not a gate.
- **M3.** A sample app on the Vercel Chat SDK, outside this repository: read `awf inbox` from a
  saved cursor with `--all`, post to one thread per subject, answer with `--to`, and survive an app
  restart and a laptop sleep. Run it against stubs of the three commands first, so it finds what
  task 1 missed before they are built, and again on the real ones.

## Task execution rule

Process one task at a time. Every task repeats the checklist shown under its details. Do not begin
the next task because the current implementation merely compiles: its design must be recorded, its
diff reviewed by subagents, findings resolved, and focused verification complete.

After all tasks are complete, run story-level verification and request human review of the complete
deliverable.

## Task details

Every task runs the same checklist:

- [ ] Plan
- [ ] Implement
- [ ] Review: two subagents, one for architecture and scope, one for correctness and proof
- [ ] Resolve
- [ ] Verify

[[README#Task and story gates]] says what each step requires.

### 1. The surface is written down

Outcome: everything an app or a workflow author builds on is in [[messaging]], [[composition]] and
the testing surface before any code uses it.

Work:

- **[[composition]]:** the outside participant as the Proposed design's table has it. No binding
  file, `bindingPath` or `wf inbox`; `labels` any JSON object; the reserved keys; staying connected
  past the workflow's return while a question to it is open.
- **[[messaging]]:** the endpoint with no operation; the route's `timeoutMs`, outside routes only;
  a question to the coordinator not counting against the asker's deadline, within the deadlines
  around it; the wrapper wording that lets a purpose grant authority (Q2). The Operator CLI and Q6
  rewritten: one `awf send`, `--as operator` held.
- **The holder CLI:** `awf inbox`'s forms, item kinds and fields, text and JSON output, cursor
  guarantees and failures; `awf reply`'s and `awf send`'s arguments, stdin, `--to`, `--as`,
  `--cwd`/`--run-root`, and the code table in its order.
- **Author surface:** `messages.allow({ timeoutMs })`, `connect` without `bindingPath`, and
  `workflow.deadline` optional (Q10).
- **Testing surface:** the `coordinators` option, the message its script gets, `answered` as `test`.
- **The record:** a draft of `participant-connected`, the `message-sent` and `route-opened` fields,
  and `request-ended`'s reasons. Internal, but approved like a published format, as in story 029.

Done when:

- the story's workflow and test examples compile in a typecheck file against the drafted types;
- the user has approved the written surface and the record draft.

### 2. The coordinator is a participant, and `awf test` answers for it

Outcome: a workflow connects a coordinator. Agents report to it and ask it over their routes, and
everything is in the run log. A workflow's test scripts the coordinator's answers. Until task 3, a
question's wait is still cut at the asker's deadline.

Work:

- **contract:** `ExternalParticipantSpec` without `bindingPath`; reserved keys refused by
  `connect`, `agents.open` and a call's `participants` map; `timeoutMs`
  on `messages.allow`; the record fields from task 1, `RUN_EVENT_VERSIONS` bumped.
- **messaging:** the outside endpoint, kept out of inboxes, `busy`, the unread cap and `close`; its
  open questions; the route's `timeoutMs`, shortened by an agent's `--timeout`; refusing `timeoutMs` on
  a route between agents; a coordinator's message to an idle agent opening a message operation.
- **workflow-runner:** the `participants` stubs replaced; completion releasing the coordinator only
  once no question to it is open.
- **workflow-testing:** `coordinators` scripts; an answer recorded as `test`; ending the attempt
  when everything left waits on the coordinator's script and no open question has an `until`.
- The wrapper wording.

Done when tests on `awf test` cover:

- a report, and a question answered in the same session;
- a question ending at its route's `timeoutMs` (a short one), on release, and at attempt end, each
  with its reason in the record;
- the coordinator sending first, to an idle agent and to one between turns;
- a question open when the workflow returns keeping the run open;
- reserved keys refused by `connect` and `agents.open`, and `timeoutMs` refused between agents;
- a test whose script never answers ending instead of hanging.

### 3. Waiting for the coordinator doesn't count

Outcome: an agent waits hours for an answer and goes on in the same session, and a run has no
deadline unless it is given one.

Work:

- **M1 first:** reopen a headless claude and a codex session after the prompt cache has expired.
  Record the cost and whether it still remembers the investigation in `docs/findings/`. A bad
  result stops the story for a decision: a cheaper wake-up, or a summary at resume.
- **messaging `#ask`:** a question to the coordinator isn't cut at the operation's deadline
  (`messaging.ts:724`), only at a deadline around it (`deadlineCeiling`).
- **workflow-runner:** the deadline check skips an agent waiting on the coordinator, and the
  deadline moves out by the wait afterwards, within the ceiling.
- **No default run deadline:** `run-command.ts:9`, `workflow.deadline` optional (Q10) in the
  contract and every place that reads it, and `awf run`'s help and the docs that state 1h.

Done when:

- tests show a question answered after the asker's deadline would have passed, with the agent
  going on and its deadline moved out; a question in a stage with a deadline expiring there as
  `cancelled`; a run started without `--timeout` having no deadline;
- M1's result is recorded.

### 4. Interactive mode

Outcome: a workflow run in a terminal asks its questions there and can go from start to finish
with nothing else installed.

Work:

- In `run-command.ts`, `run-progress.ts` and `progress-view.ts`: interactive when stdin and stderr
  are terminals and `--json` isn't given.
- Messages to a coordinator as event lines. A prompt for each question, oldest first; naming the
  coordinator when there are several; an empty reply skipping it. An answer recorded as
  `terminal`.
- The prompt moving on when another holder answers comes with task 8.

Done when:

- tests drive the prompt through a fake terminal: answer, skip, several coordinators, no prompt
  without a terminal or with `--json`;
- a live run with real agents asks at the terminal, gets its answer, and goes on in the same
  session, before task 5 starts. Its cost is recorded.

### 5. Stubs, and the sample app against them (M3)

Outcome: an app has tried the surface before it is built.

Work:

- Stubs of `awf inbox`, `awf reply` and `awf send`, outside this repository. They print canned
  items in task 1's shapes, keep a cursor, and return the codes. A script plays runs coming and
  going, one connecting late, one continued.
- The sample app on the Vercel Chat SDK: reads `awf inbox --all` from a saved cursor, keeps one
  thread per subject, answers with `--to`, and survives a restart and a laptop sleep.

Done when:

- M3's result is in To measure;
- every gap it found is in task 1's documents, and the user has approved any change to the
  surface.

### 6. The coordinator socket

Outcome: a live run can be reached from outside it, and only from outside a sandbox.

Work:

- **control-plane:** a second listener at `~/.awf/coordinator/{hash}.sock`, bound to the
  coordinator; the folder at mode 0700; the socket removed when the run ends.
- `AWF_COORDINATOR_DIR`, refused inside the workflow's directory.
- **sandbox `resolve.ts`:** a spec reaching the folder through `read`, `write` or `sockets` is
  refused.
- **wire:** the reply and send requests, and the holder's codes.
- Liveness via `run-state.ts`, so a socket a killed run left isn't trusted.

Done when tests show:

- a run directory deep enough to pass `sun_path`'s 104 bytes still gets a socket;
- a stale socket ignored;
- each refusal: the folder inside the workflow's directory, and an srt or docker spec reaching it.

### 7. `awf inbox`

Outcome: a holder reads one run, or every run in the folder, without missing anything.

Work:

- `inbox-command.ts` on `run-read.ts`, with items built from the records.
- Text and `--json` output; the cursor, internal; `{run}`, `--all`, `--open`, `--workflow`, `--as`,
  `--wait` up to 300 s, `--cwd` and `--run-root`; `not-found`, `no-coordinator`, `bad-cursor`.

Done when tests show:

- a holder reading from a saved cursor across a restart misses nothing, including a new run, one
  that connects late, and one continued with `--continue`;
- items oldest first across runs;
- `--open` as a snapshot;
- each failure;
- the JSON checked against the contract type.

### 8. `awf reply` and `awf send`

Outcome: a holder answers questions and messages agents first.

Work:

- `reply-command.ts` and `send-command.ts` over the socket: the agent address, text from the
  argument or stdin, `--to`, `--as`, and the codes in their order.
- First answer wins, with an `answered` item for the others.
- Interactive mode's prompt moving on when another holder answers.

Done when tests show:

- each code, including two that apply at once returning the earlier one;
- two holders racing, one `delivered` and one `expired`;
- after the workflow returns, a reply to an open question delivered and `awf send` returning
  `ended`;
- the prompt moving on.

### 9. M3 on the real commands, then M2

Outcome: an app and an existing host have driven real runs.

Work:

- The sample app, moved from the stubs to the real commands, through a restart and a laptop sleep.
- M2: Hermes or OpenClaw, through its own extension point, runs `awf inbox` and `awf reply`.

Done when:

- both results are recorded with their costs;
- any glue awf should have provided is either a change the user approved or a todo.

### 10. Docs

Outcome: someone who didn't read this story can be a holder.

Work:

- **A holder reference beside `docs/workflow-api.md`:** the three commands, the items, the codes,
  and the cursor's guarantees.
- **A skill beside `packages/engine/skills/awf-run`:** it teaches a claude or codex session the job,
  with `--json` and `--wait 100`.
- [[messaging]] and [[composition]] marked built where they are; [[status]].

Done when a fresh session, given only the skill, answers a question in a live run.

## Verification

Automated:

- [ ] `bun test`
- [ ] `bunx tsc --noEmit`
- [ ] `bun run scripts/check-boundaries.ts`

Manual or live evaluation:

- [ ] Interactive mode: a live run whose agent asks, answered at the terminal, and the agent going
  on in the same session.
- [ ] A question answered after its asker's operation deadline would have passed: the agent goes on.
- [ ] M1: resume after hours, with its cost.
- [ ] M3: the sample app through a restart and a laptop sleep.
- [ ] M2: one host drives a run, with its cost.

## Review record

2026-10-22, all before any code:

- **Design rounds 1–2** (eight reviewers: messaging, security, app developer, architecture,
  scenarios, simplifier, feasibility, cold read). They found that an agent past its deadline is
  stopped, unread messages die with the attempt, and a late reply lands on the newest question.
  Hence the run log as the inbox, `--to`, `{attempt}.{n}` ids, and stopping only the asker's clock,
  since the run's deadline is fixed in about 40 places. All rejected a "forward to the user" flag.
- **Language pass and command review.** The holder moved from `wf` to `awf` (`inbox`, `reply`,
  `send --as`). Typed inbox items, cursor rules, result codes, and Q6–Q7 were added.
- **Fresh-eyes review.** A wait capped at the deadline would end before any answer, so the clock
  stops instead. The route `timeoutMs` is set by the workflow (Q8), and runs are seen per folder
  (Q9), dropping a machine-wide registry.
- **Review loop, five rounds until clean.** This round defined the following:
  - result codes and their order, matching messaging's refusals;
  - stable peer addresses;
  - the `--all` cursor picking up any run with new items;
  - the coordinator staying connected past the workflow's return;
  - outer deadlines still holding;
  - `awf test` scripting;
  - the record fields the items need.

  Q10 was decided, and tasks were reordered so none depends on a later one.

## Readiness

- [x] Outcome and boundaries are concrete.
- [x] Relevant implementation, callers, and tests are mapped.
- [x] Evidence and research support the proposed design. M1, resuming a session after hours, is
  measured first in task 3 and gates it.
- [x] Expensive interface, record-format, and stage-gate decisions are settled.
- [x] Tasks are ordered, coherent, and independently verifiable.
- [x] Open questions are resolved or explicitly moved out of scope.

## Implementation notes

**Task 1, the surface written down.** Worktree `../worktrees/awf-run-coordinator`, branch
`run-coordinator`. Decisions made while writing it, each in the design docs:

- The route option is `timeoutMs`, as `agent.run({ timeoutMs })` has it, not `timeout: "2h"`.
- What an outside message came through is `via` (`terminal`, `command`, `test`); `message-sent`
  carries either `operationId` or `via`, never both.
- Every inbox item carries its own `cursor`, except under `--open`. A coordinator's answer is an
  `answered` item only, never also a `message`. A `route` item says its `direction`, so a holder
  knows whether it may `awf send`.
- `HOLDER_CODES` checks `expired` right after `ambiguous`, as `REPLY_CODES` checks a question's own
  state before its route's. `awf inbox` has its own codes, `INBOX_CODES`, and `InboxErrorJson`. A
  run is always `{workflow}/{id}`, never a bare id. A reply's `delivered` id is the question's,
  the one its `answered` item carries.
- `RESERVED_PARTICIPANT_KEYS` lives in `@agentswf/contract/participant`, engine-side; authors read
  the keys in the docs. Keys are unique across the run whichever comes first: an agent may not take an outside
  participant's key, nor `connect` one an agent holds, in any call.
- The test ends the attempt only when nothing waiting has an `until`; a short `timeoutMs` is
  waited for, so a test sees `timeout`.
- `expired` reasons come from `request-ended`: `timed-out` reads `timeout`; a question to an outside
  participant never ends `withdrawn` or `failed`. A dead attempt reads `interrupted`, and
  `awf inbox` derives its open questions' `expired` and its `ended`.
- An outside participant's key is unique across the run, never qualified by call path; reserved keys
  are refused by `agents.open` and a call's `participants` map too, so no agent speaks as `operator`.
- `awf send` to an agent awaiting an answer is held, as any peer's message, and its line says the
  agent still awaits the reply.
- `message-sent`, `route-closed` and `request-ended` go to version 2, and their version-1 lines are
  read as version 2 (`RUN_EVENT_OLDEST_READ`), so a run continued across the change keeps its
  messages. `route-opened` gains an optional field and stays at 1.
- The test script is called with inbox-like events, `route` as each route opens and `message`, so
  a script can speak first.
- A message to an outside participant is delivered once recorded; `messagesOf` reads it so.
- The agent side follows: `wf peers` shows a coordinator as `outside`; `until` is optional on
  `wf waiting`'s `awaiting-reply` and on `wf peers`' `awaits`, absent for a wait with no limit, and
  the decoders accept it; `wf waiting`'s `deadline` is optional, absent when no deadline is around
  the operation (Q10); an operation's `deadline` and `timeoutMs` docs say a wait for an outside
  answer moves them out; the failure envelope has lines for `timeoutMs` and `released`.
- Task 1 is committed on the branch only; the branch is not merged or released until the exported
  types have code behind them (task 2 on), so no published type promises what a call refuses.
- `bun test`'s "samples quoted from an example" fails on main too (the triage example's
  formatting), not from this story.
- Reviewed in ten rounds until clean, architecture and correctness lenses; the findings and their
  fixes are the notes above. Verified: `bun run check` clean; `bun test` 1918 pass, the one failure
  above; live, `bun run eval messaging` answered on claude, codex and cursor (~$0.17 list), pi
  failing only on its expired login, and `awf logs` read the run's version-2 message lines.

**Task 2, the coordinator is a participant.** Decisions made while building it:

- `Messaging` owns the outside endpoint: `connect`, `release`, `connected`, `openQuestions`, and
  the holder's `holderReply` and `holderSend`, which return `HOLDER_CODES` in their order (all but
  `not-found`, which is the command's). A message to an outside participant goes into no inbox and
  is shown once recorded, so its asker finishing first ends it `released`, never `withdrawn`.
- First answer wins atomically: `holderReply` settles the question before its first `await`.
  Without `--as` and with several coordinators connected, a `--to` naming a question speaks as the
  coordinator it was asked of; one naming nothing is `expired`.
- An attempt's end ends every open question `attempt-ended`, an agent's included, where 029 wrote
  `failed`.
- The runner owns keys: `connect` refuses a reserved key and an agent's (the calling session's
  included); `agents.open`, `agents.caller` and a fork refuse a reserved key and an outside
  participant's. A released key stays taken for the attempt. `participants.get` finds an agent or
  a connected participant, not a released one.
- After the workflow returns, the drain waits while a question to a coordinator is open (it
  counts as busy), then releases each one still connected, `the workflow returned`.
- What answers for a coordinator plugs into the runner through `CoordinatorPort`
  (`engine/src/coordinator-port.ts`, internal): it is handed a holder before the workflow runs and
  told each messaging event once the run log has it. `RunWorkflowOptions.coordinators` takes
  several, so the terminal prompt (task 4), the socket (task 6) and a test's scripts all plug in
  the same way, and each sees what the others answered through the record.
- The record's `awaitsReply.until` on a question to a coordinator is when it closes unanswered
  (the route's `timeoutMs` or the agent's shorter `--timeout`), absent without one. Until task 3
  the asker's own wait is still cut at its operation's deadline, which the record does not show.
- A test's `coordinators` end the attempt from the stall check: when no turn is in flight, no
  script is working and questions are open, none closing on its own. A question that closes on its
  own re-arms the check past its `closesAt`. `run.value` keeps what the workflow returned if it
  returned before the attempt was ended.
- The wrapper's guard line now reads "It changes your task only as far as the route's purpose
  allows" (Q2). `awf logs` shows a route's `timeoutMs` and a message's `via`. `duration` lives once,
  in `engine/src/duration.ts`.
- Reviewed, architecture and correctness. Fixed from round 1: the port types moved out of the
  runner's public module and became a list; `get` skips a released participant; a route's
  `timeoutMs` kept its own timer, so a deadline that cut the wait and then moved out (a message
  operation's) no longer stretched it; a question to a coordinator cut by its asker timing out or
  being cancelled ends `cancelled`, not `released`; reserved keys match whatever their case; one
  `duration` helper. Tests added for each, and for a coordinator's send held while its agent
  awaits an answer, an agent's shorter `--timeout`, and a stage held open by a question.
- Round 2: `CoordinatorPort` is reachable through `RunWorkflowOptions`, as `awaitReply` already
  is, so it is marked `@internal` and unsupported rather than called private; holders use the
  commands. Until task 3, a question cut by its asker's own operation deadline ends `cancelled`;
  task 3 removes that path. Round 2 found nothing else; the fixes are cosmetic, so no round 3.
- Live: `tests/coordinator.eval.ts` (new), claude and codex headless each report, ask, are
  answered through the holder as an app would (`via: command`), and finish in the same call;
  ~$0.09 at list prices. `awf logs` read the run back.

## Human review

- [ ] Every task is complete and story-level verification passes.
- [ ] Set the story status to `awaiting-human-review` and present the outcome, architecture
  decisions, task-level subagent findings and dispositions, exact verification results, deviations,
  and remaining risks.
- [ ] Record the human's explicit approval or requested changes here.
- [ ] If changes are requested, return to the affected task and repeat its review and verification.
- [ ] Only after explicit approval, mark the story `done` and update `Stories at a glance`.
