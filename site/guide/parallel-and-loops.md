---
title: Parallel and loops
description: "The two shapes most workflows take: agents side by side with wf.parallel, and one agent checking another round after round in a for loop, bounded, branching on each outcome, carrying feedback."
---

# Parallel and loops

Control flow in a workflow is plain TypeScript, and two shapes come up in almost every one:
**agents side by side**, such as three reviewers each looking for one kind of problem, and **one
agent checking another**, round after round, until it approves. The first is `wf.parallel`, the
second a `for`. They combine: several reviewers in one round is a `parallel` inside the loop.

## Side by side

`wf.parallel` runs a function over a list of items, with a concurrency limit, shows the group in
the progress view, and gives the results back in the order of the items:

<<< @/../examples/site/guide/parallel.ts#fan-out

Each item gets its own agent, keyed by its lens, and its own turn. Two run at a time; the third
starts when one finishes. `reviews` has one entry per lens, in the order of `LENSES`, whichever
finished first. Fanning in is plain code over that array:

<<< @/../examples/site/guide/parallel.ts#fan-in

The whole workflow is in
[`examples/site/guide/parallel.ts`](https://github.com/romanlv/agentswf/blob/main/examples/site/guide/parallel.ts),
with its test beside it.

### The options

```ts
wf.parallel(items, (item, index) => …, { concurrency?, label?, deadline? })
```

- **`concurrency`** is how many items run at once. It defaults to all of them, and must be a
  positive integer. Each call has its own limit, so a `parallel` of 4 inside a `parallel` of 3
  can have 12 agents working.
- **`label`** names the group in the run's [progress view](/guide/following-runs), where it shows
  as `lenses 0/3 · 1 queued` while the first two work, then `lenses 1/3`, with how many of its
  agents failed. An unlabelled `parallel` inside a labelled one counts as part of it.
- **`deadline`** bounds the whole group. When it passes, `parallel` rejects and drops what it had
  gathered; [A group of agents](/guide/timeouts#a-group-of-agents) has how to keep it.

The function gets each item and its index. An empty list resolves to `[]` at once.

### When one fails

An agent that doesn't answer is not an error. Its turn ends with an [outcome](/guide/how-it-works)
such as `failed` or `timed-out`, and `run` resolves with it. So the fan-out above keeps going when
a reviewer fails: that lens comes back with no findings and a reason, the others with theirs.

A branch that throws is different. `parallel` is fail-fast:

<<< @/../examples/site/guide/parallel.ts#strict

When one branch throws, `parallel` cancels the turns still running in the others (they end
`cancelled`), starts no more items, waits for those turns to end, and then rejects with that
first error. The results of the branches that had finished are lost with it.

So choose per workflow. Return the outcome as data when the other agents' work is still worth
having; throw when one missing answer makes the rest pointless. To keep going past a throw from
your own code, such as opening an agent, catch it inside the branch and return it as data, as
[`catalogue-review`](https://github.com/romanlv/agentswf/blob/main/examples/catalogue-review/workflow.ts)
does: each failure becomes an entry in the result's `failures`.

## Round after round

An implementer works, a reviewer on another model reads the change and answers with a typed
verdict, and the implementer makes the changes it asked for, until the reviewer approves or the
rounds run out:

<<< @/../examples/site/index.ts#loop

- **Each agent keeps its session.** The implementer's second turn continues from its first, so
  the prompt says only what is new: the changes asked for.
- **The verdict is typed.** `review.outcome.value.approved` is a boolean the engine checked
  against `VERDICT`, so the `if` decides on a value, not on prose.
- **Every turn ends with an [outcome](/guide/how-it-works#the-words),** and the loop looks at it
  before it reads a value.
- **The loop has a bound.** Three rounds, then it returns `approved: false` instead of going on.

The rest of this section builds that loop out, in
[`examples/site/guide/loops.ts`](https://github.com/romanlv/agentswf/blob/main/examples/site/guide/loops.ts)
and its test.

### Who checks whom

Put the reviewer on another harness or model than the implementer, so it doesn't share the
implementer's blind spots: above, claude implements and codex reviews. The reviewer reads the
change in the working tree itself; the author's summary is context, not evidence.

- **Keep the reviewer from fixing.** Say so in its `instructions`, or open it in a
  [sandbox](/guide/sandboxes) without `write`, where it sees the working directory read-only.
- **Keep the verdict small.** A boolean and a list of changes is all the loop needs;
  [A typed answer](/guide/agents#a-typed-answer) has how the agent hands it back.
- **Several reviewers** are a `parallel` inside the round, one agent per lens, and the round
  approves when they all do.
- **A check that needs no agent,** such as routing a change before anyone works on it, can go to
  a [decision model](/guide/decisions).

### Branch on the outcome

`isAnswered(outcome)` is enough when every non-answer ends the loop the same way. When one
deserves another try, branch on `outcome.kind`. Each round starts with the implementer's turn:

<<< @/../examples/site/guide/loops.ts#branch

A `failed` or `timed-out` turn closes its agent, so the replacement is opened under a key of its
own, `implementer#2`, and starts with no session: its prompt gives it the task and the changes
still asked for. A missing login fails every agent on that harness alike, so the loop stops on it
rather than open another. Any other non-answer, and a second failure, stops the run with the
kind and the reason.

What each kind leaves of the agent is on [Agents](/guide/agents#what-each-ending-means). How the
loop ends is yours: return a value that says what happened, `return wf.stop(reason)` so the run
can be continued, or let an error throw and fail it
([Stopping with a reason](/guide/workflows#stopping-with-a-reason)).

### Bound the loop

<<< @/../examples/site/guide/loops.ts#bound

- **Rounds, in code.** A reviewer can always find something more. `ROUNDS` ends the loop, and
  the result says it wasn't approved and what is still open, for a person or the next workflow to
  pick up. Never write the loop as `while (true)`.
- **Time, per turn.** `timeoutMs` ends a turn `timed-out` when it passes, and `awf run --timeout`
  bounds the whole run: [Timeouts and nudges](/guide/timeouts).

Without either, a turn whose agent stops without answering still ends: the engine nudges it, and
the turn ends `unanswered` if no answer comes. What nothing stops is a loop that keeps getting
answers.

In a run with [stages](/guide/runs#stages), the whole loop goes inside one stage. A continue then
redoes the loop from its first round.

### Carry feedback between rounds

The rest of the round is the review, and what the next round is told:

<<< @/../examples/site/guide/loops.ts#feedback

- **Send only what is new.** The implementer's session holds the task and its own earlier work,
  so a round's prompt is the changes, not the history.
- **Ask the reviewer about its own changes.** It keeps its session too, so from the second round
  it is told what the author says it did and asked to check each change, then the rest.
- **Keep what matters in variables.** `prompt` and `open` live in the workflow, not in an agent,
  so they survive a replaced agent, and `open` ends up in the result when the rounds run out.
- **Long loops grow the context.** Between rounds, `agent.compact({ prompt })` shrinks it with
  the harness's own compaction: [Agents](/guide/agents#compact-switch-fork).

## Catches

- **Give each branch its own agent key.** Opening a key that is already open returns the same
  agent, and an agent takes one turn at a time, so branches that share one wait for each other.
- **Await what a branch starts.** `parallel` resolves only once every turn started inside it has
  settled. Work started from a branch after its `parallel` has resolved is refused.
- **A `parallel` goes inside a stage, not stages inside a `parallel`.** A run has one stage open
  at a time, so parallel branches can't each enter one ([Runs](/guide/runs)).
- **`Promise.all` works too.** It has no limit, no deadline and no progress line, and when one
  promise rejects, the others keep running.
- **A non-answer is not an exception.** Reading `outcome.value` before checking the kind doesn't
  type-check.
- **`unanswered` comes after a nudge.** The engine already asked the agent for its answer, so
  asking again in the same session is a choice, not a retry the engine skipped.
- **A replacement agent knows nothing.** Its prompt and the working tree are all it has.

## Testing it

A test scripts each agent by key, so parallel branches are read by key, not by position; to check
item order, the [parallel sample's test](https://github.com/romanlv/agentswf/blob/main/examples/site/guide/parallel.test.ts)
makes the first item's answer wait for the last's. A scripted `reply.failed()`,
`reply.timedOut()` or `reply.silent()` drives each branch of a loop for free; the
[loop sample's test](https://github.com/romanlv/agentswf/blob/main/examples/site/guide/loops.test.ts)
covers approval, the bound, a replacement and a stop. [Testing](/guide/testing) has the rest.

## See also

- [`parallel`](/reference/workflow-api#parallel), [Outcomes](/reference/workflow-api#outcomes)
  and [Sessions](/reference/workflow-api#sessions-talk-to-the-same-agent-again) in the workflow
  API.
- [Review loop](/patterns/review-loop), the pattern: a reviewer that asks for each fix by message.
- [`examples/catalogue-review`](https://github.com/romanlv/agentswf/tree/main/examples/catalogue-review):
  lenses chosen by the files a diff touches, each finding verified by its own agent, a `parallel`
  after a `parallel`.
