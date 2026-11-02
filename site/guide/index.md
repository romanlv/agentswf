---
title: Why agents.wf
description: "Repeatable workflows for coding agents: your process in code, agents for the judgment, durable and event-driven runs, and a workflow that stays yours."
---

# Why agents.wf

Some work you do again and again, at work or at home: fix a failed build, update a dependency,
triage issues, file receipts. An agent can do each step, but it won't keep to the process.
agents.wf makes the process code, and agents follow it:

- **Code is deterministic.** The order, the loops, how many rounds, which agent on which model,
  and the deadlines are TypeScript you wrote. They are the same on every run, and you can read them
  in a minute.
- **Agents are creative.** Each step is a real coding agent, the one you already use, with its own
  skills and session, doing the work that needs judgment. It answers in a shape you chose, checked
  before your code sees it.
- **Runs are durable.** A workflow's finished stages are kept, so a crash or a stop costs only the
  stage that was running.
- **Runs are event-driven.** A run waits patiently, for days if it has to, until something
  happens: a failed check, a timer, a person's answer. Nothing runs in between, and it goes on
  where it left off ([Events](/guide/events)).

<<< @/../examples/site/index.ts#loop

A claude agent implements the task, a codex agent reviews it, and the loop goes on until the review
approves, for three rounds at most. The reviewer's answer is checked against `VERDICT` before your
code sees it, so `outcome.value.approved` is a boolean, not a guess from prose. A turn that ends
without an answer says why, and the run stops on it.

## Your workflow, not a platform's

Coding agents keep gaining orchestration of their own, and hosted platforms run agents for you.
Both choose the plan, the models and the limits, and you change them only as far as their settings
allow.

Models are becoming a commodity. The lab that leads today may not lead next year, and the best
agent for review may not be the best for building. What lasts is your process: which steps, in what
order, who checks whom. agents.wf keeps that in your code, so it outlives any one vendor.

- **You read the plan and change it.** It is a file in your repository, reviewed like any other
  code.
- **You mix vendors.** A codex reviewer checks a claude implementer, each on its own login. A
  harness awf doesn't drive yet can be [asked for](https://github.com/romanlv/agentswf/issues).
- **You use the limits you already pay for.** Agents run on your own logins: Claude Code in a pane
  runs on your Claude subscription, with no API key and no credits to buy
  ([Harnesses](/guide/harnesses#subscription-and-metered)).
- **You measure it.** Each run records the time, tokens and an estimated cost per agent and model
  ([Cost](/guide/cost)), so two versions of a workflow can be compared on the same work.
- **You keep it.** It runs on your machine, and its records are plain files in your project. When a
  better model ships, or a provider changes its terms, you change an agent's model, not your
  workflow.

## Who it is for

People who want control over their agents and build agentic systems themselves: a job that fixes
CI while you sleep, a weekly digest, agents checking each other's work, a person in the loop where
it matters. You decide which agent does what, how many times, with which skills, and when to stop,
and you can always see what each one did.

## Compared with what you have

**A loop over `claude -p`** is where most people start, and it works for the first run. What it
lacks shows up on later ones:

- **The answer is prose, or nothing.** Your script parses text and hopes, and an agent that stops
  without answering looks like one still working. A workflow checks the answer against your schema,
  refuses a wrong shape while the agent can still fix it, nudges a quiet agent, and tells your code
  why a turn ended without an answer.
- **Nothing is left to read, and a stop starts over.** A run keeps
  [a record](/guide/how-it-works#the-record) of its turns, and a stopped run can be continued,
  reusing the stages that finished ([Durability](/guide/durability)).
- **You can't watch it or test it.** An agent in a pane runs in [Herdr](https://herdr.dev), where
  you see it work and can type to it. [`awf test`](/guide/testing) runs a workflow on scripted
  answers, with no agent started and nothing to pay.
- **Headless claude is metered,** even on a subscription login. A claude agent in a pane runs on
  your plan.

**An agent's own subagents** are good when the agent should decide the plan: it splits the work as
it goes, and the results come back into its own context. For a one-off task in a session, that is
often all you need. They fit less well when the process is what you want to keep:

- **The plan is the model's,** not the same on every run.
- **One harness.** Subagents run in the same tool as their parent.
- **Answers come back as text into one context,** which fills up as the work grows. A workflow gets
  each answer as a typed value, and each agent keeps its own session.

The two compose: typed in a coding agent's session, `awf run` starts a workflow, and the session
waits on it as on any command, or hands itself to the run ([Calling session](/guide/calling-session)).

## When not to use it

- **One agent, one task, one session.** Ask the agent; a workflow adds nothing.
- **You want the agent to choose the steps.** Use its own subagents.
- **You need a hosted service.** awf runs on your machine, with your agents' logins.

## Help shape it

agents.wf is in its evaluation phase, and what people build with it shapes the next release. If you
hit a bug, your use case is missing or the design gets in your way,
[open an issue](https://github.com/romanlv/agentswf/issues): say what you were building and where
awf stopped you.

## Next

[Install](/guide/install) `awf`, then follow the [quick start](/guide/quick-start): a first
workflow, its free test, and one real run.
