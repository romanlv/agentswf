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
- [/llms-full.txt](/llms-full.txt) is every page but the landing page, in one file.
