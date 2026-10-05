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

> **Runs on your Claude subscription.** Claude Code agents in a pane use the Claude plan you
> already have: no API key, no credits to buy. (Headless claude is the exception; see
> [Things to know](#things-to-know).)

> **Early preview.** Interfaces will change, and nothing is on npm yet: you install from a clone.

## Why

If you use coding agents seriously, you already run workflows by hand. One agent implements and
another reviews, and you paste the findings back. Five agents review the same change, and you
cross-check what they found. Scripting that is easy right up until an agent goes quiet, answers
in the wrong shape, or a run costs ten times what you expected and you can't tell why.

agentswf keeps the workflow in code you own, and moves the unreliable parts into the engine.

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

A workflow is a TypeScript module with a default export. `awf run ./workflow.ts` loads it, runs
it, prints its result and keeps everything in the project's `.awf/runs`. Control flow is yours: `for`,
`if`, `Promise.all`, whatever. The engine gives you agents, sandboxes, `parallel` with
labelled groups it shows live in the terminal, and stages a run continues from.

**A few words used below:**

- **Harness:** the agent CLI that does the work: `claude`, `codex`, `pi` or `cursor`. A runtime
  is a harness plus a model.
- **Placement:** where the agent runs. A **pane** is a terminal tab in
  [Herdr](https://herdr.dev), a terminal multiplexer for agents, where you can watch it and type
  to it; panes are the default. **Headless** runs the CLI as a subprocess, with no terminal.
- **Sandbox:** a boundary around agents, from docker or **srt** (Anthropic's sandbox-runtime),
  that limits what they can write and reach.
- **Jev:** a small decision model on OpenRouter that answers closed questions with probabilities.

## What you get

- **Workflows saved as code.** A workflow is a TypeScript file: versioned, diffable, reviewable
  and re-runnable, instead of a procedure you repeat by hand in a chat.
- **Your existing agents and logins.** agentswf drives the agent CLIs you already use, logged in
  the way you already log in. Claude Code in a pane runs on your Claude subscription, as it does
  when you use it yourself: no API key and no credits to buy. The same goes for codex on a
  ChatGPT plan.
- **Mix harnesses and models.** Each agent picks its own harness and model, so a codex reviewer can
  check a claude implementer, or a cheap model can triage before an expensive one works.
- **Typed answers, checked.** Every turn can carry a schema. The agent answers by running
  `wf result` with JSON, which is validated before your code sees it, and TypeScript knows its
  shape. A turn ends `answered`, or `unanswered`, `blocked`, `timed-out`, `failed` or `cancelled`
  with a reason. It never ends with a silently missing answer or half-parsed prose, and an agent
  that goes quiet gets one nudge.
- **Long-lived sessions.** Talk to the same agent again and it continues its own session, keeping
  its context, and each turn can ask for a different kind of answer: a plan, then a patch
  summary, then a yes or no. When the context fills, `compact` runs the harness's own compaction
  with your focus, as `/compact` does, and the agent goes on.
- **Sandboxes.** Put agents in a docker or srt sandbox, shared or private, that decides what they
  can write and which domains they can reach. Give each one exactly the skills you name.
- **Cost tracking.** Every run records time, tokens and a cost estimate for each agent, stage and
  model, read from the harnesses' own session files. It's printed at the end and kept with the
  run, failed runs included.
- **Fast decisions with Jev.** For routing, triage and gating, ask [Jev](#fast-decisions-with-jev),
  a decision model, closed questions and get a probability for every answer in about 200 ms, with
  no coding agent involved. It needs an OpenRouter key.
- **Runs that continue.** Mark steps as [stages](#runs-stages-and-continuing) and a stopped run
  picks up at the step that stopped, reusing what succeeded. A new run can start at any stage,
  given the earlier stages' values.
- **Deadlines and cleanup.** Every wait has a deadline, and every agent is cleaned up when the run
  ends, however it ends.
- **Watch or run headless.** An agent runs in a terminal pane you can watch and type into
  (through [Herdr](https://herdr.dev)), or headless as a subprocess.

## Quick start

### Install

You need [Bun](https://bun.sh) 1.4 or later, git, and at least one agent CLI you're logged in to:
claude, codex, pi or cursor.

```sh
git clone https://github.com/romanlv/agentswf.git ~/.agentswf
cd ~/.agentswf && bun install
(cd packages/engine && bun link)   # puts awf in ~/.bun/bin
awf --version
```

`bun link` puts `awf` in `~/.bun/bin`, which Bun's installer adds to your PATH. To update:
`cd ~/.agentswf && git pull && bun install`.

A workflow can live in any folder and needs nothing installed there: `awf` serves it
`agentswf/workflow` and `typebox` from its own copies. `awf` alone prints its usage.

### Your first workflow

The smallest workflow: one headless agent, one typed answer. It needs neither Herdr nor a sandbox,
only a codex login. Swap in any harness and model your account has.

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

It prints the result as JSON, with the agent's answer, `{ "answer": 391 }`, under `value`, and a
line on time, tokens and estimated cost. The run's full record, including `output.json`, stays
in `.awf/runs/{workflow}/{id}` under the working directory (`--run-root` moves it), and
`--continue {id}` runs it again with the arguments it was started with.

### Things to know

- **Pane agents** (the default placement) need [Herdr](https://herdr.dev). Headless agents don't.
- **claude, codex and pi run in a pane or headless; cursor runs headless only.**
- **Claude on a subscription works in panes only.** Headless claude (`claude -p`) is billed per
  token as API usage even when you're logged in with a subscription, so awf refuses it unless the
  runtime also says `metered: true`. To stay on your plan, run claude agents in panes, the
  default. Headless codex and pi need no such flag.
- **Sandboxes** need `srt`, Anthropic's sandbox-runtime (with bubblewrap on Linux), or docker.
- **A workflow file is trusted code.** It runs with your filesystem and process permissions.
  Sandbox the agents, not the workflow.
- **`awf` loads no `.env`,** because one can hold a token that changes how every agent logs in.
  Only `OPENROUTER_API_KEY`, for decisions, is read from the environment or a `.env` in the
  current directory.

<details>
<summary>Editor types for a workflow outside this repository</summary>

Give the folder a `tsconfig.json` that points into the clone. Paths in it can't start with `~`,
so write your home directory out:

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

A workflow that runs for an hour shouldn't start over because its last step failed. awf keeps
every run on disk, and a workflow marks the steps worth keeping as stages.

- **Run:** one piece of work, such as a ticket, kept in `.awf/runs/{workflow}/{id}`. Its id comes
  from `--id`, from the workflow's own `id(args)` (a ticket's key, say), or is generated.
- **Attempt:** one `awf run` of a run. `awf run flow.ts --continue {id}` starts the next one with
  the same arguments, after you've fixed the code, a prompt or the environment. An attempt that
  crashed or was killed reads `interrupted`, and continues the same way.
- **Stage:** a named step whose value the run records, checked against a schema.

```ts
const plan = await workflow.stage("plan", { result: PLAN, summary: (p) => p.title }, async () => {
  const { outcome } = await planner.run({ prompt: `Plan ${ticket}.`, schema: PLAN });
  return isAnswered(outcome) ? outcome.value : workflow.stop(outcome.reason); // a continue redoes plan
});
const built = await workflow.stage("implement", { result: BUILT }, () => implement(plan));
await workflow.stage("qa", { result: QA }, () => qa(built));
```

On a continue, a stage that succeeded before is **reused**: its work isn't called, no agent is
asked anything, and `stage` returns the recorded value. The first stage with no succeeded record
runs, and so does everything after it:

```
↺ plan        Add --dry-run    attempt 1 · 2h ago
↺ implement                    attempt 1
✓ qa          4m 12s
```

What to know when writing one:

- **A stage's value is its only output.** Agents start fresh in every attempt, so a stage returns
  what later stages need: a branch, a doc path, a list of findings.
- **Code between stages runs on every attempt,** reused stages or not. Keep it repeatable; push,
  post and create inside a stage.
- **A stop says how to go on.** `workflow.stop(reason)` or a throw inside a stage records it
  stopped or failed, and the closing block names the command that redoes it:

  ```
  ■ stopped in qa: the mr environment never came up
    ticket AIRS-1515 · attempt 1 · 52m 10s · …
    go on    awf run ticket.ts --continue AIRS-1515
    records  .awf/runs/ticket/AIRS-1515
  ```

- **`--from-stage {stage}` redoes from a stage** on purpose, with the ones before it reused. The
  records it replaces move to `replaced/` rather than being deleted.
- **A changed workflow doesn't silently reuse old results.** A record from another major
  `meta.version`, or one whose value no longer fits the stage's schema, stops the continue at that
  stage, and `--from-stage` it redoes from there.

### Starting at a stage

A new run can start part-way through, for example at qa for a ticket you built by hand. Later stages
read earlier stages' values, so awf asks for them. It finds every stage the run needs a value for
and stops once, naming each with its schema:

```
$ awf run ticket.ts --from-stage qa -- AIRS-1234
■ stopped in plan: nothing recorded for plan
  ticket AIRS-1234 · 0s
  needs    plan: {title: string, steps: string[]}
           implement: {branch: string}
  go on    awf run ticket.ts --continue AIRS-1234 --from-stage qa --values {file}
  records  .awf/runs/ticket/AIRS-1234
```

Write the values to a JSON file keyed by stage name, `{"plan": {…}, "implement": {…}}`, and run
the `go on` command. Each value is checked against its stage's schema and recorded as `provided`,
with no agent turns and no cost; a stage that returns nothing needs no entry. With `--json`, the stop's
`needs` holds each full JSON Schema. The loop is meant for an agent: read `needs`, find the values in
the ticket or the repository, write the file, rerun.

A workflow's tests can do the same without agents: `testWorkflow` takes `recorded`, `fromStage`
and `values`, as [the workflow API](docs/workflow-api.md#continuing-over-recorded-stages) shows.
The full model, with what's on disk and why, is in
[`docs/design/runs-and-stages.md`](docs/design/runs-and-stages.md).

## Examples

These show the shape of what you can build. To keep them short they are fragments: the `run()`
of a workflow shaped like [the first one](#your-first-workflow), with the same imports. Each
typechecks against the current API, and each points to a complete workflow in
[`examples/`](examples/) that does the same thing in full. Every call they use is explained in
[the workflow API](docs/workflow-api.md).

### Fan out reviewers, then check every finding

Three reviewers read the same diff at once, each looking for one kind of problem (a *lens*).
Then a fresh agent from a different model family tries to refute each finding, and only the
ones that survive are kept.
Agents that disagree for a living cut the noise a single reviewer produces.

```ts
const STRICT = { additionalProperties: false } as const;
const FINDINGS = Type.Object({
  findings: Type.Array(Type.Object({ file: Type.String(), problem: Type.String() }, STRICT)),
}, STRICT);
const VERDICT = Type.Object({ real: Type.Boolean(), reason: Type.String() }, STRICT);
type Findings = Type.Static<typeof FINDINGS>;
type Verdict = Type.Static<typeof VERDICT>;

const REVIEWER = { harness: "codex", model: "gpt-6-luna", placement: "headless" } as const;
const CHECKER = { harness: "claude", model: "claude-sonnet-5-5" } as const; // a pane in Herdr

async run(workflow) {
  const found = await workflow.parallel(["correctness", "security", "tests"], async (lens) => {
    const reviewer = await workflow.agents.open({ key: `review:${lens}`, runtime: REVIEWER });
    const { outcome } = await reviewer.run<Findings>({
      prompt: `Review \`git diff origin/main...HEAD\` for ${lens} problems only. Change nothing.`,
      schema: FINDINGS,
    });
    return isAnswered(outcome) ? outcome.value.findings : [];
  }, { label: "Review" });

  const checked = await workflow.parallel(found.flat(), async (finding, i) => {
    const checker = await workflow.agents.open({ key: `check:${i}`, runtime: CHECKER });
    const { outcome } = await checker.run<Verdict>({
      prompt: `A reviewer claims: ${finding.problem} (in ${finding.file}). Try to prove it wrong.`,
      schema: VERDICT,
    });
    return { ...finding, verdict: isAnswered(outcome) ? outcome.value : null };
  }, { label: "Check", concurrency: 4 });

  return { findings: checked.filter((f) => f.verdict?.real) };
}
```

The full version is [`examples/catalogue-review`](examples/catalogue-review/). It reads its lenses
from a catalogue, skips a lens when the diff doesn't touch its paths, and writes a `report.md` to
hand back to whoever wrote the change. It has run live with 21 agents on one merge request.

### Build, review, repeat

One agent implements and another reviews, until the reviewer approves or three rounds pass. Each
`run()` on the same agent continues its session, so the builder remembers what it did last round.
Both run in panes, so you can watch them work and step in.

```ts
const STRICT = { additionalProperties: false } as const;
const DONE = Type.Object({ summary: Type.String() }, STRICT);
const REVIEW = Type.Object({ approved: Type.Boolean(), mustFix: Type.Array(Type.String()) }, STRICT);
type Done = Type.Static<typeof DONE>;
type Review = Type.Static<typeof REVIEW>;

// prepare turns the words after `--` into the task: prepare: (inv) => ({ task: inv.argv.join(" ") })
async run(workflow, { task }) {
  const builder = await workflow.agents.open({
    key: "builder",
    runtime: { harness: "claude", model: "claude-sonnet-5-5" },
  });
  const reviewer = await workflow.agents.open({
    key: "reviewer",
    runtime: { harness: "codex", model: "gpt-6-luna" },
    instructions: "You review uncommitted changes. You never edit files.",
  });

  let request = `Implement this, then summarise what you changed:\n\n${task}`;
  for (let round = 1; round <= 3; round++) {
    const built = await builder.run<Done>({ prompt: request, schema: DONE, label: `build ${round}` });
    if (!isAnswered(built.outcome)) return { approved: false, note: built.outcome.reason };

    const review = await reviewer.run<Review>({
      prompt: `The builder says: ${built.outcome.value.summary}\nReview \`git diff\`.`,
      schema: REVIEW,
      label: `review ${round}`,
    });
    if (!isAnswered(review.outcome)) return { approved: false, note: review.outcome.reason };
    if (review.outcome.value.approved) return { approved: true, note: `approved in round ${round}` };

    request = `The reviewer asks for these fixes:\n- ${review.outcome.value.mustFix.join("\n- ")}`;
  }
  return { approved: false, note: "not approved after three rounds" };
}
```

```sh
awf run ./build-and-review.ts -- "Add a --dry-run flag to the deploy script"
```

A builder that runs many rounds can shed old context between them with the harness's own
compaction, keeping what you name:

```ts
await builder.compact({ prompt: "Keep the task and the reviewer's open points; drop the build logs." });
```

It runs after the builder's earlier turns and within the workflow's deadline (`timeoutMs` bounds
it sooner). Claude, codex and pi compact, in a pane or headless; cursor refuses, and the context
is left as it was.

[`examples/feature-delivery`](examples/feature-delivery/) is the bigger design: plan, implement,
review and revise, each a stage, so a step that stops is redone by `--continue` and the ones before
it are reused. It typechecks and its tests run, but it hasn't run live yet.

### Put agents in a sandbox, with exactly the skills they need

A sandbox says what its agents can write and which domains they can reach. Agents can share
one, or each get their own. Skills are copied in per agent, so an agent has the ones you name
and nothing else from your setup.

```ts
const box = await workflow.sandboxes.open({
  key: "work",
  write: ["."],                     // the working directory, and nothing else
  network: ["registry.npmjs.org"],  // plus the model's own API
  docker: {},                       // or srt: {}, Anthropic's sandbox-runtime
});
const agent = await workflow.agents.open({
  key: "upgrader",
  runtime: { harness: "codex", model: "gpt-6-luna", placement: "headless" },
  sandbox: box,
  skills: [
    { path: new URL("./skills/upgrade-deps", import.meta.url) }, // one beside the workflow
    { repo: "owner/repo", skill: "code-review", ref: "v1.2.0" }, // a public one, pinned
  ],
});
```

[`examples/sandboxes`](examples/sandboxes/) runs three agents in one container and a fourth in a
private srt sandbox, and prints what each was allowed and refused.

### Fast decisions with Jev

Not every step needs a coding agent. [Jev](https://docs.typesafe.ai/concepts/system-one), from TypeSafe, is a
*decision model*: instead of writing text, it answers closed questions about some state and
returns a probability for every possible answer. A call comes back in about 200 ms, and you pay
only for the state you send, once per call ($0.042 per million input tokens), so asking ten
questions costs about the same as asking one. Use it to route, triage or gate, and hand only the
uncertain cases to an agent or a person.

`workflow.decisions` calls Jev through OpenRouter, so it needs an **`OPENROUTER_API_KEY`**, in the
environment or in a `.env` in the directory you run `awf` from. The engine holds the key; no agent
ever sees it.

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

[`examples/triage`](examples/triage/) routes support tickets this way, and flags any answer below
0.9 as unsure rather than taking it. How well Jev did on real review data is in
[`docs/findings/system-one-models.md`](docs/findings/system-one-models.md).

### Run a workflow in the session you are in

A long procedure you run often, such as review, fix, re-review and summarize, can run inside the
agent session that already holds the context, instead of starting cold. From claude, codex, pi or
cursor in a Herdr pane, start it with `awf run --here`. The run opens its own tab, takes your
session over as one of its agents, and hands it back with a last `[awf]` message when it ends.
Other agents it opens run as usual.

```ts
const author = await workflow.agents.caller({ key: "author" });
if (!author) throw new Error("start this workflow with awf run --here");
const { outcome } = await author.run({ prompt: "Fix the findings in REVIEW.md.", schema: FIXED });
```

`agents.caller` returns `null` when the run was not started from a session. Its turns work like any
agent's, except that the context is yours: `compact` is refused, a turn that fails, times out or
is cancelled leaves the session as it was, and pressing Esc on a step settles that step
`cancelled` instead of nudging you.

There are three ways to start it:

- **Type it yourself:** `!awf run --here review-loop.ts` in claude (`!` runs a shell command).
- **A skill:** copy [`packages/engine/skills/awf-run`](packages/engine/skills/awf-run/) to
  `~/.claude/skills/`, `~/.agents/skills/` (codex), `~/.pi/agent/skills/` or `~/.cursor/skills/`,
  then invoke it the way your harness invokes a skill, as `/awf-run review-loop.ts` in claude.
- **A command for one workflow:** the same skill with the workflow fixed, so `/review-loop` is
  all you type. Copy `awf-run`, rename it, and change its command and `name`:

  ```markdown
  ---
  name: review-loop
  description: Review this branch in this session with the review-loop workflow. Use when the user types /review-loop.
  ---

  Run `awf run --here ~/workflows/review-loop.ts` in the shell, then follow the rest of awf-run's
  instructions.
  ```

When the session cannot be driven, the command says why and starts nothing: when it is not in a
Herdr pane, or when its sandbox cannot reach Herdr. Under codex's default sandbox, start codex with
`-c sandbox_workspace_write.network_access=true`. Try it with
[`examples/calling-session`](examples/calling-session/). The design is
[ADR 0010](docs/adr/0010-the-calling-session-is-an-agent.md).

## Runnable examples

| Workflow | What it shows | Run it |
| --- | --- | --- |
| [`quick-check`](examples/quick-check/) | one known-answer question per harness: the cheap smoke test | `awf run examples/quick-check/workflow.ts -- codex pi` |
| [`minimum-review`](examples/minimum-review/) | two reviewers in parallel, one lens each | `awf run examples/minimum-review/review-loop.ts -- src` |
| [`single-agent-review`](examples/single-agent-review/) | one reviewer, with or without a public review skill | `awf run examples/single-agent-review/workflow.ts -- --range main...HEAD` |
| [`catalogue-review`](examples/catalogue-review/) | many lenses, a verifier per finding, a Markdown report | an entry point beside your lens catalogue |
| [`sandboxes`](examples/sandboxes/) | a shared docker sandbox and a private srt one | `awf run --cwd "$(mktemp -d)" examples/sandboxes/workflow.ts` |
| [`triage`](examples/triage/) | typed decisions with probabilities | `awf run examples/triage/workflow.ts` |
| [`compaction`](examples/compaction/) | an agent compacted with a focus, then asked what it kept, per harness | `awf run examples/compaction/workflow.ts -- claude pi` |
| [`calling-session`](examples/calling-session/) | a workflow driving the session it was started from | `awf run --here examples/calling-session/workflow.ts`, from an agent |
| [`feature-delivery`](examples/feature-delivery/) | plan, implement, review, revise, as stages | tests run; not yet run live |

[`examples/README.md`](examples/README.md) has the details of each. The rest of the folder is test
apparatus and a shared helper.

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

Deliberately left out until something real needs them: agents messaging each other mid-turn,
calling one workflow from another, human checkpoints, and reopening a stopped run's agent sessions
(a continue redoes the stage with fresh agents). Some of these
have types in the API already, and calling them fails with a clear "unavailable" error.
[`docs/status.md`](docs/status.md) has what runs today and what's next.

## Names

The project is **agentswf**. **`awf`** is the command you run, and what it owns keeps that
name (`.awf/runs`, `AWF_*`). **`wf`** is the command an agent runs inside its session to answer.
A workflow imports **`agentswf/workflow`**. The packages here are **`@agentswf/*`**.

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
