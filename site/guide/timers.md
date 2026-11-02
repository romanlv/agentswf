---
title: Timers
description: "Waiting on time in a run with events: race and sleep on a timer, a timer's fixed time, moving one by cancelling it or by keeping the time in state with wf.at, and when a due timer fires."
---

# Timers

A run with [events](/guide/events) can wait days for a time to come: a reminder, a deadline, a
quiet day after a release. A **timer** is that time, recorded once under a name. When it comes
due, it fires into the run's mailbox as a `timer:due` event, which a wait takes like any other
event, and the run parks in between with no process left.

## A first timer

A race of an event and a duration waits for whichever comes first:

<<< @/../examples/site/guide/events-waits.ts#race

`quiet: "1d"` is a timer of the race's own. The race is recorded under its name, `first-day`, and
the timer under `first-day@quiet`, so every wake finds the same timer, not a new day counted from
the wake.

## Sleep

`wf.sleep(name, when)` waits until a time and goes on, so straight-line code can wait for weeks.
After the quiet day above, the release holds for two weeks, and then the flag goes:

<<< @/../examples/site/guide/events-waits.ts#sleep

A sleep is a race of one timer, `hold@sleep`, and the run parks while it waits. A run woken early
waits only for what is left, and one woken late goes straight on. Sleeps share their names with
races, so a sleep in a loop is named per round. Without `events`, a sleep waits in its process.

Both samples are one workflow, checked and tested:
[`examples/site/guide/events-waits.ts`](https://github.com/romanlv/agentswf/blob/main/examples/site/guide/events-waits.ts).
Its test runs the whole fortnight in milliseconds, since a test's clock is
[virtual](#when-a-timer-fires).

## Named timers

A race's own timer lives as long as its race. A time that must outlast one race, shared by every
round of a loop or cancelled by your code, is a named timer: `wf.timer(name, when)`, passed to a
wait as a branch. Here a doc waits for approval, with a reminder every two days, the race's own,
and an expiry at fourteen that every round shares:

<<< @/../examples/site/reference/workflow-api.ts#race

- **`when` is a duration or a `Date`.** A duration, `"{n}d"`, `"{n}h"` or `"{n}m"`, decimals
  allowed (`"1.5h"`), counts from the first call under the name; a unit typo, `"1hr"` or `"60s"`,
  fails `tsc`. A `Date` is a fixed time, from the run's event, arguments or files.
- **`wf.timer` returns at once.** It records the time; a wait takes its `timer:due` when it comes.
  The timer has `name`, `due` (an ISO time), `cancel()` and `is(e)`.

### The first call names the time

A run's code runs again from the top on every wake, so `wf.timer("doc-expires", "14d")` runs
again too. The first call records the time, and every later call under that name, in this attempt
or any other, gets the recorded timer back. That is what keeps the fourteen days from restarting
on each wake.

So a timer can't be moved by calling it again: a later call asking another time is logged and
ignored. For the same reason, a time counted from now is a duration, not a `Date` built from
`wf.now()`: that `Date` is different on every wake, and each wake logs the mismatch.

## Moving a timer

A deadline put off, a reminder snoozed, a retry backed off: there are two ways, by how often the
time moves.

### Cancel it and make the next

For a time that moves now and then: cancel the timer and make a new one under the next name.
Here a pull request is asked after once it has had no push for three days, and each push starts
the three days again:

<<< @/../examples/site/guide/timers.ts#move

- **`await stale.cancel()`** stops `stale-0`, and withdraws its `timer:due` if it came but no wait
  took it. A cancelled name stays cancelled.
- **`stale-1`** is new, so its three days count from the push. On a later wake, the races give
  back their recorded answers, the cancel is a no-op, and `wf.timer("stale-1", "3d")` gets the
  recorded time: the loop walks back to where it was.

The whole workflow and its test are in
[`examples/site/guide/timers.ts`](https://github.com/romanlv/agentswf/blob/main/examples/site/guide/timers.ts).

### Keep the time in state, with wf.at

For a time that moves all the time, keep it where the run keeps its state, and let a `select`
read it. `wf.at(read)` is a branch due at whatever `read` returns: a `Date`, or `null` for none.
It is asked at every wait, so when the code changes the time, the branch follows.

Here a question waits for an engineer's answer, nudging every four hours. A reply of "later"
moves the next nudge a day out, and an answer clears it:

<<< @/../examples/nudges/workflow.ts#select

The ledger is a small JSON file under the run's working directory, holding the next nudge's time
and the count. Nothing is named per move, and there is no stale timer to cancel or ignore.

- **`read` reads state that outlives the process:** a file, or what is rebuilt from one. A parked
  run wakes in a new process and asks again. A variable starts over on every wake.
- **`read` is cheap and synchronous.** `wf.now()` and `wf.after()` throw inside it, as does
  returning anything but a `Date` or `null`.
- **`wf.after(duration)`** is now plus a duration: the time to store, where the code sets it.
- **A time returned once isn't returned again,** so a handler that leaves the state alone doesn't
  fire on every pass.
- **It isn't a timer:** nothing is recorded under a name and there is nothing to cancel. It is a
  `select`'s only; a race refuses it.

The example and its test are in
[`examples/nudges`](https://github.com/romanlv/agentswf/tree/main/examples/nudges).

### Which to use

| | Cancel and make the next | `wf.at` |
| --- | --- | --- |
| The time moves | now and then | on every event, or often |
| Where the time lives | the run's record, under a name per move | your state: a file |
| The wait | `race`, `select` or `receive` | `select` only |

## Many timers

A run can hold any number, each under its own name. `wf.timers()` is a branch that takes any of
them, told apart by `name`. A `select` with a branch `retry: wf.timers()` catches every
`retry-{id}` a failed job makes, without a branch per timer: `next.retry.name` says which.

In a `receive` loop, `timer.is(e)` picks out one timer's event, and any timer's has
`e.name === "timer:due"` and its name in `e.from`.

## When a timer fires

- **A running run** takes a due timer at its next wait.
- **A parked run** has no process, so nothing fires until `awf tick` runs and continues it: with a
  tick every five minutes, a timer fires up to five minutes late.
  [Hosting events](/guide/hosting-events) sets the tick up.
- **A wait takes only what it names.** A due timer the current wait doesn't name stays in the
  mailbox for a later one, and doesn't wake a run parked at that wait.
- **Of two ready, the earlier wins:** a timer and an event both waiting are taken in order of
  their time.
- **In a test the clock is virtual.** Where the run would park with a timer to come, the clock
  moves to it, so three days take no time. After `maxTimers`, 20 by default, the run parks
  instead; `maxTimers: 0` parks at the first, to test the parking:
  [A workflow with events](/reference/testing-api#a-workflow-with-events).

## Catches

- **Calling `wf.timer` again doesn't move it.** Cancel it and make the next, or keep the time in
  state.
- **`select` refuses a duration.** A timer in a loop is a `wf.timer` named per round, or a
  `wf.at`.
- **`race` refuses a `Date` and `wf.at`.** A fixed time in a race is `wf.timer(name, date)`.
- **A race cancels only its own timers.** A `wf.timer` passed in stays until you cancel it.

## See also

- [Waiting on time](/reference/workflow-api#waiting-on-time) in the workflow API:
  [`wf.timer`](/reference/workflow-api#timer), [`wf.timers`](/reference/workflow-api#timers),
  [`wf.at`](/reference/workflow-api#at), [`wf.after`](/reference/workflow-api#after).
- [Events](/guide/events): the mailbox, `receive`, `race` and `select`.
- [Hosting events](/guide/hosting-events): `awf tick`, which fires a parked run's timers.
- [`examples/approval-reminders`](https://github.com/romanlv/agentswf/tree/main/examples/approval-reminders):
  the approval loop above as a whole workflow, with its test.
