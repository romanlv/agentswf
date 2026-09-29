# agents.wf

An engine for **workflows made of coding agents**. A workflow is ordinary TypeScript: it opens
agents, gives them work, waits for structured answers, and composes the results. The agents are
real terminal coding agents — claude, codex, pi, cursor — driven through one run host the operator
chooses. Herdr is the current host; it is not part of the workflow interface.

The distinguishing constraint is that the workers are non-deterministic processes that bill
money and sometimes fail to answer. That is not a normal task queue, and it drives the design.

**agents.wf is an early preview.** Its interfaces will change, and nothing is on npm yet: you
install it from a clone.

## Names

- **agents.wf** is the project. `agentswf` is its GitHub organisation, and will be its npm
  package.
- **`awf`** is the command you run, agents.wf's initials. What it keeps is named after it:
  `~/.awf/runs`, the `AWF_*` variables.
- **`wf`**, short for workflow, is the command an agent runs inside its session.
- **`agentswf/workflow`** is what a workflow imports.
- **`@agentswf/*`** are the packages in this repository, each named for its directory.

## Install

You need [Bun](https://bun.sh) 1.4 or later, git, and at least one agent CLI you are logged in to:
claude, codex, pi or cursor.

```sh
git clone git@github.com:agentswf/awf.git ~/.agentswf
cd ~/.agentswf && bun install
(cd packages/engine && bun link)   # puts awf in ~/.bun/bin
awf --version
```

`bun link` puts `awf` in Bun's own bin directory, `~/.bun/bin`, which Bun's installer adds to your
PATH. If `awf` isn't found, add it yourself.

To update: `cd ~/.agentswf && git pull && bun install`.

## A first workflow

A workflow can live in any folder, and needs nothing installed there: `awf` gives it
`agentswf/workflow` and `typebox` from its own copies. This one asks one agent a question with a
known answer. It runs headless, so it needs neither Herdr nor a sandbox.

```ts
// ~/workflows/hello.ts
import { defineExecutableWorkflow, isAnswered } from "agentswf/workflow";
import Type from "typebox";

const ANSWER = Type.Object({ answer: Type.Integer() }, { additionalProperties: false });

export default defineExecutableWorkflow({
  definition: {
    meta: { name: "hello", description: "Ask one agent a question with a known answer." },
    async run(workflow) {
      const agent = await workflow.agents.open({
        key: "hello",
        runtime: { harness: "codex", model: "gpt-6-luna", placement: "headless" },
      });
      const { outcome } = await agent.run({
        prompt: "What is 17 multiplied by 23? Work it out yourself; do not run any code.",
        schema: ANSWER,
        timeoutMs: 3 * 60_000,
      });
      return isAnswered(outcome) ? outcome.value : { unanswered: outcome.reason };
    },
  },
  prepare: () => ({}),
});
```

```sh
cd ~/workflows && awf run ./hello.ts
```

It prints the run's result as JSON, with the agent's answer under `value`, and keeps the run's
artifacts under `~/.awf/runs`; `--run-root` puts them elsewhere. `awf` with no arguments lists its
options. A workflow file is trusted code: it runs with your filesystem and process authority.

Use the harness you are logged in to. Headless claude is billed per token even on a subscription,
so it runs only when the runtime also says `metered: true`.

For types in an editor, give the folder a `tsconfig.json` that points into the clone. Paths in it
can't start with `~`, so write your home directory out:

```json
{
  "compilerOptions": {
    "strict": true,
    "noEmit": true,
    "module": "Preserve",
    "moduleResolution": "Bundler",
    "target": "ESNext",
    "paths": {
      "agentswf/workflow": ["/Users/you/.agentswf/packages/contract/src/workflow/index.ts"],
      "typebox": ["/Users/you/.agentswf/packages/engine/node_modules/typebox"],
      "typebox/*": ["/Users/you/.agentswf/packages/engine/node_modules/typebox/*"]
    }
  }
}
```

The `examples/` folder has larger workflows: reviews by several agents, typed decisions and
sandboxes.

## Then

- **Pane agents** keep a terminal session between turns, and need [Herdr](https://herdr.dev).
- **Sandboxes** need `srt`, Anthropic's sandbox-runtime (with bubblewrap on Linux), or docker.
- **`awf` loads no `.env`,** because one can hold a token that changes how every agent logs in.
  Typed decisions by Jev, through OpenRouter, still find `OPENROUTER_API_KEY`: from the
  environment, or from `.env` in the directory you run `awf` from, where only that name is read.

## Where things are

Start with **[`docs/foundation.md`](docs/foundation.md)** for the vision and the argument, and
**[`docs/status.md`](docs/status.md)** for what runs today and what comes next.

```sh
bun install
bun test
```

| Where | What |
| --- | --- |
| [`docs/foundation.md`](docs/foundation.md) | the vision, the shape of this repository, and the argument for it |
| [`docs/status.md`](docs/status.md) | what runs today, open stages and stories, what is next |
| [`docs/stories/`](docs/stories/) | deliverables, each planned and reviewed task by task |
| [`docs/adr/`](docs/adr/) | decisions taken against the foundation since |
| [`docs/reference.md`](docs/reference.md) | the projects surveyed, and what is still unmined in them |
| [`docs/findings/`](docs/findings/) | what seven experiments settled, and what is still live |
| [`docs/design/`](docs/design/) | the interface design notes: messaging, composition, permissions |
| `packages/` | `contract`, `harness`, `engine`, `wf`, `sandbox`, `lab` |
| `examples/` | scenario workflows against the author surface |
| `experiments/` | the archived experiments, and the one open measurement |

agents.wf is MIT licensed: see [`LICENSE`](LICENSE).
