---
layout: home
title: agents.wf
description: "Repeatable workflows for coding agents: TypeScript fixes the steps, real coding agents do the thinking, and runs are durable and event-driven."
hero:
  name: agents.wf
  text: Repeatable workflows for coding agents.
  tagline: Coding agents that follow your process. TypeScript fixes the steps, the agents do the thinking, and runs are durable and event-driven. Your workflow is your code, not a feature of someone's platform.
  actions:
    - theme: brand
      text: Get started
      link: /guide/quick-start
    - theme: alt
      text: Why agents.wf
      link: /guide/
    - theme: alt
      text: GitHub
      link: https://github.com/romanlv/agentswf
# The cards come after the install line, in the body, rather than before it as `features` would.
cards:
  - title: Deterministic where it counts
    details: The order, the loops, how many rounds and the deadlines are code you wrote, the same on every run. Every answer is checked against your schema before your code sees it.
    link: /guide/agents#a-typed-answer
  - title: Real agents do the thinking
    details: Real coding agents, with their own skills and sessions, do the work that needs judgment. An agent keeps its context across turns, and can fork to try another angle.
    link: /guide/agents#compact-switch-fork
  - title: Durable and event-driven
    details: A failed CI check, a webhook or a timer starts or wakes a run, which parks in between with no process left. Finished stages are kept, so a crash costs only the stage that was running.
    link: /guide/events
  - title: Yours
    details: It runs on your machine, on your own logins and plan limits, and keeps its records as plain files in your project. MIT. No hosted service sits between you and your agents.
    link: /guide/harnesses#subscription-and-metered
  - title: Measurable
    details: Every run records each agent's turns, time and tokens. Swap a model, a prompt or a skill, and compare the runs.
    link: /guide/cost
  - title: Written by your agent
    details: A frontier model writes the workflow, cheaper ones can run it. The typechecker and awf test, which runs it on scripted answers for free, catch its mistakes before any agent starts.
    link: /guide/quick-start#have-your-agent-write-the-next-one
---

<script setup>
import { VPFeatures } from "vitepress/theme";
</script>

```sh
bun add -g agentswf
```

<VPFeatures :features="$frontmatter.cards" />

## Code decides, agents think

An implementer on claude, a reviewer on codex, and a loop until the reviewer's typed answer
approves. `DONE` and `VERDICT` are [TypeBox](https://github.com/sinclairzx81/typebox) schemas:
`{ summary }` and `{ approved, changes }`.

<<< @/../examples/site/index.ts#loop

The loop and its limit are code; the reviewer's verdict is a checked boolean, not a guess from
prose. The implementer works in a pane in [Herdr](https://herdr.dev), a terminal multiplexer,
where you can watch it and type to it; Herdr is optional, and every agent can run headless
instead. The engine handles an agent that goes quiet, answers in the wrong shape, or hangs.
[Why agents.wf](/guide/) says what this is for.

## From hand-run to automated

- **By hand:** you prompt one agent, paste its output to another, and decide when it's done.
- **A workflow:** `awf run review-loop.ts` runs the same steps every time and records each turn.
  If a workflow with [stages](/guide/durability) stops part-way, a continue reuses the stages
  that finished.
- **On its own:** a workflow with [events](/guide/events) gets a run per pull request. Your CI or
  a webhook sends it events, `awf tick` on a schedule brings timers due
  ([Hosting events](/guide/hosting-events)), and between them the run parks. A
  [person](/guide/people) can answer it in the terminal, or through a chat app or script you
  connect.

## How it works

<!--@include: ./parts/how-it-works-steps.md-->

`awf run ./workflow.ts` runs the workflow, prints its result, and keeps a record of the run in
`.awf/runs`. [How it works](/guide/how-it-works) has the rest.

## Built for agents to write

Your coding agent writes the workflow. Every page here is also Markdown for it to read, and the
[API](/reference/workflow-api) is one page. After a change it runs the typechecker and `awf test`,
which catch its mistakes before any agent starts. What it writes is agents, prompts, schemas and
plain `for` and `if`, so you can review it in a minute: [Quick start](/guide/quick-start#have-your-agent-write-the-next-one)
says what to check.

Write the workflow with a frontier model, then run it on cheaper or open-weight ones: each agent's
model is one line, and [Cost](/guide/cost) shows what the change did to a run.

## Open, and shaped by use

- **Open source.** MIT licensed, on [GitHub](https://github.com/romanlv/agentswf).
- **In its evaluation phase.** The design is still moving, and what people build with it decides
  where it goes. Hit a bug, missing a use case, or have a better idea for the design?
  [Open an issue](https://github.com/romanlv/agentswf/issues).
- **What runs today and what is next:** [status](https://github.com/romanlv/agentswf/blob/main/docs/status.md).
- **How it is tested:** [the test levels](https://github.com/romanlv/agentswf/blob/main/docs/testing.md),
  from free to live agents. **What was measured:** [findings](https://github.com/romanlv/agentswf/tree/main/docs/findings).

## Your first workflow

[The quick start](/guide/quick-start) takes you from install to a first run and its result.
