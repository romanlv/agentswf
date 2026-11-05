---
title: Agents
description: "Calling an agent from a workflow: opening one, giving it turns, getting a typed answer back, what each outcome means, and compacting, switching and forking its session."
---

# Agents

An agent is a coding agent, such as Claude Code or codex, that your workflow opens and gives work
to. You ask it something in a turn, it works in your repository as it always does, and you get
back an outcome: a checked answer in the shape you asked for, or a reason it has none. This page
is how you call an agent and what comes back. The words agent, turn, outcome and harness are
defined in [How it works](/guide/how-it-works#the-words).

## A first agent

<<< @/../examples/site/guide/agents.ts#first

Saved as `scope-issue/workflow.ts`, the folder layout `awf init` makes, it runs with:

```sh
awf run scope-issue/workflow.ts
```

Three calls do the work:

- **`wf.agents.open`** starts a claude agent named `scoper` in this run, with standing
  instructions.
- **`scoper.run`** gives it one turn: the prompt, and the `schema` its answer must fit.
- **`outcome.answered`** tells a checked answer from every other ending, and types
  `outcome.value` as the schema says.

`wf.stop` ends the run with a reason, and `wf.log` adds a line to its log: both are on
[Workflows](/guide/workflows#stopping-with-a-reason) and in [the reference](/reference/workflow-api#at-a-glance).

## Opening an agent

```ts
const agent = await wf.agents.open({ key: "scoper", runtime: "claude", instructions: "…" });
```

- **`key`** names the agent in this run, in its record and its pane's tab. Opening the same key
  again returns the same agent; opening it with a different spec rejects.
- **`runtime`** picks the harness and model: an alias, `"claude"` or `"codex"`, or spelled out,
  `{ harness: "codex", model: "gpt-6-luna", effort: "high" }`, or an alias with your own effort,
  `{ alias: "codex", effort: "high" }`. TUI or headless, and which models
  and efforts each harness takes, are on [Harnesses](/guide/harnesses).
- **`instructions`** are standing instructions. They go ahead of the agent's first prompt, so
  they stay in its session for every turn after.
- **`skills`**, **`sandbox`**, **`cwd`** and **`tools`**: [Skills](#instructions-and-skills) are
  below; [Sandboxes](/guide/sandboxes) and [Tools](/guide/tools) have pages of their own. `cwd`
  is where the agent works, the run's working directory by default.

An agent stays open until the run ends, a turn of it fails or times out, or you stop it. When it
has nothing more to do, `await scoper.close()` closes it for good, so its pane doesn't sit idle;
opening that key again rejects.

## A typed answer

A turn with a `schema` ends `answered` only with a value that fits it. The agent hands its answer
back with `wfa result`, the engine checks it, and a value that doesn't fit is refused with the
reason. The agent fixes it and sends it again within the same turn.
[What the agent sees](/guide/how-it-works#what-the-agent-sees) shows the command it is taught.

```ts
const SCOPE = typed(Type.Object({ files: Type.Array(Type.String()) }, { additionalProperties: false }));
const { outcome } = await scoper.run({ prompt, schema: SCOPE });
```

- **Write the schema with [TypeBox](https://github.com/sinclairzx81/typebox)**, or any library
  that produces JSON Schema, or as a plain JSON Schema object.
- **`typed(...)`**, from `agentswf/typebox`, gives `outcome.value` its TypeScript type. A bare
  TypeBox schema doesn't carry one by itself, so without it the value is untyped JSON. It returns
  the schema unchanged.
- **Without a schema** the answer is a string: whatever the agent hands back with `wfa result`.
- **`additionalProperties: false`** on every object refuses fields you didn't ask for.

The engine checks a small subset of JSON Schema: one whose every rule an agent can act on when
it is refused.

| Type | What it can say |
| --- | --- |
| `object` | `properties`, `required`, `additionalProperties: true \| false` |
| `array` | `items`, `minItems` |
| `string` | `const`, `enum`, `minLength` |
| `number`, `integer` | `const`, `minimum`, `maximum` |
| `boolean` | `const` |
| `null` | nothing more |
| any | `anyOf`, a bare `enum`, and notes such as `description`, `title`, `default`, `examples` |

Any other keyword, such as `pattern`, `format` or `maxLength`, rejects the turn before the agent
is asked: `output schema keyword "pattern" is unsupported`.

## What each ending means

`run` resolves to `{ outcome }`. A turn ends exactly once, and every ending is a value, never an
exception. `outcome.kind` is one of six:

| `kind` | What happened | The agent after it | What you usually do |
| --- | --- | --- | --- |
| `answered` | It handed back a value that fits the schema: `outcome.value`. | open | Use the value. |
| `unanswered` | It stopped working without an accepted answer, even after a nudge asked it for one. | open | Ask again, differently, or give up on this piece. |
| `blocked` | It is showing a question only a person can answer, such as a permission prompt. | open | Stop, or let someone answer it in its pane. |
| `timed-out` | The turn's deadline passed first. | closed | Stop, or open a new agent with more time. |
| `failed` | Something broke: the harness crashed, the model errored, or there is no login. | closed | Stop. A missing login is below. |
| `cancelled` | The run, an enclosing scope, or `agent.close()` stopped it. | open after a scope's cancel; closed for good after `close()` | Nothing: your workflow or the run is already stopping it. |

Every kind but `answered` carries `outcome.reason`, a sentence for a person and the run's record,
such as `agent settled without an accepted result`. Branch on `kind`, not on the reason's words.

**A turn that fails or times out closes its agent.** The next `run`, `compact`, `set` or `fork`
on it rejects with `logical agent is closed`, for the rest of the run; opening its key again
returns the same closed agent, so a fresh agent needs another key. After `unanswered` or
`blocked` the agent is still open, its session intact.

**A missing login** fails the turn with `outcome.login`: which harness, and what the operator
runs to log in. Every agent on that harness fails the same way until they do, so stop the run
rather than spend the rest of it:

<<< @/../examples/site/guide/agents.ts#login

`failed` also carries `retryable`, whether trying again might help.

**`run` rejects** only for a mistake in the workflow, such as an unsupported schema or a closed
agent, or when the deadline around the whole scope has passed. A turn's own timeout is an
outcome.

**An agent that stops without answering** gets a nudge before the turn ends `unanswered`.
`timeout` bounds a turn, nudges included, and the `nudge` option changes or turns them off:
[Timeouts](/guide/timeouts).

## Several turns

Each `run` on the same agent continues its session, so the agent remembers what it read, did and
answered. A second turn can build on the first without repeating it:

<<< @/../examples/site/guide/agents.ts#turns

Turns on one agent run one at a time, in the order you call them. Different agents work at
once: [Parallel](/guide/parallel-and-loops). An agent that does work and another that checks it, turn after
turn, is a [loop](/guide/parallel-and-loops#round-after-round).

## Compact, switch, fork

A long session fills the agent's context, and you can act on it without starting over.

**`compact`** runs the harness's own compaction, as typing `/compact` with a focus does. The
prompt says what to keep; the next turn goes on in the compacted session.

<<< @/../examples/site/guide/agents.ts#compact

`compact`, like `set`, returns an outcome, not `{ outcome }`. `answered` means it compacted, with the harness's summary
as the value where it shows one; any other outcome leaves the context as it was, so going on is
usually right.

**`fork`** opens new agents on a copy of this agent's session, so each starts knowing what it
knew, without being told again and with that context read from the provider's cache. From then
on, neither sees the other's turns.

<<< @/../examples/site/guide/agents.ts#fork

A fork has its parent's harness, model, effort, working directory, sandbox and skills, and may
name its own `instructions`, and a `runtime` of `placement`, `metered` and `effort`, never a
harness or model. It has its parent's tools unless it names
its own `tools`, which replace them (`{}` gives none): [Tools](/guide/tools). It rejects before
the parent's first turn.

**`set`** switches the model, the effort or both for every later turn, as `/model` and `/effort`
do. The session and its context stay.

<<< @/../examples/site/guide/agents.ts#set

`agent.execution` shows the settings now in force. `set` rejects before it runs for an effort
the harness doesn't list, or where the harness can't switch. Switching the model costs the cache: the next
turn reads the whole context again at full price.

Which harness does each, in its TUI or headless, is in the reference:
[compact](/reference/workflow-api#compacting-keep-the-agent-shrink-its-context),
[set](/reference/workflow-api#switching-model-or-effort-set),
[fork](/reference/workflow-api#forking-new-agents-that-start-from-what-one-knows).

## Instructions and skills

**Instructions** are what the agent is for, said once: "You review for security; you never
change code." Put what changes per turn in the prompt.

**Skills** are folders holding a `SKILL.md`, which the agent finds by their description and uses
when a task fits. `skills` lists exactly the skills an agent gets:

<<< @/../examples/site/guide/agents.ts#skills

- **`{ path }`** is a folder on disk. Name one beside the workflow with
  `new URL("./skills/name", import.meta.url)`; a relative path is refused.
- **`{ repo: "owner/repo", skill: "name", ref: "v1.2" }`** is a public skill from GitHub or a
  git URL, fetched at `ref`, or at the default branch as it is when the run starts. Pin a `ref`
  for runs you compare.
- **`skills: []`** gives none. **Left out**, the agent has the skills it would have without awf:
  yours on the host, none in a sandbox.

Each agent gets a copy of its own, so an agent can't change the skill another one runs. A skill
that can't be found or read, or a `SKILL.md` without a `name` and `description` in its
frontmatter, makes `open` reject. The harness's own bundled skills, and claude's and codex's
skills in the working directory, stay either way. cursor takes skills only in a sandbox: on the
host, a cursor agent with `skills` is refused.

## Catches

- **A field's `description` reaches the agent only when the schema is sent whole.** A schema of up
  to six plain fields (strings, numbers, booleans, a choice of words) is taught as flags,
  `--risk low|medium|high`, without its descriptions. Say what each field means in the prompt.
- **A scripted test checks your branches, not the agent.** Every ending in the table above can be
  scripted, for free: [Testing](/guide/testing).

## Next

- [The workflow API: Agents](/reference/workflow-api#agents): every option of `open`, `run`,
  `compact`, `set` and `fork`, with its default.
- [Harnesses](/guide/harnesses): claude, codex, pi and cursor; models and effort; TUI or
  headless.
- [The review loop](/patterns/review-loop): one agent implements, another reviews, until approved.
