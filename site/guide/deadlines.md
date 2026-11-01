---
title: Deadlines and nudges
description: Bounding how long a run, a group of agents or one turn may take, nudging an agent that goes quiet for its answer, and stopping a run on purpose.
---

# Deadlines and nudges

An agent can work for an hour, stop without answering, or never finish. Two things keep a run in
hand: **deadlines**, which bound how long work may take, and **nudges**, which ask an agent that
went quiet for its answer. Either way the turn still ends with an
[outcome](/guide/how-it-works), so the workflow decides what happens next, and when there's no
point going on, it stops the run on purpose.

Here two reviews run within a budget. `wf.parallel` is how a group of turns gets a deadline, so
the reviews go through it, one at a time (`concurrency: 1`): each turn has ten minutes, the pair
has twenty, a quiet reviewer is nudged for what it has so far, and the run stops, saying why, when
nothing came back.

<<< @/../examples/site/guide/deadlines.ts#file

The sample is checked and tested:
[`examples/site/guide/deadlines.ts`](https://github.com/romanlv/agentswf/blob/main/examples/site/guide/deadlines.ts)
and its test.

## Deadlines

A deadline can be set at three levels, and each one sits inside the one around it:

```text
awf run --timeout 2h                the run's, for this attempt
 └─ wf.parallel(…, { deadline })    earlier or equal
     └─ agent.run({ timeoutMs })    earlier or equal
```

A deadline set later than the one around it doesn't extend anything: the earlier one wins. When
a deadline passes, every turn under it ends `timed-out`.

### The run

```sh
awf run --timeout 2h review.ts
```

A run has no deadline unless `--timeout` gives it one, as a whole number with `ms`, `s`, `m` or
`h`. It bounds one attempt: a `--continue` has no deadline unless you give `--timeout` again.
When it passes, the turns running end `timed-out`, the workflow is cut off wherever it is, and
the attempt ends `timed-out`. [Runs](/guide/runs#how-an-attempt-ends) has every ending, its exit
code, and how to go on from it.

Inside the workflow, `wf.deadline` is the run's deadline as `{ unixMilliseconds }`, and absent
without `--timeout`.

### A group of agents

`wf.parallel` takes a `deadline`, `{ unixMilliseconds }`, for the whole group, as in the sample.
When it passes, the turns still running end `timed-out`, items not yet started never start, and
`parallel` rejects with `DeadlineExceededError`, imported from `agentswf/workflow`, without the
results it had gathered ([Parallel](/guide/parallel#the-options)). Catch it where running out of
time has an answer of its own:

<<< @/../examples/site/guide/deadlines.ts#over

A `parallel` with no deadline of its own rejects the same way when the run's deadline passes, and
`wf.decisions.decide` rejects with it too.

### One turn

<<< @/../examples/site/guide/deadlines.ts#turn

`timeoutMs` bounds the whole turn, from the call, nudges included, and the outcome is `timed-out`
when it passes. `deadline: { unixMilliseconds }` sets the same bound as a point in time; a turn
takes one or the other, not both. Without either, the turn inherits the deadline around it, and
with none at all it runs as long as the agent keeps working. A turn that times out closes its
agent: [Agents](/guide/agents#what-each-ending-means) has what each ending leaves.

A turn that waits for an answer from a person outside the run, a
[participant](/guide/people), isn't working: its clock stops while it waits, but never past the
deadlines around it.

## Nudges

Every turn is nudged by default. When the agent stops without sending an accepted answer, the
engine sends a nudge in the same session:

```text
You finished without reporting the requested result. Report it now.
```

followed by how to answer, as the turn's first prompt had. An agent that answers then ends the
turn `answered`. One that stops again without answering ends it `unanswered`. The exception is
the calling session, where awf can't always tell its operator's interrupt from the agent
stopping: there it isn't nudged unless you pass `nudge`
([The calling session](/guide/calling-session)).

### In a claude pane

A claude pane gets more room, because awf can see its prompts arrive. The engine waits 30 seconds
of quiet before nudging, and the nudge says:

```text
Report the result now, or use wfa waiting with a reason if you still need time.
```

The agent has two minutes from receiving it to send the result or a wait. An agent in the middle
of a long build answers with `wfa waiting --reason …`, which holds off the next nudge, by default
for two minutes and at least 30 seconds, and is then nudged again. A wait never moves the turn's
deadline. [How it works](/guide/how-it-works#the-wfa-commands) lists `wfa waiting` with the
agent's other commands.

### Your own words

```ts
nudge: { prompt: "Send the findings you have so far, even if the review isn't done." }
```

`nudge: { prompt }` replaces the nudge's opening line; how to answer still follows it. Use it to
say what a partial answer should be, as the sample does. `nudge: { deadline }`, a
`{ unixMilliseconds }`, can only shorten the turn: the earlier of it and the turn's own deadline
bounds the whole turn.

### No nudge

```ts
nudge: false
```

A turn with `nudge: false` that ends without an answer is `unanswered` at once. Turn it off when
a nudge is worth less than the time it takes: a quick question you'd rather ask a fresh agent
again, or a turn whose silence you handle anyway.

## Stopping on purpose

<<< @/../examples/site/guide/deadlines.ts#stop

When going on is pointless, here because no reviewer answered or the budget ran out,
`return wf.stop(reason)` ends the attempt `stopped` with your reason rather than failed.
[Workflows](/guide/workflows#stopping-with-a-reason) covers what a stop means for the run. From
outside, Ctrl-C cancels the run, and a second Ctrl-C stops awf at once.

## Catches

- **`timeoutMs` counts from the call.** A turn queued behind another on the same agent spends its
  time waiting too.
- **To keep each item's outcome, bound its turns.** A `timeoutMs` on each turn ends that turn
  `timed-out` and lets the rest go on, where the group's deadline rejects the whole `parallel`, as
  the sample's per-turn ten minutes inside its twenty show.
- **No deadline means no limit.** Nudges end a turn whose agent stops without answering, but an
  agent that keeps working is never cut off. Set `timeoutMs` on turns you can't wait on, or run
  with `--timeout`.
- **Deadlines are real time in a test.** `reply.timedOut()` ends a scripted turn `timed-out` at
  once, and a silent script is nudged as in a run, with `turn.nudge` true:
  [Testing](/guide/testing).
- **These nudges are for an agent in a turn.** Reminding a person who hasn't answered is a
  workflow of its own, waiting on time: [People](/guide/people), and
  [`examples/nudges`](https://github.com/romanlv/agentswf/tree/main/examples/nudges).

## See also

- [Deadlines](/reference/workflow-api#deadlines) and
  [Giving it work](/reference/workflow-api#giving-it-work) in the workflow API.
- [Runs](/guide/runs): how an attempt ends, and going on from one that stopped or timed out.
- [Loops](/guide/loops): branching on each outcome, `timed-out` and `unanswered` included.
