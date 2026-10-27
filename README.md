# agentswf

**Write workflows for coding agents in TypeScript.** Hand work to claude, codex, pi or cursor,
run them side by side, have one check another, loop until a reviewer is happy, and get typed
answers back. `awf` runs the workflow and handles the parts that make agent scripts fragile:
agents that never answer, answer in prose, hang, or quietly run up a bill.

```ts
// Inside a workflow: open an agent, give it work, get a typed answer back.
const reviewer = await workflow.agents.open({ key: "reviewer", runtime: { harness: "codex", model: "gpt-6-luna" } });
const { outcome } = await reviewer.run({ prompt: "Review `git diff main`.", schema: FINDINGS });
if (isAnswered(outcome)) console.log(outcome.value.findings); // validated against FINDINGS, or a reason why not
```

> **Early preview.** Interfaces will change between versions. It is on npm as a beta: `agentswf@beta`.

## Why

If you use coding agents seriously, you already run workflows by hand. One agent implements and
another reviews, and you paste the findings back. Five agents review the same change, and you
cross-check what they found. Scripting that is easy right up until an agent goes quiet, answers
in the wrong shape, or a run costs ten times what you expected and you can't tell why.

agentswf keeps the workflow in code you own, and moves the unreliable parts into the engine. It
drives the agent CLIs you already use, logged in as you already are: Claude Code in a pane runs on
your Claude subscription, with no API key and no credits to buy.

## How it works

```
 your workflow.ts                 awf run                         agents
 ────────────────                 ───────                         ──────
 agents.open(...)       ──▶  starts claude / codex / pi   ──▶  pane in Herdr, or headless
 agent.run({ prompt,    ──▶  sends the prompt, plus how   ──▶  works in your repo as usual,
             schema })        to answer                        then runs `wf result '{...}'`
 await outcome          ◀──  validates against the schema ◀──  over a socket just for that agent
 parallel / loops / ifs      deadlines, nudges, cleanup,
 return result               usage and cost for the record
```

A workflow is a TypeScript module. `awf run ./workflow.ts` runs it, prints its result and keeps
a record of the run in `.awf/runs`. Control flow is yours: `for`, `if`, `Promise.all`. Each agent
runs in a **pane** of [Herdr](https://herdr.dev), a terminal multiplexer where you can watch it and
type to it, or **headless** as a plain subprocess.

## What a workflow looks like

It reads as the process it runs. This is
[`examples/feature-delivery`](examples/feature-delivery/workflow.ts), which takes a ticket from a
plan to an approved change: a planner writes a ticket doc, a reviewer on another model sends it
back until it's right, then an implementer builds it and the reviewer does the same again. Each
step is a [stage](#runs-stages-and-continuing), so a run that stops part-way goes on from there.
`ask`, `workOn` and `reviewLoop` are the example's own short helpers over `agent.run`, in files
beside it.

```ts
async function deliverFeature(workflow: WorkflowContext, args: FeatureArgs): Promise<Handoff> {
  const { ticket } = args;
  const team = await openTeam(workflow, args);
  const { planner, reviewer } = team;
  const reviewUntilApproved = reviewLoop(workflow, reviewer, args.maxRevisions);

  const plan = await workflow.stage("ticket-doc", { result: WORK }, () =>
    planner.ask(WORK, {
      label: "Create ticket doc",
      prompt: md`Create an implementation-ready ticket doc for ${ticket}.`,
    }),
  );
  const approvedPlan = await workflow.stage("doc-review", { result: REVIEWED }, () =>
    reviewUntilApproved(planner, plan, ticketDoc(ticket)),
  );
  const { docPath } = approvedPlan.work;

  const implementer = await team.implementer();
  const built = await workflow.stage("implementation", { result: WORK }, () =>
    workOn(implementer, docPath, {
      label: "Implement feature",
      prompt: md`Implement ${ticket} from ${docPath}.`,
    }),
  );
  const approvedBuild = await workflow.stage("implementation-review", { result: REVIEWED }, () =>
    reviewUntilApproved(implementer, built, implementation(ticket)),
  );
  // …then an optional round of extra reviewers, and the handoff
}
```

```sh
awf run --run-root /tmp/awf-runs examples/feature-delivery/workflow.ts -- PROJ-1515
```

| Example | What it shows |
| --- | --- |
| [`quick-check`](examples/quick-check/) | one known-answer question per harness: the cheap smoke test |
| [`minimum-review`](examples/minimum-review/) | two reviewers in parallel, one lens each |
| [`catalogue-review`](examples/catalogue-review/) | many lenses, a verifier per finding, a Markdown report |
| [`feature-delivery`](examples/feature-delivery/) | plan, implement, review, revise, as stages |
| [`messaging`](examples/messaging/) | a reviewer asks an implementer for a fix by message |
| [`sandboxes`](examples/sandboxes/) | a shared docker sandbox and a private srt one |
| [`triage`](examples/triage/) | typed decisions with probabilities, no coding agent |
| [`calling-session`](examples/calling-session/) | `awf run --here`: a workflow driving the session that started it |

More in [`examples/`](examples/README.md), with how to run each. Every call is explained in
[the workflow API](docs/workflow-api.md), on one page.

## What you get

- **Typed answers, checked.** A turn ends `answered`, with JSON that fits its schema, or with a
  reason: `unanswered`, `blocked`, `timed-out`, `failed` or `cancelled`. Never half-parsed prose.
  An agent that goes quiet is nudged.
- **Mix harnesses and models.** A codex reviewer checks a claude implementer; a cheap model
  triages before an expensive one works.
- **Long-lived sessions.** An agent keeps its context from one turn to the next. `compact` shrinks
  it, keeping what you name, and `fork` starts new agents from what one knows.
- **Agents that talk to each other,** on routes the workflow grants and caps, and that can ask a
  person or an app outside the run, then wait for the answer, hours if need be.
- **Sandboxes.** docker or srt limits what agents can write and reach, and each agent gets exactly
  the skills you name.
- **Cost on every run.** Time, tokens and an estimated cost per agent, stage and model, failed runs
  included.
- **Fast decisions.** Closed questions to [Jev](#fast-decisions-with-jev), a
  decision model, come back with a probability per answer in about 200 ms, for routing and triage
  without a coding agent.
- **Runs you can follow and continue.** `awf runs` and `awf logs` show what a run did, to you or to
  another agent, and a stopped run goes on from the stage that stopped.
- **Deadlines and cleanup.** A stalled turn is stopped, deadlines you set nest, and every agent is
  closed when the run ends, however it ends, unless the workflow asked to keep its pane.

## Quick start

### Install

You need [Bun](https://bun.sh) 1.4 or later, git, and at least one agent CLI you're logged in to:
claude, codex, pi or cursor.

```sh
bun add -g agentswf@beta   # puts awf in ~/.bun/bin
awf --version
```

`~/.bun/bin` is on your PATH if Bun's installer set it up. To update, run the same `bun add -g`.

To run from a clone instead, as you would to work on agents.wf itself:

```sh
git clone https://github.com/romanlv/agentswf.git ~/.agentswf
cd ~/.agentswf && bun install
(cd packages/engine && bun link)   # puts awf in ~/.bun/bin
```

To update a clone: `cd ~/.agentswf && git pull && bun install`.

A workflow can live in any folder and needs nothing installed there: `awf` serves it
`agentswf/workflow` and `typebox` from its own copies. `awf -h` lists every command, and
`awf {command} -h` shows one in full.

### Your first workflow

```sh
mkdir ~/workflows && cd ~/workflows
awf init                    # a hello workflow, its test, and the config files
awf test                    # its test, on scripted agents: free, and no agent starts
awf run hello/workflow.ts   # one real agent
```

`awf init` never overwrites a file; run it in a folder that has some, and it adds only what's
missing. The workflow it writes is the smallest one: one headless agent, one typed answer. It
needs neither Herdr nor a sandbox, only a codex login. Swap in any harness and model your account
has.

```ts
// hello/workflow.ts
import { defineExecutableWorkflow, isAnswered } from "agentswf/workflow";
import Type from "typebox";

export const ANSWER = Type.Object({ answer: Type.Integer() }, { additionalProperties: false });

export default defineExecutableWorkflow({
  definition: {
    meta: { name: "hello", description: "Ask one agent a question with a known answer." },
    async run(workflow) {
      const agent = await workflow.agents.open({
        key: "hello",
        runtime: { harness: "codex", model: "gpt-6-luna", placement: "headless" },
      });
      const { outcome } = await agent.run<Type.Static<typeof ANSWER>>({
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

`awf run` prints the agent's answer, `{ "answer": 391 }`, and a line on time, tokens and estimated
cost. The run's full record stays in `.awf/runs/hello/{id}`.

### Things to know

- **Pane agents**, the default, need [Herdr](https://herdr.dev). Headless agents don't.
- **Claude on a subscription works in panes only.** Headless claude (`claude -p`) is billed per
  token as API usage even when you're logged in with a subscription, so awf refuses it unless the
  runtime also says `metered: true`. To stay on your plan, run claude agents in panes, the
  default. Other harnesses need no such flag.
- **Sandboxes** need `srt`, Anthropic's sandbox-runtime (with bubblewrap on Linux), or docker.
- **A workflow file is trusted code.** It runs with your filesystem and process permissions.
  Sandbox the agents, not the workflow.
- **`awf` loads no `.env`,** because one can hold a token that changes how every agent logs in.
  Only `OPENROUTER_API_KEY`, for decisions, is read from the environment or a `.env` in the
  current directory.

<details>
<summary>Editor types for a workflow outside this repository</summary>

`awf init` sets a folder up for editor types: `agentswf`, `typebox`, `@types/bun` and `typescript`
as dev dependencies, and a `tsconfig.json`. `awf` still runs the workflow against its own copies.
To set up a folder by hand instead:

```sh
bun add -d agentswf@beta typebox @types/bun
```

```json
{
  "compilerOptions": {
    "strict": true,
    "noEmit": true,
    "module": "Preserve",
    "moduleResolution": "Bundler",
    "target": "ESNext",
    "types": ["bun"]
  }
}
```

To type a workflow against a clone's unreleased changes, give the folder a `tsconfig.json` that
points into the clone instead. Paths in it can't start with `~`, so write
your home directory out:

```json
{
  "compilerOptions": {
    "strict": true,
    "noEmit": true,
    "module": "Preserve",
    "moduleResolution": "Bundler",
    "target": "ESNext",
    "types": ["/Users/you/.agentswf/node_modules/@types/bun"],
    "paths": {
      "agentswf/workflow": ["/Users/you/.agentswf/packages/contract/src/workflow/index.ts"],
      "agentswf/testing": ["/Users/you/.agentswf/packages/engine/src/workflow-testing/index.ts"],
      "typebox": ["/Users/you/.agentswf/packages/engine/node_modules/typebox"],
      "typebox/*": ["/Users/you/.agentswf/packages/engine/node_modules/typebox/*"]
    }
  }
}
```

</details>

## Runs, stages and continuing

A workflow that runs for an hour shouldn't start over because its last step failed. When a run
stops, it says how to go on:

```
■ stopped in qa: the mr environment never came up
  ticket PROJ-1515 · attempt 1 · 52m 10s · …
  go on    awf run ticket.ts --id PROJ-1515 --continue
  records  .awf/runs/ticket/PROJ-1515
```

Fix the code, a prompt or the environment, and run it. Stages that succeeded before are reused,
with no agent asked anything; the one that stopped runs again, and so does everything after it:

```
↺ plan        Add --dry-run    attempt 1 · 2h ago
↺ implement                    attempt 1
✓ qa          4m 12s
```

`--from-stage {stage}` redoes from a stage on purpose, and a new run can start part-way through,
given the earlier stages' values. [`docs/design/runs-and-stages.md`](docs/design/runs-and-stages.md)
has the full model.

To watch a run, `awf runs` lists them and shows one in depth, and `awf logs {run}` reads what it
did, each agent's prompts, tool calls and messages included; `--follow` streams it.

## Fast decisions with Jev

Not every step needs a coding agent. [Jev](https://docs.typesafe.ai/concepts/system-one), from
TypeSafe, is a *decision model*: rather than writing text, it answers closed questions about some
state with a probability for every possible answer, in about 200 ms. You pay for the state once
per call ($0.042 per million input tokens), so ten questions cost about the same as one. Use it to
route, triage or gate, and hand only the uncertain cases to an agent or a person.

```ts
import { choice, yesNo } from "agentswf/workflow";

const { answers } = await workflow.decisions.decide({
  key: "triage:42",
  model: "jev",
  state: { ticket },
  questions: {
    team: choice("Which team owns `ticket`?", {
      payments: "Checkout, billing and refunds",
      accounts: "Sign-in, sign-up and permissions",
    }),
    bug: yesNo("Does `ticket` report something broken?"),
  },
});
// answers.team → { type: "choice", choice: "payments", probabilities: { payments: 0.97, accounts: 0.03 } }
// answers.bug  → { type: "yes-no", yes: 0.91 }
```

It runs through OpenRouter, so it needs an `OPENROUTER_API_KEY`, in the environment or in a `.env`
where you run `awf`. The engine holds the key, and no agent sees it.
[`examples/triage`](examples/triage/) routes support tickets this way, and
[the findings](docs/findings/system-one-models.md) show where Jev is reliable and where it isn't.

## Written by agents, read by people

Most workflows will be written by a coding agent, not typed by hand. The surface is built for
that. It is small and fully typed, so an agent can write a workflow and the typechecker catches
its mistakes before anything runs. And it reads plainly: agents, prompts, schemas and ordinary
`for` and `if`, so you can review what the agent wrote in a minute and see what it will spend.

## Where this is going

1. **A runner you trust with real work.** The workflows you keep re-running by hand become files
   you write once.
2. **Runs you can compare.** Because every run is recorded the same way, two versions of a
   workflow can be compared on quality, time and cost.
3. **Runs that improve runs.** Try variants of a workflow (prompts, models, harnesses, how many
   verifiers) against cases with known answers, and keep the ones that are better, faster or
   cheaper. The first piece exists: `awf-lab` scores code-review workflows against old merge
   requests whose real problems are known.

## Not yet

Deliberately left out until something real needs them: calling one workflow from another, a
workflow itself pausing for outside input (its agents can already ask a coordinator), and
reopening a stopped run's agent sessions (a continue redoes the stage with fresh agents). Their
types exist, and calling them fails with a clear "unavailable" error.
[`docs/status.md`](docs/status.md) has what runs today and what's next.

## Contributing and design docs

```sh
bun install && bun test   # no live agents, no cost
bun run check             # lint, format, types and package boundaries
```

- [`docs/workflow-api.md`](docs/workflow-api.md): every call a workflow can make, on one page
- [`packages/lab`](packages/lab/README.md): scoring review workflows against cases with known answers
- [`docs/status.md`](docs/status.md): what runs today and what comes next
- [`docs/testing.md`](docs/testing.md): the test levels, from free to live, and what each costs
- [`docs/foundation.md`](docs/foundation.md): the design argument behind the package boundaries
- [`docs/adr/`](docs/adr/): decisions taken since, and [`docs/findings/`](docs/findings/): what the
  measurements settled
- [`AGENTS.md`](AGENTS.md): working in this repository with a coding agent

agentswf is MIT licensed: see [`LICENSE`](LICENSE).
