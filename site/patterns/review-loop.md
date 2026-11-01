---
title: Review loop
description: "Implement, review, revise until approved: a reviewer that knows the rules checks the work itself and asks the implementer for each fix by message."
---

# Review loop

**The problem:** an agent writes code, and you want a second agent to check it against rules the
first wasn't given, and have it fixed until it passes, without a person relaying feedback.

**The workflow:**
[`examples/messaging`](https://github.com/romanlv/agentswf/tree/main/examples/messaging). An
implementer writes `slugify()` in a fresh folder. A reviewer that knows a house style for slugs
runs the code on three titles, messages the implementer the fixes it needs, waits for each, and
runs the code again. The workflow then checks the reviewer's slugs against the known answers.

From a clone of the repository, after `bun install`:

```sh
bun awf run examples/messaging/workflow.ts            # both agents on codex
bun awf run examples/messaging/workflow.ts -- claude-pane
```

**Cost and time:** a recorded run on codex's `gpt-6-luna`, both agents headless, took 50 s: the
implementer's turn, the reviewer's, and one revision the reviewer asked for by message. The
estimate at list prices is about $0.01. Codex runs on a ChatGPT subscription, so that prices the
tokens, it isn't a bill: [Cost](/guide/cost) has where the estimate comes from.

That run is also why the workflow checks the reviewer's work. It printed:

```text
not approved after 1 revision by message; code in /tmp/awf-messaging/20261012-2309-a2e5
wrong  "Hello, World!" -> hello-world
wrong  "  Crème Brûlée Recipes " -> creme-brulee-recipes
wrong  "awf 2.0: Agents Talk" -> awf-2-0-agents-talk
```

The reviewer asked for a fix once and returned without approving; the slugs it got on its last
run still used hyphens. The result says so plainly, instead of a run that looks finished.

## The workflow

<<< @/../examples/messaging/workflow.ts#run

The whole file, with its runtimes, schemas and argument parsing, is
[`workflow.ts`](https://github.com/romanlv/agentswf/blob/main/examples/messaging/workflow.ts), and
its test is [`workflow.test.ts`](https://github.com/romanlv/agentswf/blob/main/examples/messaging/workflow.test.ts).

## Why it's shaped this way

- **The reviewer owns the loop.** The code makes two calls: one turn for the implementer, one for
  the reviewer. Each round of review and fix happens inside the reviewer's turn: it runs
  `wfa send --await-reply implementer` with the fixes, ends its turn, and the implementer's reply
  starts its next one. Your code doesn't count rounds or carry findings between prompts; the
  reviewer keeps them in its session. [Messaging](/guide/messaging) has how a route works.
- **The route is the bound.** `wf.messages.allow` lets only the reviewer start a message, and
  `maxMessages: 4` caps the conversation, replies included: two rounds of fix and answer. Past
  that the reviewer can't ask again and has to return what it has.
- **The reviewer knows what the implementer doesn't.** The house style is in the reviewer's
  `instructions` only. A reviewer that holds the acceptance criteria, ideally on another model,
  doesn't share the implementer's blind spots.
- **The reviewer checks evidence, not prose.** It runs the code and reports the slugs it got. The
  workflow then compares them with `CASES` itself, so `approved` is the reviewer's opinion and
  `checks` is the fact, and a wrong slug the reviewer let through still shows `wrong`.
- **Every turn's outcome is checked.** A turn that didn't answer stops the run with its reason
  rather than reading a value that isn't there.
- **The record says what happened.** `revisions` counts the implementer's turns that a message
  started, read from `wf.usage()`, so the result shows how many rounds it took.

## When to write the loop in code instead

The loop can live in your workflow instead: a `for` that runs the implementer, asks the reviewer
for a typed verdict, and sends the findings back, up to a number of rounds.
[Loops](/guide/loops) builds that one. Choose it when:

- the reviewer's harness or placement can't wait for a reply (a reviewer here must be one that
  can, which is why the example runs both agents headless or claude in a pane);
- your code needs each round's findings, to log, gate or show them;
- each round should be a fresh reviewer, or several reviewers in [`parallel`](/guide/parallel).
  [`minimum-review`](https://github.com/romanlv/agentswf/tree/main/examples/minimum-review) is
  that review step on its own: a correctness and a maintainability lens at once, claude and
  codex, each answering with typed findings.

## Catches

- **An approval is a claim.** Check what you can in code, as `checks` does here. Where you can't,
  have the reviewer report evidence (commands run, their output), not a verdict alone.
- **A review step in a larger run** wants its route granted inside a stage, so the conversation
  ends with the stage. [Plan, implement, review](/patterns/plan-implement) does that twice.
- **A loop can end unapproved.** With a bound, it has to. Give the result a field that says so,
  and what is still open, for a person or the next workflow.
- **Messages cost turns.** Each message the reviewer sends starts an implementer turn, so
  `maxMessages` bounds the cost as well as the rounds.

## See also

- [Messaging](/guide/messaging) and [Loops](/guide/loops) in the guide.
- [Messaging](/reference/workflow-api#messaging) and
  [Outcomes](/reference/workflow-api#outcomes) in the workflow API.
