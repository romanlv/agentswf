---
title: Parallel
description: "Running agents side by side with wf.parallel: fan out, a concurrency limit, results in item order, fan in, and what happens when one fails."
---

# Parallel

Several agents can work at once: three reviewers each looking for one kind of problem, a verifier
per finding, one implementer per package. `wf.parallel` runs a function over a list of items
with a concurrency limit and a deadline, shows the group in the progress view, and gives the
results back in the order of the items.

## Fan out, fan in

<<< @/../examples/site/guide/parallel.ts#fan-out

Each item gets its own agent, keyed by its lens, and its own turn. Two run at a time; the third
starts when one finishes. `reviews` has one entry per lens, in the order of `LENSES`, whichever
finished first.

Fanning in is plain code over that array:

<<< @/../examples/site/guide/parallel.ts#fan-in

The whole workflow is in
[`examples/site/guide/parallel.ts`](https://github.com/romanlv/agentswf/blob/main/examples/site/guide/parallel.ts),
with its test beside it.

## The options

```ts
wf.parallel(items, (item, index) => …, { concurrency?, label?, deadline? })
```

- **`concurrency`** is how many items run at once. It defaults to all of them, and must be a
  positive integer. Each call has its own limit, so a `parallel` of 4 inside a `parallel` of 3
  can have 12 agents working.
- **`label`** names the group in the run's [progress view](/guide/following-runs), where it shows
  as `lenses 0/3 · 1 queued` while the first two work, then `lenses 1/3`, with how many of its
  agents failed. An unlabelled `parallel` inside a labelled one counts as part of it.
- **`deadline`**, `{ unixMilliseconds }`, bounds the whole group. It can only be earlier than the
  one around it, the run's included; a later one is ignored. [Deadlines](/guide/deadlines) covers
  how they nest.

## When the deadline passes

When the group's deadline passes, its own or the run's, the turns still running end `timed-out`,
and `parallel` rejects with `DeadlineExceededError`, which you import from `agentswf/workflow`.
The results of the branches that had already finished are dropped with it: `parallel` returns all
of its results or none.

To keep what finished, bound each turn instead of the group, with `timeoutMs` on `agent.run`. A
turn that runs out then ends with the outcome `timed-out`, which the branch returns as data, as
the fan-out above does.

The function gets each item and its index. An empty list resolves to `[]` at once.

## When one fails

An agent that doesn't answer is not an error. Its turn ends with an [outcome](/guide/how-it-works)
such as `failed` or `timed-out`, and `run` resolves with it. So the fan-out above keeps going when
a reviewer fails: that lens comes back with no findings and a reason, the others with theirs.

A branch that throws is different. `parallel` is fail-fast:

<<< @/../examples/site/guide/parallel.ts#strict

When one branch throws, `parallel` cancels the turns still running in the others (they end
`cancelled`), starts no more items, waits for those turns to end, and then rejects with that
first error. The results of the branches that had finished are lost with it.

So choose per workflow. Return the outcome as data when the other agents' work is still worth
having, as the fan-out above does. Throw when one missing answer makes the rest pointless. To keep
going past a throw from your own code, such as opening an agent, catch it inside the branch and
return it as data. In
[`catalogue-review`](https://github.com/romanlv/agentswf/blob/main/examples/catalogue-review/workflow.ts),
an outcome without an answer and a caught error each become an entry in the result's `failures`.

## Catches

- **Give each branch its own agent key.** Opening a key that is already open returns the same
  agent, and an agent takes one turn at a time, so branches that share one wait for each other.
- **Await what a branch starts.** `parallel` resolves only once every turn started inside it has
  settled, and its deadline bounds them too. Work started from a branch after its `parallel` has
  resolved is refused.
- **A `parallel` goes inside a stage, not stages inside a `parallel`.** A run has one stage open
  at a time, so parallel branches can't each enter one. See [Runs](/guide/runs).
- **`Promise.all` works too**, since control flow is plain TypeScript. It has no limit, no
  deadline and no progress line, and when one promise rejects, the others keep running.
- **It nests.** A verifier per finding, fanned out inside each lens's branch or after the lenses
  are in, is a `parallel` inside or after a `parallel`; `catalogue-review` does the second.

## Testing it

A test scripts each agent by key, so branches are read by key, not by position. To check that
results keep item order, make the first item's answer wait for the last's, as the
[sample's test](https://github.com/romanlv/agentswf/blob/main/examples/site/guide/parallel.test.ts)
does. [Testing](/guide/testing) covers the rest.

## See also

- [`parallel` in the API reference](/reference/workflow-api#parallel)
- [Loops](/guide/loops): one agent checks another, round after round
- [`examples/catalogue-review`](https://github.com/romanlv/agentswf/tree/main/examples/catalogue-review):
  lenses chosen by the files a diff touches, each finding verified by its own agent
