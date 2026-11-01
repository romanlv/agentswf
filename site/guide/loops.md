---
title: Loops
description: Loop until a reviewer approves, branch on how each turn ended, bound the loop, and carry feedback from one round to the next.
---

# Loops

A loop is how one agent checks another: an implementer works, a reviewer on another model reads
the change and answers with a typed verdict, and the implementer fixes what it found, until the
reviewer approves or you run out of rounds. In a workflow that is a plain `for`:

<<< @/../examples/site/index.ts#loop

Four things make it work:

- **Each agent keeps its session.** The implementer's second turn continues from its first, so
  the prompt says only what is new: the changes asked for.
- **The verdict is typed.** `outcome.value.approved` is a boolean the engine checked against
  `VERDICT`, so the `if` decides on a value, not on prose.
- **Every turn ends with an [outcome](/guide/how-it-works#the-words),** and the loop looks at it
  before it reads a value. A turn that didn't answer stops the run with its reason.
- **The loop has a bound.** Three rounds, then it returns `approved: false` instead of going on.

The rest of this page builds that loop out: who checks whom, what to do with each kind of
outcome, how to bound it, and what to carry from one round to the next. The full sample, with
its test, is
[`examples/site/guide/loops.ts`](https://github.com/romanlv/agentswf/blob/main/examples/site/guide/loops.ts).

## One agent checks another

Put the reviewer on another harness or model than the implementer, so it doesn't share the
implementer's blind spots: above, claude implements and codex reviews. The reviewer reads the
change in the working tree itself; the author's summary is context, not evidence.

- **Tell the reviewer not to fix.** Its `instructions` say so once, when it opens. To enforce it,
  open the reviewer in a [sandbox](/guide/sandboxes) without `write`: it sees the working
  directory, read-only.
- **Keep the verdict small.** A boolean and a list of findings is enough to loop on. An answer of
  up to six strings, numbers, booleans or enums can be given as flags to `wfa result`, which is
  easiest for the agent.
- **Several reviewers** are a [`parallel`](/guide/parallel) inside the round: one agent per lens,
  each on its own model, and the round approves when they all do.
  [`minimum-review`](https://github.com/romanlv/agentswf/tree/main/examples/minimum-review) runs
  a correctness and a maintainability lens at once, on claude and codex.

A check doesn't always need an agent. A [decision model](/guide/decisions) answers closed
questions with probabilities in about 200 ms, so a workflow can branch on it before it opens one:
[`triage`](https://github.com/romanlv/agentswf/tree/main/examples/triage) routes each ticket by
team, bug or not, and urgency, and flags every answer under 0.9 for someone to look at.

## Branch on the outcome

`isAnswered(outcome)` is enough when every non-answer ends the same way. When they shouldn't,
switch on `outcome.kind`:

<<< @/../examples/site/guide/loops.ts#branch

The kinds split by what is left of the agent afterwards:

| `kind` | The agent afterwards | A sensible branch |
| --- | --- | --- |
| `answered` | open | use `outcome.value` |
| `unanswered` | open; it was already checked in on once | stop, or ask again in the same session |
| `blocked` | open, showing a question only a person can answer | stop, so a person can look |
| `timed-out` | closed | a new agent under a new key |
| `failed` | closed | stop when `outcome.login` is set; else a new agent under a new key |
| `cancelled` | the run or its scope was stopped | stop |

**A failed or timed-out turn closes its agent.** Another `run` on it rejects with
`logical agent is closed`, and opening the same key returns that closed agent, so a replacement
gets a key of its own, `implementer#2` above. It starts with no session: the `handover` prompt
gives it the task and the findings still open. A missing login fails every agent on that harness
the same way, so the sample stops on it rather than open another.

How the run ends on a non-answer is yours too, and each says something different:

- **Return a value that says so**, `{ approved: false, … }`: the run completes, and its result
  carries what happened.
  [`minimum-review`](https://github.com/romanlv/agentswf/blob/main/examples/minimum-review/workflow.ts)
  keeps a lens that didn't answer as `{ kind: "incomplete", outcome, reason }`, so the other
  lens's findings still come back.
- **`return wf.stop(reason)`**: the attempt ends `stopped`, and `awf run --id {id} --continue`
  picks it up again. `wf.stop` never returns, so `return wf.stop(…)` type-checks wherever a value
  is expected, even inside a helper like `implement`.
- **`throw`**: the run fails.
  [`single-agent-review`](https://github.com/romanlv/agentswf/blob/main/examples/single-agent-review/workflow.ts)
  does this, as a review with no answer has nothing to return.

## Bound the loop

<<< @/../examples/site/guide/loops.ts#bound

Two bounds, each doing a different job:

- **Rounds, in code.** A reviewer can keep finding something. `MAX_ROUNDS` ends the loop, and
  the result says it wasn't approved and what is still open, for a person or the next workflow to
  pick up. Never write the loop as `while (true)`.
- **Time, per turn.** `timeoutMs` bounds a whole turn, check-ins included, and the turn ends
  `timed-out` when it passes. `awf run --timeout 2h` gives the whole run a deadline that every
  turn inside it inherits; [Deadlines](/guide/deadlines) has how they nest.

Without either, a stalled turn still ends: the engine checks in on a quiet agent and ends a turn
that stays stuck. What it can't stop is a loop that keeps getting answers.

In a run with [stages](/reference/workflow-api#stages), the whole loop goes inside one stage. A
continue then redoes the loop from its first round; [Runs](/guide/runs) has what a continue keeps.

## Carry feedback between rounds

<<< @/../examples/site/guide/loops.ts#loop

- **Send only what is new.** The implementer's session holds the task and its own earlier work,
  so a round's prompt is the findings, not the history.
- **Ask the reviewer about its own findings.** It keeps its session too, so from the second round
  it is told the author's answer and asked to check each finding, then the rest of the change.
- **Keep what matters in variables.** `open` lives in the workflow, not in an agent, so it
  survives a replaced agent, and it ends up in the result when the loop runs out of rounds.
- **Long loops grow the context.** Between rounds, `agent.compact({ prompt })` shrinks it with
  the harness's own compaction, keeping what the prompt names:
  [Compacting](/reference/workflow-api#compacting-keep-the-agent-shrink-its-context).

## Catches

- **A non-answer is not an exception.** `run` resolves to an outcome however the turn ended, so
  a loop that reads `outcome.value` without checking the kind first doesn't type-check.
- **`unanswered` has already had its second chance.** The engine checked in on the agent before
  giving up, so asking again in the same session is a choice, not a retry the engine skipped.
- **A replacement agent knows nothing.** Its prompt is all it has, along with the working tree.
- **Test every branch.** A scripted `reply.failed()`, `reply.timedOut()` or `reply.silent()`
  drives each one for free; the sample's
  [test](https://github.com/romanlv/agentswf/blob/main/examples/site/guide/loops.test.ts) covers
  approval, the bound, a replacement and a stop. [Testing](/guide/testing) has how.

## See also

- [Outcomes](/reference/workflow-api#outcomes) and
  [Sessions](/reference/workflow-api#sessions-talk-to-the-same-agent-again) in the workflow API.
- [Review loop](/patterns/review-loop), the pattern: implement, review, revise until approved.
