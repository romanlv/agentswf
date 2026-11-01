# agents.wf

> Workflows for coding agents, in TypeScript. A workflow is a TypeScript file that opens coding
> agents (claude, codex, pi, cursor), gives them work and gets typed answers back; `awf` runs it
> and keeps a record of every run.

Use agents.wf when a process between agents is worth writing down once: one agent implements and
another reviews until it approves, several reviewers look at one change, a cheap model triages
before an expensive one works. For one agent doing one task, ask the agent; a workflow adds
nothing.

## How to use these docs

- Start with the [Quick start](/guide/quick-start.md): `awf init`, a test, one real run.
- Every page is also plain Markdown: add `.md` to its URL. A section's index is `index.md`, so
  `/guide/` is `/guide/index.md`.
- Read the [Workflow API](/reference/workflow-api.md) before writing code: every call, option,
  default and outcome is on that one page. Tests use the [Testing API](/reference/testing-api.md).
- [/llms-full.txt](/llms-full.txt) is every page in one file.

## Rules for writing a workflow

These are the rules in the `AGENTS.md` that `awf init` writes.

- A workflow is a folder with a `workflow.ts`, which default-exports `defineWorkflow(…)` from
  `agentswf/workflow`, and a `workflow.test.ts` beside it.
- After a change, run `awf test` and `bun run check`, which typechecks. `awf test` replaces each
  agent with scripted answers: no agent starts and it costs nothing.
- Don't run a workflow (`awf run`) unless asked. It starts real agents on the operator's accounts.
- Each run is kept in `.awf/runs/{workflow}/{id}`. `awf runs` lists them; `awf logs {run}` shows
  what one did.
