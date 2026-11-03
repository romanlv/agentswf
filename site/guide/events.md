---
title: Events
description: "Runs that react to things that happen and wait days for them with no process left: event workflows, awf emit, receive, race and select, and timers in brief."
---

# Events

Most workflows run start to finish while you watch. Some work has to wait: CI fails on a pull
request an hour from now, an incident is opened a day after a release, a flag is removed two weeks
later. A workflow with **events** handles that. Each run reacts to the events sent to it, and
between them it **parks**: its process exits and nothing runs, for minutes or for weeks. The next
event, or a timer coming due, runs it again.

Here each pull request gets a run of its own. When CI fails, the run asks an agent to fix it; when
the pull request closes, the run ends:

<<< @/../examples/site/guide/events.ts#workflow

Save it as `ci-fix.ts`. Something outside sends the events, such as a CI job or a webhook handler,
naming the run by its id:

```sh
awf emit --target ci-fix.ts --id 212 ci.failed '{"pr":212,"job":"unit","url":"https://ci.example.com/212/unit"}' --event-id ci-91877
```

The first `ci.failed` for `212` starts the run `ci-fix/212`. Its `receive` returns that event, the
fixer pushes a fix, and the next `receive` finds nothing waiting, so the run parks. The next
`ci.failed` continues it: the code runs from the top, and `receive` returns the new event. The
fixer reopens on the session it had, so it remembers its earlier fixes, though nothing in your code's
variables survives. A `pr.closed` returns from `run`, which ends the run for good.

The sample is checked and tested:
[`examples/site/guide/events.ts`](https://github.com/romanlv/agentswf/blob/main/examples/site/guide/events.ts)
and its test.

## Declaring events

A workflow takes events when its definition declares them:

- **`events`**: each event's name and the schema of its data. Names have no colon; `agent:ended`,
  `participant:reply` and `timer:due` are awf's own.
- **`starts`**: the events that may start a run. Without it, any of them may.
- **`file: import.meta.path`**, required with `starts`: where the workflow lives, so a sender
  holding it, as [`wf.emit`](/reference/workflow-api#emit) does, can find it and its runs. `awf`
  commands find it by the path you give them.

A TypeBox schema doesn't carry its type, so give it one, and each event's data is typed wherever the
workflow takes it:

<<< @/../examples/site/guide/events.ts#schemas

## A run per key

The sender names the run, so one workflow keeps one run per thing it watches: a pull request, a
release, a support case. The id is that thing's own key, `212` here, and the run's ref is
`{workflow}/{id}`, `ci-fix/212`, and the id follows the rules of any [run](/guide/runs)'s. In the
workflow, `wf.runId` is the id.

An event for an id with no run starts one if `starts` lists it, and is refused if not. An event for
a run that exists lands in its **mailbox**, whether the run is working or parked, and wakes it if
it is parked.

## Sending events

```sh
awf emit --target {file} --id {id} {event} [{json}] [--event-id {id}] [--json]
```

- **`--target`** is the workflow's file. The run lives in that file's project, whoever sends: the
  nearest directory at or above the file that holds `.awf/`, or else the file's own directory,
  where the first run makes `.awf/`. A workflow file directly in your home directory is refused,
  since `~/.awf` is awf's own.
- **The data** is checked against the event's schema, and a wrong name, data or id is refused
  before anything is sent.
- **`--event-id`** names this occurrence for good: the same id again is a duplicate, so a webhook
  delivered twice is taken once. Without one, nothing deduplicates the event. Event ids are
  lowercase letters, digits, `.`, `_`, `@` and `-`; an id starting `awf.` is refused, as those are
  the ids awf makes. [Hosting events](/guide/hosting-events) has delivery: retries, ids and exit
  codes.
- **It prints what became of the event:** `accepted`, `duplicate`, or `refused`, when the run has
  returned, or has no run yet and `starts` doesn't list the event.

A workflow can send one too, with `wf.emit(target, id, name, data, { eventId })`. It imports the
target workflow, so a wrong event name or data shape fails `tsc`. A scheduled workflow that polls
GitLab and tells each merge request's run what changed is built this way.

`awf run {file} --id {id}` starts a run by hand, with no event: it runs to its first wait and
parks. Then `wf.started`, the event that started the run, is absent.

What sends events on a schedule or from a webhook, and what wakes a run whose timer is due, is on
[Hosting events](/guide/hosting-events).

## Taking events

`wf.receive()` returns every event waiting in the mailbox, in the order they arrived; the first
call returns the event that started the run. Each call acknowledges what the last one returned.
Events that arrive while the run is busy, as two failures did during a fix, wait and come back
together from the next call, so the code can act on the latest and skip the rest.
[`select`](#race-and-select) takes one at a time. `label` is what `awf runs` shows while the run
waits there.

A run parks when it waits with nothing else of it working: no agent turn, no stage, and nothing in
the mailbox for the wait to take. Waiting while a turn runs keeps the process, so an agent can work
while the code goes on taking events: `agent.start()` launches a turn without awaiting it, and its
end arrives at a wait as `agent:ended`, with the outcome. The race below uses one.
[Events](/reference/workflow-api#events) in the workflow API has `start` and the rest.

## Race and select

`receive` takes whatever is in the mailbox. Two waits take only what you name, each branch a
source of events.

**`race`** waits for the first of its branches. Here the fix runs as a started turn, so the run
can take events while the agent works, and a pull request closing mid-fix cuts it short:

<<< @/../examples/site/guide/events.ts#race

A branch is a declared event (`wf.signal(name)`), an agent (the end of the turn it started), a
[participant routed to the code](/guide/people#a-participant-routed-to-the-code), whose
messages come to your code instead of an agent, or a [timer](/guide/timers). The answer names the
branch that won, so `if (first.closed)` narrows it. The race is recorded under its name,
`fix-or-close`, so a run woken after parking gets the same answer back and walks on.

**`select`** is a loop over the events its branches take, one at a time. The CI loop above,
written with it:

<<< @/../examples/site/guide/events.ts#select

Both samples are checked and tested, in
[`examples/site/guide/events.ts`](https://github.com/romanlv/agentswf/blob/main/examples/site/guide/events.ts).

## Timers

A timer is an event the run sends itself. `wf.timer("review-due", "2d")` records a time, and when
it comes due a `timer:due` event lands in the mailbox, which `receive`, `race` and `select` take
like any other. A race's branch can also be a duration, such as `quiet: "1d"`, and `wf.sleep`
waits until a time and goes on. A parked run's timer fires at the next `awf tick`.

[Timers](/guide/timers) has the examples, how to move a timer, and when a due one fires.

## Catches

- **Variables don't survive parking.** Each wake runs `run` from the top in a new process. What
  must outlive a wait lives in a stage or in files: a count kept in a variable starts at zero after
  every park.
- **Name stages by the event they handle.** In a run with events, a stage that succeeded is reused
  wherever its name comes up again, in any attempt. `fix-{event id}` runs once per failure; a fixed
  name such as `fix` would run once per run.
- **Name a race per round.** A name answers once in an attempt: a second race under the same
  name throws. In a loop, name it `approval-{round}`, as
  [`examples/approval-reminders`](https://github.com/romanlv/agentswf/tree/main/examples/approval-reminders)
  does.
- **A race takes only what it names.** Other events stay in the mailbox for a later wait, and don't
  wake a run parked at the race: a second `ci.failed` during the fix above waits there unread.
- **Work beside a wait is cut off.** Code running alongside a wait, outside any awf call, stops
  when the run parks and runs again on the next wake. Work that must finish goes in a stage or
  before the wait.
- **`return` is final.** Later events for the run are refused. A run that may be needed again keeps
  waiting instead.
- **`race`, `sleep` and `select` can't run inside a stage** or a tool's handler; they throw.
- **Without `events`** a workflow has no `receive` and never parks.

## See also

- [Events](/reference/workflow-api#events) and
  [Waiting on time](/reference/workflow-api#waiting-on-time) in the workflow API.
- [Timers](/guide/timers): races and sleeps on time, moving a timer, and when one fires.
- [A workflow with events](/reference/testing-api#a-workflow-with-events): testing one, with
  events sent mid-turn and a virtual clock.
- [People](/guide/people): a person or app answering a run, and an agent kept warm between events.
- [Durability](/guide/durability#runs-that-wait-for-events): what a parked run keeps across a crash.
- [Review on event](/patterns/review-on-event): a run per merge request, reviewing each push.
