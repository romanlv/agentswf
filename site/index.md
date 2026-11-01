---
layout: home
title: agents.wf
description: Workflows for coding agents, in TypeScript, run by awf on the agent CLIs you already use.
hero:
  name: agents.wf
  text: Workflows for coding agents, in TypeScript.
  tagline: Hand work to Claude Code, Codex, pi or Cursor. Have one check another, loop until the reviewer is happy, and get typed answers back.
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
features:
  - title: Typed answers
    details: A schema in, a validated value or a reason out. Never prose to parse.
    link: /guide/agents
  - title: The agents you already use
    details: claude, codex, pi and cursor, on your own logins. Claude Code in a pane runs on your subscription.
    link: /guide/harnesses
  - title: Watch them work
    details: Each agent in a terminal pane in Herdr, a terminal multiplexer, that you can read and type into; or headless, as a plain process.
    link: /guide/harnesses
  - title: Runs that survive
    details: Every run has an id and named steps, its stages. A continue reuses the stages that finished, after a crash or a closed laptop.
    link: /guide/durability
  - title: Runs that wait
    details: A run can wait days for events sent to it, a timer or a person, with no process left running.
    link: /guide/events
  - title: Tested for free
    details: awf test runs a workflow on scripted answers. No agent starts, so nothing is billed.
    link: /guide/testing
---

```sh
bun add -g agentswf
```

## The code first

An implementer on claude, a reviewer on codex, and a loop until the reviewer's typed answer
approves. `DONE` and `VERDICT` are [TypeBox](https://github.com/sinclairzx81/typebox) schemas:
`{ summary }` and `{ approved, changes }`.

<<< @/../examples/site/index.ts#loop

The implementer works in a pane: a terminal pane in [Herdr](https://herdr.dev), a terminal
multiplexer, that you can read and type into, running on your Claude subscription. The reviewer
runs headless, as a plain process. [Harnesses](/guide/harnesses) has both.

Control flow is yours: `for`, `if`, `Promise.all`. The engine handles the agent that goes quiet,
answers in prose, or hangs.

## How it works

<!--@include: ./parts/how-it-works-diagram.md-->

`awf run ./workflow.ts` runs the workflow, prints its result, and keeps a record of the run in
`.awf/runs`. [How it works](/guide/how-it-works) has the rest.

## Built for agents to write

Point your coding agent at `agents.wf/llms.txt`. Every page is also served as Markdown, and the
whole [workflow API](/reference/workflow-api) is on one page. `awf init` writes an `AGENTS.md`
that tells the agent where the API is and what to run after a change: the typechecker and
`awf test`, which catch its mistakes before any agent starts. What it writes is agents, prompts,
schemas and plain `for` and `if`, so you can review it in a minute.
[Build with AI](/ai/) shows how.

## Where it is

- **Open source.** MIT licensed, on [GitHub](https://github.com/romanlv/agentswf).
- **Beta.** Interfaces change between versions. [Limits](/guide/limits) says what that means
  and what awf doesn't do.
- **What runs today and what is next:**
  [status](https://github.com/romanlv/agentswf/blob/main/docs/status.md).
- **How it is tested:** [the test levels](https://github.com/romanlv/agentswf/blob/main/docs/testing.md),
  from free to live agents. **What was measured:**
  [findings](https://github.com/romanlv/agentswf/tree/main/docs/findings).

## Your first workflow in 10 minutes

[The quick start](/guide/quick-start) takes you from install to a first run and its result.
