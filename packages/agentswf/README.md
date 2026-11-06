# agentswf

**Write workflows for coding agents in TypeScript.** Hand work to the coding agents you already
use, run them side by side, have one check another, loop until a reviewer is happy, and get typed
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

## How it works

1. Your code calls `agent.run({ prompt, schema })`.
2. awf hands the prompt to a coding agent, in a [Herdr](https://herdr.dev) pane you can watch or
   headless.
3. The agent works in your repo with its own tools and skills, then answers by running
   `wfa result`.
4. awf checks the answer against your schema. A wrong shape goes back to the agent to fix; a quiet
   agent gets a nudge.
5. `await` returns a typed value, and your code decides what happens next.

It drives the agent CLIs you already use, logged in as you already are: claude, codex, pi or
cursor. Control flow is plain TypeScript: `for`, `if`, `Promise.all`.

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
- **Free tests.** `agentswf/testing` runs a workflow on scripted agents; no agent starts.

## Install

You need [Bun](https://bun.sh) 1.4 or later, git, and at least one agent CLI you're logged in to.

```sh
bun add -g agentswf   # puts awf in ~/.bun/bin
awf --version
```

## Your first workflow

```sh
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

`awf run` prints a line on time, tokens and estimated cost, then the run's record as JSON, its
`value` `{ "answer": 391 }`; a workflow's `present` prints something shorter instead. The record
stays in `.awf/runs/hello/{id}`; `awf runs` and `awf logs` show what it did.

## What this package gives you

| Entry | For |
| --- | --- |
| `awf` | the command: run, test, follow and continue workflows |
| `agentswf/workflow` | what a workflow imports: `defineWorkflow`, the `wf` context |
| `agentswf/typebox` | `typed`, to turn a TypeBox schema into an answer schema |
| `agentswf/testing` | run a workflow on scripted agents in its tests |
| `agentswf/client` | drive runs from your own program |

## Learn more

- [Guide](https://agents.wf/guide/) and [quick start](https://agents.wf/guide/quick-start)
- [Workflow API](https://agents.wf/reference/workflow-api), every call on one page
- [Patterns](https://agents.wf/patterns/review-loop): review loops, plan and implement
- [Examples and design](https://github.com/romanlv/agentswf), in the repository
- [Changelog](https://github.com/romanlv/agentswf/blob/main/CHANGELOG.md): what changed in each release
