---
title: A workflow reads as its process, not as its plumbing
type: story
status: todo
priority: P1
discovered_in: "story 015, the operator's review, 2026-10-01"
depends_on: []
---

# A workflow reads as its process, not as its plumbing

The operator's ticket workflow spends its lines on timeouts, millisecond durations and helpers; make
the author surface let a workflow read as the steps a person would take.

Why it matters: the operator's review of the ticket workflow
(`~/dev/braintrust/agent/workflows/implement-ticket/workflow.ts`):

```ts
const outcome = await run.worker.compact({
  id,
  prompt: focus,
  deadline: {
    unixMilliseconds: Math.min(run.workflow.deadline.unixMilliseconds, Date.now() + TIMEOUT.compact),
  },
});
```

> this is ugly … make sure those workflows should be readable by humans, and who needs millisecond
> deadline? why does it need deadline at all?
>
> try to make this workflow more readable, so human can focus on the process and not the code

What to settle:

- Done: `compact({ prompt })` takes `run`'s defaults, a generated id and the workflow's deadline,
  with `timeoutMs` to bound it (ADR 0007, amended). The ticket workflow's helper now calls
  `compact({ id, prompt, timeoutMs })`.
- Durations: `timeoutMs: 3 * 60 * MINUTE` beside `--timeout 10h` on the command line. A duration a
  person writes (`"3h"`) is a published type change to `run`, `enqueue` and `compact`.
- The ticket workflow: stages as named steps, timeouts where they matter, and no `Run` bag passed
  through helpers. Its tests (`workflow.test.ts`) say whether a rewrite kept its behaviour.
- `agent.fork`, as [story 016](../016-fork.md) designs it (a draft, not built), takes no deadline
  or id.
