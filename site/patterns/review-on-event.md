---
title: Review on event
description: "Review a merge request when it opens and again at each push, with a run per merge request that waits between events with no process."
---

# Review on event

**The problem:** review every merge request when it opens, and again whenever it is pushed to,
until it closes. Nobody starts a command, and nothing keeps a process open for the days a merge
request can stay open.

**The workflow:** one run per merge request, named by its number. Your forge, a CI job or a poller
sends it an event on each push and one when it closes. The run reviews the newest head, records
the review, and between events it parks: its process exits, and the next event continues it.

The workflow opens its reviewer and waits for events:

<<< @/../examples/site/patterns/review-on-event.ts#open

It handles each event in code: a push records the head to review, a close ends the run, and a
review's end is recorded in a stage named by its head:

<<< @/../examples/site/patterns/review-on-event.ts#take

Then, if a head is waiting and the reviewer is free, it starts a review without awaiting it:

<<< @/../examples/site/patterns/review-on-event.ts#start

The sample's [test](https://github.com/romanlv/agentswf/blob/main/examples/site/patterns/review-on-event.test.ts)
covers a review, a push during a review, a close that cancels one, a failed review, and a head
that isn't a commit hash.

Save it in the repository it reviews. A run of a workflow with events works in its file's
project, the nearest directory at or above the file that holds `.awf/`, so the reviewer reads that
repository. [Events](/guide/events) has the rest of how such a run lives. Then each push sends:

```sh
awf emit --target workflows/review-on-event.ts --id 42 mr.changes \
  '{"mr":42,"base":"main","head":"3f2a9c1"}' --event-id mr42-3f2a9c1
```

and the close:

```sh
awf emit --target workflows/review-on-event.ts --id 42 mr.closed '{"mr":42,"merged":true}'
```

The first `mr.changes` for 42 starts the run `review-on-event/42`; later ones wake it.
`awf runs review-on-event/42` shows what it is doing, or what it waits for.

<!-- TODO(operator): record a run -->
**Cost and time:** not recorded yet. They come from a recorded run of the example, priced at list
prices; [Cost](/guide/cost) has where an estimate comes from. Between events the run has no
process and runs no turn.

## Why it's shaped this way

- **A run per merge request.** The sender names the run with `--id`, so every event about 42
  reaches the same run, and the run's id is all it needs to know which merge request it serves.
  `starts: ["mr.changes"]` lets only a push start one: a close for a merge request with no run is
  refused, not turned into an empty run.
- **The code decides, the agent reviews.** Each event is handled in plain code: a push records the
  head to review, a close ends the run. An agent turn starts only when there is something to
  review.
- **The turn isn't awaited.** `reviewer.start()` returns at once, and the turn's end comes back as
  an event at `receive`, so the run keeps taking events while the reviewer works. A push during a
  review is reviewed as soon as that one ends; a close cancels it.
- **Only the newest head is reviewed.** Three pushes during one review leave one review to do,
  at the last head, not three.
- **Each review is a stage named by its head.** In a run with events, a stage that succeeded is
  reused wherever its name comes up again, so `review-{head}` records each head's review once.
  That stage is where you post the review to the merge request: an event sent twice, or a
  continue after a crash, doesn't post it twice.
- **State is what the next event brings.** When the run parks, its variables go with the
  process, and the next event runs the code from the top. Nothing here needs to outlive a park:
  the run only parks once the newest head is reviewed, and the next push carries its own head.
  A workflow whose state does outlive a park keeps it in files or stages.

## Catches

- **A run that returns is done for good.** Events for it are refused afterwards. That's right for
  a closed merge request; a run that might be needed again keeps waiting instead.
- **A failed or timed-out turn closes its agent.** The sample logs it and opens `reviewer#2` for
  the next push; the failed head isn't reviewed again. Retry it on a timer, as the fuller sketch
  below does, if a missed review matters.
- **Event ids deduplicate.** `--event-id` names one occurrence: a webhook delivered twice is
  accepted once. Without one, nothing deduplicates.
- **Check what becomes a name.** Event ids and stage names are lowercase letters, digits, `.`,
  `_`, `@` and `-`. An event's schema can't hold a `pattern`, so the code checks that `head` is a
  commit hash before it names a stage with it, and logs one that isn't.
- **Something has to send the events.** A webhook handler, a CI step or a scheduled poller runs
  `awf emit` on the machine that holds the repository. A failed or crashed run is woken by
  `awf tick`, which you run on a schedule. [Hosting events](/guide/hosting-events) sets both up.

## The full version

[`examples/event-sketches/mr-review.ts`](https://github.com/romanlv/agentswf/blob/main/examples/event-sketches/mr-review.ts)
is the same run grown to a real review bot for GitLab: findings kept in a ledger, each posted as
a thread and resolved when fixed, a summary note, a retry after a failed review, and compaction
between reviews. Beside it, `mr-tick.ts` is the poller that tells each merge request's run what
changed. Both are type-checked sketches: the ledger and GitLab calls are declared, not written,
so they don't run as they are.

## See also

- [Events](/guide/events) and [Hosting events](/guide/hosting-events) in the guide.
- [Events](/reference/workflow-api#events) and
  [Waiting on time](/reference/workflow-api#waiting-on-time) in the workflow API.
- [A workflow with events](/reference/testing-api#a-workflow-with-events) in the testing API.
- [Review loop](/patterns/review-loop), for a review that asks for its fixes.
