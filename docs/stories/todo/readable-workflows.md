---
title: A workflow reads as its process, not as its plumbing
summary: Compacting asks for an id and an absolute millisecond deadline, and the operator's ticket workflow spends its lines on timeouts and helpers; make the author surface let a workflow read as the steps a person would take.
type: story
status: todo
discovered_in: "story 015, the operator's review, 2026-10-01"
depends_on: []
---

# A workflow reads as its process, not as its plumbing

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
  with `timeoutMs` to bound it (ADR 0007, amended). The ticket workflow's helper above still builds
  its own deadline.
- Durations: `timeoutMs: 3 * 60 * MINUTE` beside `--timeout 10h` on the command line. A duration a
  person writes (`"3h"`) is a published type change to `run`, `enqueue` and `compact`.
- The ticket workflow: stages as named steps, timeouts where they matter, and no `Run` bag passed
  through helpers. Its tests (`workflow.test.ts`) say whether a rewrite kept its behaviour.
- `agent.fork` ([story 016](../016-fork.md)) already takes no deadline or id.
