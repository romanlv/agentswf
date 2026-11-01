---
title: Loops
description: Loop until a reviewer approves, branch on how each turn ended, bound the loop, and carry feedback from one round to the next.
---

# Loops

A loop is how one agent checks another: an implementer works, a reviewer on another model reads
the change and answers with a typed verdict, and the implementer makes the changes it asked for,
until the reviewer approves or the rounds run out. In a workflow that is a plain `for`:

<<< @/../examples/site/index.ts#loop

Four things make it work:

- **Each agent keeps its session.** The implementer's second turn continues from its first, so
  the prompt says only what is new: the changes asked for.
- **The verdict is typed.** `review.outcome.value.approved` is a boolean the engine checked
  against `VERDICT`, so the `if` decides on a value, not on prose.
- **Every turn ends with an [outcome](/guide/how-it-works#the-words),** and the loop looks at it
  before it reads a value. A turn that didn't answer stops the run with its reason.
- **The loop has a bound.** Three rounds, then it returns `approved: false` instead of going on.

The rest of this page builds that loop out, in
[`examples/site/guide/loops.ts`](https://github.com/romanlv/agentswf/blob/main/examples/site/guide/loops.ts)
and its test: who checks whom, what to do when a turn doesn't answer, how to bound the loop, and
what to carry from one round to the next.

## One agent checks another

Put the reviewer on another harness or model than the implementer, so it doesn't share the
implementer's blind spots: above, claude implements and codex reviews. The reviewer reads the
change in the working tree itself; the author's summary is context, not evidence.

- **Keep the reviewer from fixing.** Say so in its `instructions`, or open it in a
  [sandbox](/guide/sandboxes) without `write`, where it sees the working directory read-only.
- **Keep the verdict small.** A boolean and a list of changes is all the loop needs;
  [A typed answer](/guide/agents#a-typed-answer) has how the agent hands it back.
- **Several reviewers** are a [`parallel`](/guide/parallel) inside the round: one agent per lens,
  each on its own model, and the round approves when they all do.
- **A check that needs no agent,** such as routing a change before anyone works on it, can go to
  a [decision model](/guide/decisions).

## Branch on the outcome

`isAnswered(outcome)` is enough when every non-answer ends the loop the same way. When one
deserves another try, branch on `outcome.kind`. Each round starts with the implementer's turn:

<<< @/../examples/site/guide/loops.ts#branch

A `failed` or `timed-out` turn closes its agent, so the replacement is opened under a key of its
own, `implementer#2`, and starts with no session: its prompt gives it the task and the changes
still asked for. A missing login fails every agent on that harness alike, so the loop stops on it
rather than open another. Any other non-answer, and a second failure, stops the run with the
kind and the reason.

What each kind leaves of the agent, and what you usually do, is on
[Agents](/guide/agents#what-each-ending-means). How the loop ends is yours too: return a value
that says what happened, `return wf.stop(reason)` so the run can be continued, or let an error
throw and fail it; [Workflows](/guide/workflows#stopping-with-a-reason) has what each means for
the run.

## Bound the loop

<<< @/../examples/site/guide/loops.ts#bound

Two bounds, each doing a different job:

- **Rounds, in code.** A reviewer can always find something more. `ROUNDS` ends the loop, and
  the result says it wasn't approved and what is still open, for a person or the next workflow to
  pick up. Never write the loop as `while (true)`.
- **Time, per turn.** `timeoutMs` bounds a whole turn, and the turn ends `timed-out` when it
  passes. `awf run --timeout 2h` gives the whole run a deadline that every turn inside it
  inherits; [Deadlines](/guide/deadlines) has how they nest.

Without either, a turn whose agent stops without answering still ends: the engine nudges it, and
the turn ends `unanswered` if no answer comes. What nothing stops is a loop that keeps getting
answers.

In a run with [stages](/guide/runs#stages), the whole loop goes inside one stage. A continue then
redoes the loop from its first round.

## Carry feedback between rounds

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

- **A non-answer is not an exception.** `run` resolves to an outcome however the turn ended, so
  reading `outcome.value` before checking the kind doesn't type-check.
- **`unanswered` comes after a nudge.** The engine already asked the agent for its answer, so
  asking again in the same session is a choice, not a retry the engine skipped.
- **A replacement agent knows nothing.** Its prompt and the working tree are all it has.
- **Test every branch.** A scripted `reply.failed()`, `reply.timedOut()` or `reply.silent()`
  drives each one for free; the sample's
  [test](https://github.com/romanlv/agentswf/blob/main/examples/site/guide/loops.test.ts) covers
  approval, the bound, a replacement and a stop. [Testing](/guide/testing) has how.

## See also

- [Outcomes](/reference/workflow-api#outcomes) and
  [Sessions](/reference/workflow-api#sessions-talk-to-the-same-agent-again) in the workflow API.
- [Review loop](/patterns/review-loop), the pattern: implement, review, revise until approved.
