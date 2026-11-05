---
title: Quick start
description: Set up a folder with awf init, test its workflow for free, run one real agent, and read what the run kept.
---

# Quick start

You set up a folder for workflows, run the workflow it comes with on
scripted agents, then once on a real agent, and read what the run kept.

```sh
awf init my-workflows        # a hello workflow, its test, and the config files
cd my-workflows
awf test                     # scripted agents: free, no agent starts
awf run hello/workflow.ts    # one real codex agent
```

You need `awf` on your PATH (`bun add -g agentswf`, with Bun 1.4 or later) and, for the last step
only, the codex CLI logged in: [Install](/guide/install) has both.

## 1. Set up a folder

```sh
awf init my-workflows
```

`awf init` writes the folder and runs `bun install` in it so your editor has types. Below
`bun install`'s own output, it says what it did and what to run next:

```text
created  package.json
created  hello/workflow.ts
created  hello/workflow.test.ts
created  tsconfig.json
created  AGENTS.md
created  .gitignore

next:
  cd my-workflows
  awf test                     # scripted agents: free, no agent starts
  awf run hello/workflow.ts    # one real codex agent
```

With no directory it sets up the current one. It never overwrites: a file that exists is skipped,
except that `package.json` gains the scripts and dev dependencies it lacks, and `.gitignore` the
lines it lacks (`node_modules/` and `.awf/`). `--no-install` skips `bun install`; until it runs,
`awf` refuses the folder, which declares `agentswf` without having it installed.

`AGENTS.md` tells a coding agent working in the folder how to write and test a workflow, so you
can [ask one to write the next](#have-your-agent-write-the-next-one).

## 2. Read the workflow

`hello/workflow.ts`:

<<< @/../packages/engine/src/init-template/hello/workflow.ts.template{ts} [hello/workflow.ts]

A workflow is a module that default-exports `defineWorkflow(…)`. Its `run` opens one agent, gives
it one turn, and returns what came back:

- **`wf.agents.open`** starts an agent. `key` names it in the run's record; `runtime` says which
  CLI, which model, and where it runs. `headless` is a plain subprocess, with no terminal to
  watch it in.
- **`agent.run`** sends the prompt and waits for the turn's **outcome**. `schema` is the shape the
  answer must have: awf tells the agent how to answer, checks the answer against the schema, and
  sends a **nudge** to an agent that ends its turn without one.
- **`outcome.answered`** is true when the agent gave an answer that passed the check. The
  schema checks the answer at run time; the type argument, `agent.run<Type.Static<typeof ANSWER>>`,
  is what types `outcome.value` in your editor. Any other outcome (no answer, a timeout, a
  failure) carries a `reason`, and the workflow returns that instead of throwing.

The control flow is plain TypeScript: a second agent, a loop or a `Promise.all` is code you add
here.

## 3. Test it, for free

```sh
awf test
```

```text
bun test v1.4.0 (34cbb9a40)

 2 pass
 0 fail
 4 expect() calls
Ran 2 tests across 1 file. [110.00ms]
```

`awf test` runs every `*.test.ts` and `*.spec.ts` under the folder with each agent replaced by a
script. No agent starts and nothing is metered. The test `awf init` wrote,
`hello/workflow.test.ts`, checks both ways the workflow can end:

<<< @/../packages/engine/src/init-template/hello/workflow.test.ts.template{ts} [hello/workflow.test.ts]

`answer(ANSWER, …)` scripts the agent's typed answer; `noAnswer.silent()` scripts an agent that never
answers, so the test sees awf nudge it once and the workflow return why it got nothing. Every
script and what a test can check are in the [testing API](/reference/testing-api).

## 4. Run it on a real agent

```sh
awf run hello/workflow.ts
```

This starts one codex agent and asks it the question. The workflow runs it headless on
`gpt-6-luna`, a small model, because the question needs no more and that setup asks the least of
you: no [Herdr](https://herdr.dev) for a TUI agent, no sandbox, only a codex login. The run's closing
line gives its token count and an estimate at list prices.

Before you run it:

- `awf run` fails before any agent opens while your shell holds an API key that would switch an
  agent to per-token billing, such as `OPENAI_API_KEY`, `OPENAI_BASE_URL` or `CODEX_API_KEY`;
  unset them first. [Configuration](/reference/configuration#refused) lists them all.
- To use another harness, change `runtime`. An agent without `placement: "headless"` runs in its
  TUI, which needs Herdr ([Harnesses](/guide/harnesses)).
- Headless claude is refused unless the runtime says `metered: true`; claude in its TUI runs on
  your subscription ([why](/guide/harnesses#subscription-and-metered)).

While the run goes, the terminal shows its agent and what it is doing. When it ends, awf prints a
closing block. Its shape is fixed; the figures here are only an example:

```text
✓ completed · hello 20261101-1532-a7f3 · 1 agent · 14s · 9k tokens · <$0.01 at list prices · subscription
  records  .awf/runs/hello/20261101-1532-a7f3
```

The run's id is its start time and four random hex digits. The last word is how the harness says
the agent was billed: `subscription`, `metered` or `unknown`
([What the record says](/guide/harnesses#what-the-record-says)).

Then it prints the result. `hello` has no `present` function, so awf prints the run's whole record
as JSON, the same as its `output.json`. Trimmed:

```json
{
  "version": 5,
  "runId": "20261101-1532-a7f3",
  "attempt": 1,
  "workflow": { "name": "hello", "file": "…/my-workflows/hello/workflow.ts" },
  "accounting": { … },
  "usage": [ … ],
  "artifacts": "…/my-workflows/.awf/runs/hello/20261101-1532-a7f3",
  "outcome": "completed",
  "value": { "answer": 391 }
}
```

`value` is what `run` returned. A workflow with `present` prints what that returns instead
([Workflows](/guide/workflows#the-result-present-and-report)).

`awf run` exits 0 when the run completed; every other exit code, and how a run that stopped
part-way goes on, is on [Runs](/guide/runs#how-an-attempt-ends).

## 5. Read what the run kept

Every run is kept in `.awf/runs/{workflow}/{id}`, under the folder the run worked in. `output.json`
there is the record printed above; [the record](/guide/how-it-works#the-record) says what else the
folder holds.

Two commands read runs without opening the files
([Following runs](/guide/following-runs)):

```sh
awf runs                  # the runs here, newest first
awf runs hello/{id}       # one run: its attempts, stages and agents
awf logs                  # what the newest run and its agent did, merged by time
```

Runs stay out of your repository: awf keeps them out of git itself
([the record](/guide/how-it-works#the-record)), and the `.gitignore` that `awf init` wrote lists
`.awf/` too.

## Have your agent write the next one

Open your coding agent in the folder and ask for the workflow:

```text
Read https://agents.wf/llms.txt and the workflow API it links. Write a workflow in review/
where one agent fixes the failing tests in the directory the run works in, and a second
reviews the fix, at most three rounds. Write its test, and run awf test and bun run check
until both pass. Don't run the workflow.
```

The `AGENTS.md` that `awf init` wrote says the same, but not every agent reads it: one opened
outside the folder doesn't, nor does Claude Code under a `CLAUDE.md`. The prompt says it anyway.

The typecheck and `awf test` catch what the agent gets wrong about the API, without starting a
real agent. Before the first real run, read the workflow for what they can't:

- **The runtimes.** Which harness and model each agent runs on decides what the run costs and
  which login it uses. An agent without `placement: "headless"` opens in its TUI, which needs
  [Herdr](https://herdr.dev). A headless claude agent needs `metered: true`, your consent to
  per-token billing: check that the agent set it because you meant it.
- **The loops.** Every loop needs a limit, and every turn's outcome needs handling: a turn can end
  without an answer, and `outcome.reason` says why ([Outcomes](/reference/workflow-api#outcomes)).
- **The prompts and schemas.** They are the agents' whole brief. A schema that is too loose lets
  a vague answer through as a valid one.
- **The test.** Check that it scripts the unhappy path too: a reviewer that never approves, an
  agent that doesn't answer.

Then run it on your project: `awf run review/workflow.ts --cwd ../my-project`.

## Next

- Change the prompt or the schema, run `awf test`, and see the tests catch it:
  [Testing](/guide/testing) has how.
- [How it works](/guide/how-it-works): the words these pages use, and what awf does between your
  workflow and its agents.
- [Workflows](/guide/workflows) and [Harnesses](/guide/harnesses): a workflow's arguments and
  result, and running agents on other harnesses and models, in their TUI or headless.
- [Runs](/guide/runs): ids, stages, and going on after a stop.
- [The workflow API](/reference/workflow-api) has every option and outcome, and
  [`awf`](/reference/awf) every command.
