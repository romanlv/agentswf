---
title: Build with AI
description: Have a coding agent write your workflow from these docs, with typecheck and awf test as its safety net and your review as the last step.
---

# Build with AI

A workflow is a TypeScript file, so the coding agent you already use can write it. These docs are
written for it as much as for you: every page is also plain Markdown, and one index lists them
all.

```sh
awf init my-workflows
cd my-workflows
```

That sets up the folder the [Quick start](/guide/quick-start) walks through. Then, in it, ask your
agent for the workflow:

```text
Read https://agents.wf/llms.txt, then the Workflow API it links. Write a workflow in
review/ where a headless codex agent (gpt-6-luna) fixes the failing tests in the
directory the run works in, and a second one reviews the fix, at most three rounds.
Write its test. Run awf test and bun run check until both pass. Don't run the workflow.
```

The workflow lives in this folder and works on your project when you run it: `awf run`'s
`--cwd` sets the directory its agents work in ([below](#review-what-it-wrote)).

## What the agent reads

- **`/llms.txt`**, the index: what agents.wf is, the `AGENTS.md` below, and every page with a
  line saying what it covers.
- **A `.md` for every page.** Add `.md` to a page's URL: `/guide/quick-start.md`, and for a
  section's index, `/guide/index.md`. It is the page's Markdown with every code sample written
  out, so an agent reads the code, not a reference to it.
- **`/llms-full.txt`**, every page but the landing page in one file, for an agent that would
  rather read it all at once.

The [Workflow API](/reference/workflow-api) is one page on purpose: an agent gets every call,
option and outcome in one fetch.

## The rules it works by

`awf init` writes an `AGENTS.md` into the folder, for the agent that works in it:

````md
<!--@include: @/../packages/engine/src/init-template/AGENTS.md.template-->
````

Two of those rules are the safety net:

- **`bun run check`** typechecks. Every option, outcome and result schema is typed, so most of
  what an agent gets wrong about the API fails here.
- **`awf test`** runs the workflow's tests on scripted answers: each agent is replaced by the
  answers the test gives it, no agent starts and nothing is billed. An agent can run it as often
  as it likes. [Testing](/guide/testing) has how a test scripts its agents.

The third keeps the agent from starting real ones: it doesn't `awf run` unless you ask.

## Review what it wrote

Passing tests mean the workflow does what its test says, against the answers the test made up.
Before the first real run, read it for what only you can judge:

- **The runtimes.** Which harness and model each agent runs on decides what the run costs and
  which login it uses. An agent without `placement: "headless"` opens in a pane, which needs
  [Herdr](https://herdr.dev). awf refuses a headless claude agent without `metered: true`, your consent
  to per-token billing; check that the agent set it because you meant it.
- **The loops.** Every loop needs a limit, and every turn's outcome needs handling: a turn can end
  without an answer, and `outcome.reason` says why ([Outcomes](/reference/workflow-api#outcomes)).
- **The prompts and schemas.** They are the agents' whole brief. A schema that is too loose lets
  a vague answer through as a valid one.
- **The test.** Check that it scripts the unhappy path too: a reviewer that never approves, an
  agent that doesn't answer.

Then run it yourself, on your project, and read what it did:

```sh
awf run review/workflow.ts --cwd ../my-project
awf logs --cwd ../my-project
```

## Next

- [Agents](/guide/agents) and [Workflows](/guide/workflows): what the agent wrote, so you can
  review it.
- [Following runs](/guide/following-runs): `awf logs` and `awf runs`, for you or another agent.
- [The workflow API](/reference/workflow-api): the page the agent reads.
