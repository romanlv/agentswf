---
title: Why agents.wf
description: The problem agents.wf solves, who it is for, when not to use it, and why not a shell loop or an agent's own subagents.
---

# Why agents.wf

If you use coding agents seriously, you already run workflows by hand. One agent implements and
another reviews, and you paste the findings back. Three agents review the same change and you
cross-check what they found. A cheap model triages before an expensive one works.

agents.wf turns that process into a TypeScript file you run with `awf run`. The control flow is
yours: `for`, `if`, `Promise.all`. The engine handles the parts that make agent scripts fragile:
an agent that goes quiet, answers in prose instead of the shape you asked for, or hangs.

<<< @/../examples/site/index.ts#loop

A claude agent implements the task, a codex agent reviews it, and the loop goes on until the
review approves, for three rounds at most. The reviewer's answer is checked against `VERDICT`
before your code sees it, so `outcome.value.approved` is a boolean, not a guess from prose. A
turn that ends without an answer says why, and the run stops on it.

## Who it is for

- **You already hand work between agents** and want to write the process once, then run it again
  on the next change.
- **You want to know which setup works for your code.** Swap a harness, a model, a prompt or a
  skill, and compare runs: each run records its time, tokens and an estimated cost per agent and
  model ([Cost](/guide/cost)).
- **You want to try how agents are organized,** a reviewer per lens, a verifier per finding, one
  agent asking another, without losing track of what each one is doing.

## Why not a loop over `claude -p`

A shell loop over a headless agent is where most people start, and it works for the first run.
What it lacks shows up on later ones:

- **The answer is prose.** Your script parses text and hopes. In a workflow the engine checks
  the agent's answer against your schema, and a wrong shape is refused while the agent can still
  fix it.
- **Silence looks like work.** An agent that stops without answering just ends, or never does.
  The engine nudges a quiet agent, stops a stalled turn, and tells your code why a turn ended
  without an answer.
- **Nothing is left to read.** A run keeps [a record](/guide/how-it-works#the-record) in
  `.awf/runs`: its turns, what each agent did, and the time, tokens and estimated cost.
- **A stopped script starts over.** A run that stops part-way can be continued, reusing the
  steps that already succeeded ([Durability](/guide/durability)).
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
you hit a bug, your use case is missing or the design gets in your way, [open an issue](https://github.com/romanlv/agentswf/issues): say what you
were building and where awf stopped you.

## Next

[Install](/guide/install) `awf`, then follow the [quick start](/guide/quick-start): a first
workflow, its free test, and one real run.
