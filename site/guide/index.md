---
title: Why agents.wf
description: "Code decides the steps, agents do the work, runs survive: who agents.wf is for, why not a black box, a shell loop or subagents, and when not to use it."
---

# Why agents.wf

If you use coding agents seriously, you already run workflows by hand. Write a design doc, have
an agent review it, review it again, build, review the build, write the tests. A few points need you:
setting direction, checking the agent understood. The rest a capable agent does well, if it is
prompted properly and another checks its work. Most of the time you are running the same skills in
the same order, and carrying results from one agent to the next.

agents.wf turns that process into code. Each part does what it is good at:

- **Code is deterministic.** The order, the loops, how many rounds, which agent on which model,
  and the deadlines are TypeScript you wrote. They are the same on every run, and you can read them
  in a minute.
- **Agents are creative.** Each step is a real coding agent, Claude Code, Codex, pi or Cursor,
  with its own skills and session, doing the work that needs judgment. It answers in a shape you
  chose, checked before your code sees it.
- **Runs are durable.** A workflow's finished stages are kept, so a crash or a stop costs only
  the stage that was running. A workflow with events waits days for a pull request, a timer or a
  person with no process left, and goes on where it left off.

Together they let you automate the work you now drive by hand, from one review loop to runs that
wake on events and work on their own.

<<< @/../examples/site/index.ts#loop

A claude agent implements the task, a codex agent reviews it, and the loop goes on until the
review approves, for three rounds at most. The reviewer's answer is checked against `VERDICT`
before your code sees it, so `outcome.value.approved` is a boolean, not a guess from prose. A
turn that ends without an answer says why, and the run stops on it.

## Who it is for

agents.wf is for people who want control over their agents and want to build agentic systems
themselves.

- **You want to decide how the work is done.** Which agent does what, on which model, how many
  times, with which skills, and when to stop.
- **You want to use the limits you already pay for.** Agents run on your own logins: Claude Code
  in a pane runs on your Claude subscription, with no API key and no credits to buy
  ([Harnesses](/guide/harnesses#subscription-and-metered)).
- **You want to know what works.** Each run records its time, tokens and an estimated cost per
  agent and model ([Cost](/guide/cost)), so variants of a workflow can be compared on your code.
- **You want to try how agents are organized:** a reviewer per lens, a verifier per finding,
  agents messaging each other, a person in the loop. You can do that without losing track of what
  each one did.

## Why not a black box

Coding agents keep gaining orchestration of their own, and hosted platforms run agents for you.
Both are a good start. They also choose the plan, the models and the limits, and you change them
only as far as their settings allow.

- **You can read the plan and change it.** It is a file in your repository, reviewed like any
  other code.
- **You can mix vendors.** A codex reviewer can check a claude implementer, with pi beside both,
  each on its own login. A harness awf doesn't drive yet can be
  [asked for](https://github.com/romanlv/agentswf/issues).
- **You can measure it.** Every run is recorded the same way, so two versions of a workflow can be
  compared on the same work.
- **You keep it.** It runs on your machine, and its records are plain files in your project. If a
  provider changes its terms or its prices, your workflow is still yours: you point an agent at
  another harness.

## Why not a loop over `claude -p`

A shell loop over a headless agent is where most people start, and it works for the first run.
What it lacks shows up on later ones:

- **The answer is prose, or nothing.** Your script parses text and hopes, and an agent that stops
  without answering looks like one still working. In a workflow the engine checks the answer
  against your schema, refuses a wrong shape while the agent can still fix it, nudges a quiet
  agent, and tells your code why a turn ended without an answer.
- **Nothing is left to read.** A run keeps [a record](/guide/how-it-works#the-record) in
  `.awf/runs`: its turns, what each agent did, and the time, tokens and estimated cost.
- **A stopped script starts over.** A run that stops part-way can be continued, reusing the
  stages that already finished ([Durability](/guide/durability)).
- **You can't watch it.** An agent in a pane runs in [Herdr](https://herdr.dev), where you see it
  work and can type to it. Headless is there when you want it ([Harnesses](/guide/harnesses)).
- **Testing it costs a run.** [`awf test`](/guide/testing) runs a workflow on scripted answers,
  through the real engine, with no agent started and nothing to pay.
- **Headless claude is metered,** even on a subscription login. A claude agent in a pane
  runs on your plan: [Harnesses](/guide/harnesses#subscription-and-metered) has the rule.

## Why not an agent's own subagents

Subagents are good when the agent should decide the plan: it splits the work as it goes, and the
results come back into its own context. For a one-off task in a session, that is often all you
need.

They fit less well when the process itself is what you want to keep:

- **The plan is the model's.** It may review twice today and skip the review tomorrow. In a
  workflow the order, the loop and its limit are code, the same on every run.
- **One harness.** Subagents run in the same tool as their parent. A workflow puts a codex
  reviewer on a claude implementer, or pi beside both, each on its own login.
- **Answers come back as text into one context,** which fills up as the work grows. A workflow
  gets each answer as a typed value, and each agent keeps its own session.
- **No record, no continue, no free test** of the orchestration, as above.

The two compose: typed in a coding agent's session, `awf run` starts a workflow, and the session
waits on it as on any command, or hands itself to the run
([Calling session](/guide/calling-session)).

## When not to use it

- **One agent, one task, one session.** Ask the agent; a workflow adds nothing.
- **You want the agent to choose the steps.** Use its own subagents.
- **You need a hosted service.** awf runs on your machine, with your agents' logins.

## Help shape it

agents.wf is in its evaluation phase, and what people build with it shapes the next release. If
you hit a bug, your use case is missing or the design gets in your way,
[open an issue](https://github.com/romanlv/agentswf/issues): say what you were building and where
awf stopped you.

## Next

[Install](/guide/install) `awf`, then follow the [quick start](/guide/quick-start): a first
workflow, its free test, and one real run.
