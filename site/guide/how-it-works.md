---
title: How it works
description: The words the docs use, and what awf does between your workflow and the agents it runs.
---

# How it works

This page gives you two things: the words every other page uses, each defined once, and what
`awf` does between your workflow and the coding agents it runs, down to the command an agent
types to hand back its answer.

<!--@include: ../parts/how-it-works-steps.md-->

The workflow is all you write. awf is the engine, and `wfa` is the command it gives each agent to
answer with.

## A small workflow

<<< @/../examples/site/guide/how-it-works.ts

Saved as `check-readme.ts`, it runs with:

```sh
awf run check-readme.ts
```

Every word on this page is in those lines: a **workflow** that `awf run` starts as a **run**, one
**stage** named `review`, one **agent** on the claude **harness** in its **TUI**, one **turn**, and
its **outcome**.

## The words

**Workflow.** A TypeScript module whose default export is `defineWorkflow({ meta, run })`. awf
calls `run(wf, args)`, where `wf` is the workflow's context: everything it can do, from opening
agents to keeping stages. Control flow is plain TypeScript: `for`, `if`, `Promise.all`. A workflow
is trusted code and runs with your filesystem and process authority.

**Run.** One piece of work: what `awf run` makes of a workflow and its arguments. A run is named
`{workflow}/{id}`, from `meta.name` and an id that `--id` gives, the workflow's `id(args)` makes,
or awf generates. Each `awf run` of it is an **attempt**: `awf run {file} --id {id} --continue`
makes another attempt of the same run. What a run keeps is in [The record](#the-record), and
[Runs](/guide/runs) has the rest.

**Agent.** A coding agent the workflow opened with `wf.agents.open`, named in the run by its
`key` ([Agents](/guide/agents)). It keeps one session for the whole run, so each turn you give it continues from what it
already did. When the run ends, however it ends, awf closes every agent whose pane the workflow
didn't ask to keep.

**Turn.** One prompt given to an agent, and the work it does on it: `agent.run({ prompt, schema })`. The agent gets
the prompt, works, and answers with `wfa result`. A turn ends exactly once, with an outcome.

**Outcome.** How a turn ended. `answered` carries `value`: the answer, checked against the turn's
`schema`, or a string when there is none. Every other kind carries a `reason`: `unanswered`,
`blocked`, `timed-out`, `failed` or `cancelled`. `outcome.answered` tells them apart and types
the value. [Outcomes](/reference/workflow-api#outcomes) says what each kind means.

**Harness.** The coding-agent CLI an agent runs in: `claude` (Claude Code), `codex`, `pi` or
`cursor`, logged in as you already are. An agent's `runtime` picks the harness and model, either
spelled out, `{ harness: "codex", model: "gpt-6-luna" }`, or by an alias: `"claude"` and `"codex"`
are built in ([Harnesses](/guide/harnesses)).

**TUI.** How an agent runs by default: the harness's own terminal interface, kept between turns,
in a pane of [Herdr](https://herdr.dev), a terminal multiplexer, where you can watch it work and
type into it. Each TUI agent gets a tab in the run's Herdr workspace unless the workflow groups it
with another, or you start the run in another workspace. The other placement is `headless`: the harness runs as a plain process, one per turn,
with nothing to watch ([Where panes go](/guide/harnesses#where-panes-go)).

**Stage.** A named step the run records when it ends: `wf.stage(name, { result }, work)`. With
`{ result }` it returns a value the record keeps. When an attempt stops part-way, `--continue`
reuses the stages that succeeded, up to the first that didn't, and runs that one and every stage
after it again ([Stages](/guide/runs#stages)).

**Nudge.** What awf does when an agent stops without answering: it prompts the same session
again and asks for the answer. `nudge: false` on a turn turns it off
([Nudges](/guide/timeouts#nudges)).

Two more names: `wf` is a workflow's context, and `wfa` is the agent's command. A person never
types `wfa`; an agent does, in its own session. The operator's command is `awf`
([every command](/reference/awf)).

## What `awf run` does

1. **Loads the workflow.** It imports the file, turns the command line after `--` into `args`
   with the workflow's `prepare`, and opens the run's folder.
2. **Opens each agent in its harness** when the workflow calls `wf.agents.open`: in its TUI in a
   Herdr pane, or headless, working in `--cwd` (the current directory by default), with the instructions,
   skills and sandbox the workflow gave it.
3. **Gives each agent its own socket.** awf opens a socket for that agent alone, and gives the
   agent a `wfa` command that answers over it. The prompt names the command by its full path.
4. **Sends each turn** as the workflow's prompt, followed by how to answer: the `wfa result`
   command, the turn's call id and, for a `schema`, its fields.
5. **Checks the answer.** A value that doesn't fit the schema is refused with the reason, and
   the agent corrects it and sends it again within the same turn. A value that fits closes the
   call and ends the turn `answered`. Nothing the agent prints to its terminal counts as an
   answer.
6. **Watches the turn.** An agent that stops without answering gets a nudge; if it still
   doesn't answer, the turn ends `unanswered`. A deadline that passes ends it
   `timed-out`, and a question only a person can answer, such as a permission prompt, ends it
   `blocked`.
7. **Ends the run.** It closes every agent, except a pane you keep (`awf run --keep-panes`), and
   every sandbox, keeps the record, and prints the
   workflow's result, or why it stopped or failed.

## What the agent sees

The agent gets its working directory, the workflow's instructions, and each turn's prompt. For
the workflow above, a turn's prompt ends like this:

```text
Read README.md and check every command it shows against the code.

When the answer is ready, return it by running:

/…/wfa result <call-id> --verdict approve|revise

Put every value in single quotes; a ' inside a value is written '\''.
```

A schema with up to six plain fields (strings, numbers, booleans or a choice of words) is taught
as flags, as here. Any other is sent whole, and the agent answers with JSON on standard input:

```sh
/…/wfa result <call-id> <<'WF_JSON'
{"findings": [{"file": "src/app.ts", "problem": "..."}]}
WF_JSON
```

The agent never sees the workflow, `wf`, or what the run has used, and of the other agents only
the peers the workflow granted it routes to. The call id
names this one turn, and the socket names the agent: an agent can't answer another agent's turn,
or a turn that has already ended.

## The `wfa` commands

The agent's prompt teaches it each command it may use, so the workflow never mentions them. The
one every turn uses hands back the answer:

```sh
wfa result <call-id> --verdict 'approve'      # as flags, for a simple schema
wfa result <call-id> <<'WF_JSON'              # as JSON on standard input, for any other
{"verdict": "approve"}
WF_JSON
```

A refused answer comes back with what to fix, and the agent sends it again in the same turn.
The others:

| Command | What the agent uses it for |
| --- | --- |
| `wfa waiting` | To say it is still on long work, such as a build, when it gets a nudge. Offered to claude TUI agents today. |
| `wfa tool` | To call one of the workflow's [tools](/guide/tools), code of yours, mid-turn. |
| `wfa peers` | To list who it may [message](/guide/messaging). |
| `wfa send` | To message a peer, or ask one a question. |
| `wfa reply` | To answer a peer's question. |

[`wfa`](/reference/wfa) has each command's flags, exit codes and refusals.

## The record

A run is kept in `.awf/runs/{workflow}/{id}` under `--cwd`. `--run-root {dir}` replaces
`.awf/runs`, so the run lands in `{dir}/{workflow}/{id}`. In it:

- **`output.json`**: the result, what each agent used, and how the attempt ended. A run that
  failed or was cancelled once its agents started keeps one too. `awf run --json` prints it.
- **`report.md`**, when the workflow's `report` writes one.
- The engine's records of each attempt, stage and turn, which `awf runs` and `awf logs` read and
  `--continue` reuses.

The first time awf makes a run under a runs folder, it writes a `.gitignore` there holding `*`,
so no run is committed by accident. [Data](/reference/data) has every file in a run's folder.

```sh
awf runs   # the runs here, newest first
awf logs   # what the newest run did, and its agents
```

## Catches

- **Only `wfa result` is an answer.** An agent that writes its answer in its terminal and stops
  gets a nudge, then ends `unanswered`. A schema doesn't change that; it only says what the
  answer must look like.
- **The socket says who is answering; it doesn't isolate anyone.** Every agent runs as your user.
  One outside a sandbox can read and write what you can, a sibling's files included:
  [Security](/guide/security).
- **`wfa` works only through the launcher awf wrote** for that agent and that run. Run on its
  own, it refuses.

## Next

- [Agents](/guide/agents), the first of the Learn pages, or [the review loop](/patterns/review-loop)
  for a whole workflow.
- [The workflow API](/reference/workflow-api): every call, option and default, on one page;
  [A workflow file](/reference/workflow-api#a-workflow-file) and
  [Stages](/reference/workflow-api#stages) for what this page touched.
- [The testing API](/reference/testing-api): run a workflow on scripted answers, no agents and no
  cost, as this page's sample is.
