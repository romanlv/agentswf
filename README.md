# agentswf

**Write workflows for coding agents in TypeScript.** Hand work to the coding agents you already use,
run them side by side, have one check another, loop until a reviewer is happy, and get typed
answers back. `awf` runs the workflow and handles the parts that make agent scripts fragile:
agents that never answer, answer in prose, hang, or quietly run up a bill.

```ts
const reviewer = await wf.agents.open({
  key: "reviewer",
  runtime: { harness: "codex", model: "gpt-6-luna" },
});
const { outcome } = await reviewer.run({
  prompt: "Review `git diff main`.",
  schema: FINDINGS,
});
// The answer is validated against FINDINGS, or outcome says why there is none.
if (outcome.answered) console.log(outcome.value.findings);
```

## Why

If you use coding agents seriously, you already run workflows by hand: one agent implements,
another reviews, and you paste the findings back. Scripting that is easy until an agent goes
quiet, answers in the wrong shape, or a run costs ten times what you expected.

agentswf keeps the workflow in code you own and moves the unreliable parts into the engine. It
drives the agent CLIs you already use, logged in as you already are: claude, codex, pi or cursor.

## How it works

1. Your code calls `agent.run({ prompt, schema })`.
2. awf hands the prompt to a coding agent, in a [Herdr](https://herdr.dev) pane you can watch or
   headless.
3. The agent works in your repo with its own tools and skills, then answers by running
   `wfa result`.
4. awf checks the answer against your schema. A wrong shape goes back to the agent to fix; a quiet
   agent gets a nudge.
5. `await` returns a typed value, and your code decides what happens next.

Control flow is plain TypeScript: `for`, `if`, `Promise.all`.

## What you get

- **Typed answers, checked.** A turn ends `answered`, with JSON that fits its schema, or with a
  reason: `unanswered`, `blocked`, `timed-out`, `failed` or `cancelled`.
- **Mix harnesses and models.** A codex reviewer checks a claude implementer; a cheap model
  triages before an expensive one works.
- **Long-lived sessions.** An agent keeps its context from turn to turn; `compact` and `fork` it.
- **Stages you can continue.** A run that stops part-way goes on from the stage that stopped.
- **Cost on every run.** Time, tokens and an estimated cost per agent, stage and model.
- **Sandboxes, messaging, events.** docker or srt limits what agents reach, agents message each
  other on routes you grant, and a run can wait for an event for weeks without a process running.
- **Fast decisions.** Closed questions to a decision model come back with a probability per
  answer in about 200 ms, for routing and triage without a coding agent.
- **Free tests.** `agentswf/testing` runs a workflow on scripted agents; no agent starts.

## Quick start

You need [Bun](https://bun.sh) 1.4 or later, git, and at least one agent CLI you're logged in to.

```sh
bun add -g agentswf         # puts awf in ~/.bun/bin
mkdir ~/workflows && cd ~/workflows
awf init                    # a hello workflow, its test, and the config files
awf test                    # its test, on scripted agents
awf run hello/workflow.ts   # one real agent
```

```ts
// hello/workflow.ts
import { typed } from "agentswf/typebox";
import { defineWorkflow } from "agentswf/workflow";
import Type from "typebox";

export const ANSWER = typed(Type.Object({ answer: Type.Integer() }, { additionalProperties: false }));

export default defineWorkflow({
  meta: { name: "hello", description: "Ask one agent a question with a known answer." },
  async run(wf) {
    const agent = await wf.agents.open({
      key: "hello",
      runtime: { harness: "codex", model: "gpt-6-luna", placement: "headless" },
    });
    const { outcome } = await agent.run({
      prompt: "What is 17 multiplied by 23? Work it out yourself; do not run any code.",
      schema: ANSWER,
      timeout: "3m",
    });
    return outcome.answered ? outcome.value : { unanswered: outcome.reason };
  },
});
```

`awf run` prints the run's time, tokens and cost, then its result, `{ "answer": 391 }`. The record
stays in `.awf/runs/hello/{id}`; `awf runs` and `awf logs` show what it did. `awf -h` lists every
command.

### Things to know

- **TUI agents**, the default, need Herdr. Headless agents don't.
- **Claude runs on your Claude plan, in its TUI or headless.** `claude -p` draws on the plan's
  limits like the TUI does.
- **Sandboxes** need `srt` or docker.
- **A workflow file is trusted code.** It runs with your permissions; sandbox the agents, not the
  workflow.

## Continuing a run

A run that stops says how to go on:

```
■ stopped in qa: the mr environment never came up
  go on    awf run ticket.ts --id PROJ-1515 --continue
```

Fix the code, a prompt or the environment, and run it again. Stages that succeeded are reused
without asking any agent; the one that stopped runs again, and so does everything after it.

## Examples

| Example | What it shows |
| --- | --- |
| [`quick-check`](examples/quick-check/) | one known-answer question per harness |
| [`minimum-review`](examples/minimum-review/) | two reviewers in parallel |
| [`catalogue-review`](examples/catalogue-review/) | many lenses, a verifier per finding |
| [`feature-delivery`](examples/feature-delivery/) | plan, implement, review, revise, as stages |
| [`messaging`](examples/messaging/) | a reviewer asks an implementer for a fix |
| [`sandboxes`](examples/sandboxes/) | a shared docker sandbox and a private srt one |
| [`triage`](examples/triage/) | typed decisions with probabilities |

Every call a workflow can make is in [the workflow API](https://agents.wf/reference/workflow-api).

## Contributing

```sh
bun install && bun test   # no live agents, no cost
bun run check             # lint, format, types and package boundaries
```

[`AGENTS.md`](AGENTS.md) covers working in this repository with a coding agent.

MIT licensed: see [`LICENSE`](LICENSE).
