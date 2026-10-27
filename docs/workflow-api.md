# The workflow API

A workflow is a TypeScript file whose `run` is an ordinary async function. You open agents, give
them work, and get typed answers back. Loops, branches and `Promise`s are plain TypeScript. The
engine owns the rest: agent processes, sessions, deadlines, sandboxes, cleanup and the run's
record.

This page covers every call you can make today. [README](../README.md) shows what they add up
to, [`examples/`](../examples) has complete workflows, and
[`packages/contract/src/workflow`](../packages/contract/src/workflow) has the types, with every
field documented.

## At a glance

```ts
workflow.agents.open({ key, runtime, instructions?, skills?, sandbox?, cwd?, layout?, keepPane?, tools? })  // → agent
agent.run({ prompt, schema?, timeoutMs?, label?, nudge? })  // → { outcome }; the same agent keeps its session
agent.compact({ prompt })                                    // → outcome; the harness's own compaction, with a focus
agent.set({ model?, effort? })                               // → outcome; later turns run at these, in the same session
agent.fork({ key, placement?, effort?, instructions?, layout?, keepPane?, tools? })  // → a new agent on a copy of this one's session
workflow.agents.stop(key, reason?)                          // → boolean; true once done, false if absent or already stopped
workflow.agents.caller({ key })                              // → the session `awf run --here` was typed in, or null
workflow.agents.forkCaller({ key, placement?, effort?, instructions?, layout?, keepPane? })  // → a new agent on a copy of the session awf run was started from, or null
isAnswered(outcome)                                          // narrows to { kind: "answered", value }
tool({ description, input?, handler, timeoutMs? })           // → a tool the agent calls mid-turn with `wf tool`

workflow.parallel(items, (item, i) => …, { concurrency?, label?, deadline? })  // → results in item order
workflow.sandboxes.open({ key, write?, read?, network?, sockets?, webSearch?, srt? | docker? }) // → pass as { sandbox }
workflow.decisions.decide({ key, model: "jev", state, questions })              // → { answers } in ~200 ms
workflow.messages.allow({ from, to, purpose, maxMessages?, timeoutMs? } | { between: [a, b], purpose, … })  // agents may message
workflow.participants.connect({ key, labels? })               // → a coordinator outside the run, a route end; .release(reason?)

workflow.stage(name, { result, summary? }?, async () => …)  // → its value; reused on a continue
workflow.stop(reason)                                         // ends the attempt stopped

// A workflow with events: definition { file: import.meta.path, events, starts? }; a sender names the run
workflow.receive({ label?, until?, take? })                   // → the events not yet acknowledged
agent.start({ prompt, schema?, meta? })   agent.turn          // a turn not awaited; its end is agent:ended
agent.ended<Meta, T>(e)   participant.replied(e)              // narrow awf's events
workflow.participants.connect({ key, to: "code" })            // replies come as participant:reply; .post(text)
workflow.emit(target, name, data, { id? })                    // → "accepted" | "duplicate" | "refused"

workflow.log(message, fields?)   workflow.usage()   workflow.deadline   workflow.cwd
workflow.runId   workflow.attempt
workflow.allowance(harness)                                   // → what is left of its plan, as `awf allowance` reads it

// In a test, from "agentswf/testing"; `awf test` runs it:
testWorkflow(workflow, args, { agents?, messages?, coordinators?, compactions?, awaitReply?, decisions?, allowance?, runtimes?,
                              caller?, timeoutMs?, stallMs?, cwd?, recorded?, fromStage?, values? })  // → run
testWorkflow(eventWorkflow, { id, event?, files?, events?: [{ during: "agent#1", name, data, from? }], maxTurns?, … })  // → run, .emits, .parked
answer(SCHEMA, value | (turn) => value)   answer("text")   reply.waiting(reason, timeoutMs?) | silent() | blocked() | failed() | needsLogin(provider?) | timedOut() | hang() | interrupted()
```

| Concept | In one line |
| --- | --- |
| **Workflow** | A file that exports `defineExecutableWorkflow(…)`, which `awf run file.ts` runs, or `defineEventWorkflow(…)`, which events start. |
| **Agent** | A coding agent (claude, codex, pi, cursor) behind a key. It keeps its session between turns. |
| **Turn** | One `agent.run`: a prompt in, one outcome out. The answer is JSON checked against your schema. |
| **Outcome** | Always a value, never an exception: `answered`, `unanswered`, `blocked`, `timed-out`, `failed` or `cancelled`. |
| **Deadline** | Set where you want one. A child's deadline can be earlier than its parent's, never later. |
| **Sandbox** | What agents inside it can read, write and reach. They share it or get a private one. |
| **Decision** | Closed questions to a decision model (Jev). It returns probabilities, and no agent is involved. |
| **Route** | Lets one agent message another while both work, for a purpose the workflow states. |
| **Coordinator** | A participant outside the run that agents report to and ask; a terminal, a session or an app answers for it. |
| **Run** | One piece of work, with an id. Each `awf run` of it is an attempt; `--continue` adds one. |
| **Stage** | A named step of a run. A continue reuses what stages succeeded and runs the rest. |
| **Event** | Starts the run its sender names, or lands in its mailbox; the run takes it at a wait, and parks between events. |

## A workflow file

```ts
// summarize.ts
import { defineExecutableWorkflow, isAnswered } from "agentswf/workflow";
import Type from "typebox";

export const SUMMARY = Type.Object({ summary: Type.String() }, { additionalProperties: false });

export default defineExecutableWorkflow({
  definition: {
    meta: { name: "summarize", description: "Summarize one file." },
    async run(workflow, args: { file: string }) {
      const agent = await workflow.agents.open({ key: "reader", runtime: "claude" });
      const { outcome } = await agent.run<Type.Static<typeof SUMMARY>>({
        prompt: `Read ${args.file} and summarize it in two sentences.`,
        schema: SUMMARY,
      });
      return isAnswered(outcome) ? outcome.value : { summary: `no answer: ${outcome.reason}` };
    },
  },
  // Turns the command line into args: `awf run summarize.ts -- src/index.ts`.
  prepare: ({ argv }) => ({ file: argv[0] ?? "README.md" }),
  // Optional: what a person sees at the terminal instead of the JSON.
  present: (result) => result.summary,
  // Optional: Markdown saved beside the run as report.md.
  report: (result) => (result ? `# Summary\n\n${result.summary}\n` : undefined),
});
```

- **`definition`** is `meta` and `run(workflow, args)`. Args and result must be JSON.
  `meta.name` names the folder its runs are kept in (letters, digits, `.`, `_`, `@` and `-`). An optional
  `meta.version` is semver; [Stages](#stages) says what it guards.
- **`prepare`** turns the command line (`argv` after `--`, and `cwd`) into args.
- **`id(args)`**, optional, names the run, such as by a ticket's key; `--id` overrides it. A run's
  ref is `{workflow}/{id}`, for this workflow and one with [events](#events) alike.
- **`present(value, ending)`**, optional, is what a completed attempt prints. Without it, or when
  it returns `undefined`, `awf run` prints the result as JSON; `--json` always prints the record.
- **`report(value, ending)`**, optional, is called however the attempt ended, so a stopped run
  can still hand off what its stages found. `value` is `undefined` unless the attempt completed;
  `ending` says how it ended, in which `stage`, why, the `continue` command, and each stage's
  `summary` and `value`. Returning `undefined` writes no report.

The result, every agent's usage and how the attempt ended are kept in `output.json`, in
`.awf/runs/{workflow}/{id}` under the working directory, for failed and cancelled runs too.

## Agents

### Opening one

```ts
const reviewer = await workflow.agents.open({
  key: "review:security",
  runtime: { harness: "claude", model: "claude-sonnet-5-5" },  // placement defaults to "pane"
  instructions: "You review code for security problems. Report; don't fix.",
});
```

| Field | What it does |
| --- | --- |
| `key` | The agent's name in this run. Opening the same key again returns the same agent. In a run without stages, the part before `:` groups its cost, so `review:security` and `review:style` add up under `review`. |
| `runtime` | An alias (`"claude"`, `"codex"`), or `{ harness, model, effort?, placement?, metered? }`, or `{ alias, … }` to constrain an alias. |
| `effort` | How hard it thinks, in the harness's own words: claude's `low` to `max`, codex's `low` to `ultra`, pi's `off` to `max`. cursor takes none: name the variant as the model (`gpt-5.6-luna-high`). Left out, the harness uses its default. |
| `placement` | `"pane"` (the default), a terminal pane in [Herdr](https://herdr.dev) you can watch and type into, or `"headless"`, a process per turn. |
| `metered: true` | Required for headless claude, which is billed per token even on a subscription. A claude pane runs on your plan. |
| `instructions` | Standing instructions, given once when the agent opens. |
| `skills` | Exactly the skills this agent gets: `{ path }` for a directory holding a `SKILL.md`, or `{ repo: "owner/repo", skill, ref? }`. |
| `sandbox` | A sandbox from `workflow.sandboxes.open`, or an inline spec for a private one. Left out, the agent is unsandboxed. |
| `cwd` | Where the agent works; `workflow.cwd` by default, which `awf run --cwd` sets. |
| `layout`, `keepPane` | Where its pane appears, and whether it stays once the agent is done. See [Where panes go](#where-panes-go-layout-and-keeppane). |
| `tools` | What it can ask your code to do mid-turn. See [Tools](#tools-the-agent-calls-your-code). |

Each harness uses your existing login.

### Giving it work

```ts
const FINDINGS = Type.Object(
  { findings: Type.Array(Type.Object({ file: Type.String(), problem: Type.String() })) },
  { additionalProperties: false },
);

const { outcome } = await reviewer.run<Type.Static<typeof FINDINGS>>({
  prompt: "Review the diff on this branch against main.",
  schema: FINDINGS,
  timeoutMs: 15 * 60_000,
  label: "first pass",
});
```

- **With a `schema`**, the agent answers by running `wf result`, as its prompt tells it: with flags,
  `--verdict 'approve'`, for an object of up to 6 strings, numbers, booleans or enums, else with
  JSON. The engine checks it, and a refused answer can be retried within the same turn.
- **Without a schema**, the answer is a string.
- **The type argument** (`run<Type.Static<typeof X>>`) gives the answer its TypeScript type; a
  TypeBox schema doesn't carry one on its own.
- **`timeoutMs`** bounds the whole turn, recovery included, within the enclosing
  [deadline](#deadlines).
- **`nudge`** is the recovery for an agent that goes quiet: the engine checks in and asks for its
  answer. `nudge: false` turns it off; `nudge: { prompt }` adds to what the check-in says. An
  agent with long work in progress can say so with `wf waiting`, where its placement supports it
  (claude panes today), and is checked in on again later, within the same deadline.

### Outcomes

`run` resolves to `{ outcome }`, and rejects only when the whole scope's deadline has passed:

| `kind` | Meaning |
| --- | --- |
| `answered` | `outcome.value` is the checked answer. |
| `unanswered` | The agent stopped without an accepted answer, even after a check-in. |
| `blocked` | The agent is showing a question only a person can answer, such as a permission prompt. |
| `timed-out` | The turn's deadline passed. |
| `failed` | Something broke. `retryable` says whether trying again might help. `login` is set when the harness has no login: `{ harness, provider?, run }`, with `run` saying what the operator should run. |
| `cancelled` | The run or an enclosing scope was stopped. |

```ts
if (!isAnswered(outcome)) return { error: `${outcome.kind}: ${outcome.reason}` };
outcome.value.findings; // typed
```

A missing login fails every agent on that harness the same way, so a workflow that shouldn't
spend the rest stops on it:

```ts
if (outcome.kind === "failed" && outcome.login) workflow.stop(outcome.reason);
// "pi needs a login for openai-codex: run `pi`, then /login (pi said: OAuth refresh failed …)"
```

**A turn that fails or times out closes its agent**, and the agent takes no more turns. The
calling session is the exception.

`workflow.agents.stop(key, reason?)` closes an agent the workflow is done with, such as a lens
that has answered, so it doesn't sit idle until the run ends. A turn it is running ends
`cancelled`, and its key can't be opened again. It resolves `true` once the agent is closed, and
`false` for a key never opened or already stopped. Stopping the calling session hands it back to
its operator then rather than at the end of the run.

### Sessions: talk to the same agent again

Every `run` on the same agent continues its session, so it remembers what it did. That is how you
build loops: ask for work, check it, ask for a fix, with a different typed answer each time.

```ts
const builder = await workflow.agents.open({ key: "build", runtime: "claude" });
await builder.run({ prompt: "Implement the plan in PLAN.md.", schema: DONE });

for (let round = 1; round <= 3; round++) {
  const { outcome } = await critic.run<Review>({ prompt: "Review the change.", schema: REVIEW });
  if (!isAnswered(outcome) || outcome.value.approved) break;
  await builder.run({ prompt: `Fix these:\n${outcome.value.notes}`, schema: DONE });
}
```

### Compacting: keep the agent, shrink its context

`compact` runs the harness's own compaction, as `/compact` with a focus does. The `prompt` says
what to keep and what to drop; the next `run` goes on in the compacted session.

```ts
const compacted = await builder.compact({
  prompt: "Keep the plan's decisions, the branch and the worktree. Drop file contents.",
});
if (!isAnswered(compacted)) workflow.log("compaction didn't finish", { reason: compacted.reason });
```

- **`answered`** means it compacted. `value` is the summary from claude and pi, and `""` from
  codex, which keeps it encrypted.
- **Any other outcome** leaves the context as it was, so going on is usually right.
- **Where:** claude, codex and pi, in a pane or headless; cursor in a pane only. pi only
  summarizes what is older than its last 20k tokens, so a short pi session fails "nothing to
  compact".
- It runs after the agent's earlier turns, bounded like `run`.

### Switching model or effort: `set`

`set` switches the model, the effort or both for every later operation, as `/model` or `/effort`
does. The session and its context stay.

```ts
const reviewer = await workflow.agents.open({ key: "reviewer", runtime: { alias: "codex", effort: "high" } });
const findings = await reviewer.run({ prompt: review, schema: FINDINGS });  // high
await reviewer.set({ effort: "low" });
const summary = await reviewer.run({ prompt: "Summarise." });               // low, and every turn after
```

- **`answered`** means the switch is in force, and `agent.execution` shows the new settings.
- **It is refused** for an effort the harness doesn't list, for the calling session, and in a
  cursor pane. Another harness or placement is another agent.
- **A pane whose switch fails is closed**, as after a failed turn.
- **Switching the model costs the cache**: the next turn reads the whole context at full price.

### Forking: new agents that start from what one knows

`fork` opens a new agent on a copy of this agent's session, so it knows what this agent knew
without being told again, and reads that context from the provider's cache
([ADR 0009](adr/0009-a-fork-is-a-new-agent-on-a-copy-of-the-session.md)).

```ts
await worker.run({ prompt: "Read the ticket and plan the change.", schema: PLAN });
const [security, tests] = await Promise.all([
  worker.fork({ key: "security", instructions: "Review the plan for security." }),
  worker.fork({ key: "tests" }),
]);
```

- **The copy is taken when `fork` is called**, after the agent's earlier operations. From then on
  neither sees the other's turns.
- **A fork has its parent's** harness, model, effort, working directory, sandbox and skills. It may
  name its own `placement`, `effort`, `instructions` and `labels`, but never inherits `layout` or
  `keepPane`: without them it gets a tab of its own.
- **It rejects** before the parent's first turn and once the parent is closed. Every harness
  forks, in a pane or headless, sandboxed too.

### Where panes go: `layout` and `keepPane`

Each pane agent gets a tab of its own in the run's Herdr workspace, closed once it is done. A
workflow can place it elsewhere as it opens, or at its first turn in a workflow with events
([design](design/pane-layout.md)):

```ts
const lead = await workflow.agents.open({
  key: "lead",
  runtime: "claude",
  layout: { workspace: "origin", tab: "review" },  // a tab where `awf run` was typed
  keepPane: "on-failure",
});
await lead.run({ prompt: "Read the change and plan the review." });
const security = await lead.fork({ key: "security", layout: { beside: "lead", side: "right" } });
const style = await lead.fork({ key: "style", layout: { beside: "security", side: "below" } });
```

- **A new tab**: `{ session?, workspace?, tab? }`. `workspace` is `"run"` (the default),
  `"origin"`, where `awf run` was typed, or `{ name }`, made if missing. `tab` defaults to the key.
- **Beside another agent**: `{ beside: key, side: "right" | "below", share? }` splits that agent's
  pane; `share`, 0.2 to 0.8, is the new pane's part.
- **A layout that can't be used** falls back to a tab of its own, and never fails the agent. The
  run's closing lines say which agent fell back and why. Headless and sandboxed agents take no
  layout.
- **`keepPane`**, `"never"` (the default), `"on-failure"` or `"always"`, keeps the pane once the
  agent is done. Its harness is left running and released: what you type into it is yours. awf
  never closes a kept pane.

### The calling session

`awf run --here`, typed in a claude, codex, pi or cursor session in a Herdr pane, starts the run in
a tab of its own, and the run can drive that session as an agent
([ADR 0010](adr/0010-the-calling-session-is-an-agent.md)):

```ts
const author = await workflow.agents.caller({ key: "author" });
if (!author) throw new Error("start this workflow with awf run --here from an agent");
const { outcome } = await author.run({ prompt: "Pick a number and remember it.", schema: PICKED });
```

- **`null`** means there is no calling session: refuse, or open an agent of your own.
- **It is the operator's session**, so it takes no `instructions`, refuses `compact` and `set`, and
  stays usable after a turn that fails or times out. The operator interrupting a turn settles it
  `cancelled`.
- **When the run ends**, the session gets one message saying how and where the run's records
  are. A run that is killed sends none.

### Forking the session that started the run

`forkCaller` opens an agent that knows what the session `awf run` was started from knows, without
spending that session's context on the work. The session waits on `awf run` as an ordinary
command and reads the result as its output.

```ts
const fixer =
  (await workflow.agents.forkCaller({ key: "fixer", layout: { workspace: "origin" } })) ??
  (await workflow.agents.open({ key: "fixer", runtime: "claude" }));
```

- **`null`** means there is no session to fork, and the run's output says why.
- **The copy** holds the session up to the command that started the run. The fork runs on the
  model the session last ran, with awf's launch flags and the operator's skills, not their
  settings or MCP servers.
- **Under codex's default sandbox**, the run is inside it and pane agents can't reach Herdr. The
  `awf-run` skill says how each harness waits on a long run.

## `parallel`

`Promise.all` with a concurrency limit and a deadline, which the engine tracks and shows. Results
come back in item order.

```ts
const LENSES = ["security", "correctness", "tests"] as const;

const reviews = await workflow.parallel(
  LENSES,
  async (lens) => {
    const agent = await workflow.agents.open({ key: `review:${lens}`, runtime: "codex" });
    const { outcome } = await agent.run<Findings>({ prompt: `Review for ${lens}.`, schema: FINDINGS });
    return isAnswered(outcome) ? outcome.value.findings : [];
  },
  { label: "review", concurrency: 2 },
);
```

- **`concurrency`** defaults to all at once; **`label`** names the group in the live progress
  ("review 2/3"); **`deadline`** can only be earlier than the enclosing one.
- **It's fail-fast.** If one item throws, the others are cancelled and `parallel` rejects. Outcomes
  don't throw, so in the pattern above one bad agent never stops the rest.
- **It nests.** A fan-out that verifies each finding is a `parallel` inside a `parallel`.

## Stages

A run is one piece of work, kept in `.awf/runs/{workflow}/{id}`, and each `awf run` of it is an
attempt. A stage is a named step whose result the run keeps, so `awf run file.ts --continue {id}`
reuses what succeeded and picks up at the stage that didn't.

```ts
const doc = await workflow.stage("doc-review", { result: DOC, summary: (d) => d.path }, async () => {
  const doc = await ask(worker, DOC, `Review the ticket doc for ${ticket}`);
  if (doc.kind === "no-doc") workflow.stop(doc.reason); // inside: a continue redoes doc-review
  return doc;
});
await workflow.stage("notify", async () => {          // no result: it only has to happen
  await postToSlack(`${ticket}: reviewed`);
});
```

- **A stage's only output is its return value.** With `result`, it must fit the schema; without,
  the stage returns nothing. `summary(value)` is its line in the progress view.
- **A reused stage isn't run.** No agent is asked anything, and a variable assigned inside it stays
  unset.
- **Code between stages runs on every attempt**, so keep it safe to repeat. Push, post, compact or
  create inside a stage.
- **One stage at a time, each name once per attempt.** Names are lowercase letters, digits, `.`,
  `_`, `@` and `-`, starting with a letter or digit. Parallel work and loops go inside a stage. A
  workflow with `events` names a stage by its one effect instead, and enters it as often as it
  likes ([Events](#events)).
- **`workflow.stop(reason)`** ends the attempt `stopped` (exit 3) rather than failed; inside a
  stage, a continue redoes that stage. Don't catch it. Write `return workflow.stop(reason)` where
  TypeScript should know the code after it isn't reached.
- **`meta.version`** guards reuse: a record from another major version (another minor under
  `0.x`), or one whose value no longer fits its schema, stops the continue at that stage, and
  `--from-stage {stage}` redoes from there.

`workflow.runId` is the run's id and `workflow.attempt` the attempt's number. The full model is in
[`design/runs-and-stages.md`](design/runs-and-stages.md).

## Deadlines

A run has no deadline unless `awf run --timeout 2h` gives it one, as `workflow.deadline`, absent
otherwise. Everything inside inherits it, and anything can set an earlier one, never a later one:

```
run deadline (--timeout)
 └─ parallel({ deadline })          earlier or equal
     └─ agent.run({ timeoutMs })    earlier or equal
```

When a deadline passes, turns under it end `timed-out`, and `parallel` and `decide` reject with
`DeadlineExceededError`. Without any deadline, turn liveness still stops a turn that stalls. An agent
waiting on a coordinator's answer isn't working: its clock stops while it waits, within any deadline
around it. When the run ends, for any reason, every agent it opened is closed and
every sandbox torn down; only kept panes and the calling session stay.

## Sandboxes

```ts
const box = await workflow.sandboxes.open({
  key: "work",
  write: ["."],                   // the working directory is writable; everything else is read-only
  network: ["registry.npmjs.org"], // beyond each harness's own model API
  srt: {},                         // or docker: { image? }; omit both for the operator's default
});

const coder = await workflow.agents.open({ key: "code", runtime: "claude", sandbox: box });
const tester = await workflow.agents.open({ key: "test", runtime: "codex", sandbox: box });
const reader = await workflow.agents.open({
  key: "read",
  runtime: "claude",
  sandbox: { read: ["/data"] }, // an inline spec: a private sandbox for this agent only
});
```

- **`read`, `write`, `network`** say what the agents inside can see and reach. **`sockets`** names
  host unix sockets they may connect to, a socket or a directory of them, such as a browser or a
  database the workflow runs on the host. In a directory also in `write`, they can create sockets
  of their own. srt only; docker refuses it.
- **Web search is off inside unless `webSearch: true`.** claude's and codex's search runs on the
  model provider's servers, past any `network` rule, so it can carry out what the agents read.
  claude's `WebFetch` goes with it. cursor keeps its web tools either way, and pi has none.
- **`srt`** is Anthropic's sandbox-runtime, on your machine with your toolchain. **`docker`** is a
  container running as your user.
- **Agents sharing a sandbox can read each other's files**, their homes and skills included.
  Under docker they share one container; under srt each agent is wrapped on its own, and they meet
  only in the writable paths. An inline spec is always private.
- **Logins:** claude needs `CLAUDE_CODE_OAUTH_TOKEN` and cursor `CURSOR_API_KEY` in your
  environment, as their logins live in the keychain; codex and pi copy theirs in.
- **git works.** A writable worktree can commit, but its hooks and config can't be changed from
  inside.
- **The operator can sandbox the whole run instead** with `awf run --sandbox box.json`, which puts
  every agent in one sandbox. A workflow that opens its own is then refused.

## Decisions

Not every step needs a coding agent. `decide` asks a decision model closed questions about a
piece of state and returns a probability for every possible answer, in about 200 ms. The state is
billed once per call, so ask all your questions together.

```ts
import { choice, score, yesNo } from "agentswf/workflow";

const { answers } = await workflow.decisions.decide({
  key: "triage:42",   // the part before ":" is its cost group, for a run without stages
  model: "jev",
  state: { title, body },
  questions: {
    team: choice("Which team owns this?", { payments: null, accounts: "logins, profiles" }),
    bug: yesNo("Is this a bug report rather than a feature request?"),
    urgency: score("How urgent is it?", ["whenever", "this sprint", "today"]),
  },
});

answers.team.choice;          // "payments" | "accounts", typed from the options
answers.team.probabilities;   // { payments: 0.97, accounts: 0.03 }
answers.bug.yes;              // 0.91
answers.urgency.expected;     // 1.4, the probability-weighted level
```

- **`jev`** is [Jev](https://docs.typesafe.ai/concepts/system-one) through OpenRouter. It needs
  `OPENROUTER_API_KEY`, in the environment or a `.env` where you run `awf`. No agent sees the key.
- **Set your own threshold on the probabilities.** The
  [findings](findings/system-one-models.md) show Jev is reliable at matching text to options, and
  not at anything that needs reading code.
- **A decision that didn't answer rejects** with `DecisionError` (or `DeadlineExceededError`).

## Tools: the agent calls your code

A tool is a function in your workflow an agent calls while it works, and reads what it returns.
Holding a tool is what lets the agent call it.

```ts
import { tool } from "agentswf/workflow";

const triager = await workflow.agents.open({
  key: "triager",
  runtime: "codex",
  tools: {
    close_item: tool({
      description: "Close an open item as done or won't fix, saying why.",
      input: outputSchema(Type.Object({
        id: Type.String(),
        status: Type.Union([Type.Literal("done"), Type.Literal("wontfix")]),
        why: Type.String(),
      })),
      handler: ({ id, status, why }) => {
        backlog.close(id, status, why);
        return `Closed ${id}.`;
      },
    }),
    list_open: tool({ description: "The items still open, one per line.", handler: () => backlog.open() }),
  },
});
```

- **The agent's prompt teaches its tools**, in every turn: each one's name and description, and how
  to call it. A simple input, up to 6 strings, numbers, booleans or enums, is taught as flags,
  `wf tool close_item --id <text> --status done|wontfix --why <text>`, which the agent fills in
  with each value in single quotes; any other as JSON.
- **`tool()` types the handler** from `input`, which is wrapped in `outputSchema(...)` as a turn's
  `schema` is. Without `input` the tool takes none.
- **The handler runs during the turn**, while the agent waits, so keep it short. It has 30 s by
  default; `timeoutMs` sets its own, and `false` leaves only the turn's deadline. A shell command
  that runs long is backgrounded by claude after 2 minutes and cursor after 30 s, and handed back to
  codex to poll after 10 s, so a handler that answers within 10 s is never waited on that way. An
  agent that calls again with the same input while the call runs gets its answer, once; a call
  after it ended runs it again, so a handler past 10 s should be safe to repeat. A string result
  prints as is, other JSON as JSON, nothing as nothing; a throw fails the call, not the run. Input
  that doesn't fit the schema is refused before it runs, and the agent corrects it.
- **It can't give work to the agent that called it**, which is in a turn: `run`, `start`, `compact`,
  `set`, `fork`, `agents.stop` and `cancel()` on its started turn throw, as they do on an agent
  whose handler ran this one's. It may run another agent, except in the message turns a stage runs
  after its body, where no code can.
- **A fork has its parent's tools** unless its spec gives its own; `tools: {}` gives none. The calling
  session's forks take none.
- **Recorded:** each call, its input and its result or error are in the run's event log, and
  `awf logs` shows them.

## Messaging

Agents can talk to each other while they work, on routes the workflow grants. Your code grants a
route and reads typed results; what the agents say is between them.

```ts
await workflow.messages.allow({
  between: [reviewer, implementer],
  purpose: "Revise the implementation until the reviewer approves it.",
  maxMessages: 6,
});
const verdict = await reviewer.run({ prompt: "Review the change; ask the implementer for fixes.", schema: VERDICT });
```

- **A route** is `{ from, to }`, one way, or `{ between: [a, b] }`, both ways. Its `purpose` comes
  with every message. Granted inside a stage, it closes with the stage. `maxMessages` lowers the
  ceiling of 40 a route, replies included.
- **Agents use `wf`**, which their prompt teaches them: `wf peers`, `wf send {peer}`,
  `wf send --await-reply {peer}` to ask and wait, and `wf reply {peer}`.
- **A message arrives between turns**, never into a running one. An idle agent gets a turn of its
  own for it, at its own cost; a busy one gets it with its next turn. An agent that is asked a
  question can't give its result until it replies.
- **`--await-reply`** works on headless claude, codex and pi, and on a claude pane that confirms
  what it is sent. Elsewhere the agent is told to send without waiting.
- **Costs and logs:** `workflow.usage()` marks each operation a message started, and `awf run`,
  `awf logs` and `awf runs` show the messages.

### A coordinator outside the run

A workflow can let agents report to, and ask, something outside the run: a coordinator. Who answers
for it is chosen when the run starts, not here: `awf run`'s terminal, another claude or codex
session, or an app such as a Slack bridge.

```ts
const coordinator = await workflow.participants.connect({
  key: "coordinator",
  labels: { audience: "operator" },
});
await workflow.messages.allow({
  between: [investigator, coordinator],
  purpose: "report findings that hold up; ask when the logs can't settle it",
  timeoutMs: 2 * 60 * 60_000,
});
```

- **Agents talk to it as to any peer:** `wf send coordinator` reports, and
  `wf send --await-reply coordinator` asks; the answer starts the agent's next turn, in the same
  session, hours later if need be.
- **`labels`** is any JSON object for whatever answers; awf only passes it along. `operator`, `awf`,
  `system` and `user` are refused as keys.
- **`timeoutMs`**, only on a route to a coordinator, closes a question unanswered after that long;
  without it, a question waits until it is answered. An agent's `--timeout` can only shorten it.
- **It stays connected** past the workflow's return while a question to it is open, so the run
  waits for the answer. `coordinator.release(reason)` ends it sooner.
- **Run in a terminal**, `awf run` asks each question there. Otherwise the answer comes from
  `awf reply`, by a session or an app reading `awf inbox` ([`holder-cli.md`](holder-cli.md)).

claude's own messaging between sessions is a different thing, on by default:
[`design/messaging.md`](design/messaging.md#claudes-own-messaging) says what it reaches.

## Events

A workflow that reacts to things that happen declares the events it takes and which run each
belongs to. An event starts its key's run, or lands in the run's mailbox; the run takes waiting
events at a wait, handles them in plain code, and starts an agent turn only when one is needed.
Between events the run parks: its process exits, and the next event runs its code from the top.

```ts
export default defineEventWorkflow({
  definition: {
    meta: { name: "dd-case", description: "Investigate one Datadog case." },
    file: import.meta.path,                                   // where senders find it, and its runs live
    events: { "dd.changes": Changes, "dd.closed": Closed },   // a schema per name; no colon
    starts: ["dd.changes"],                                   // the events that may start one; absent, any
    async run(workflow) {
      const kase = openCase(workflow.runId);                 // state lives in files, not variables
      const investigator = await workflow.agents.open({ key: "investigator", runtime: "claude" });
      for (;;) {
        const events = await workflow.receive({ label: `${kase.unseen()} unseen` });
        for (const e of events) {
          if (investigator.ended<Given>(e) && isAnswered(e.data.outcome)) kase.markGiven(e.data.meta);
          if (e.name === "dd.closed") await workflow.stage(`close-${e.id}`, () => kase.close(e.data));
        }
        if (!investigator.turn && kase.needsLook()) {
          const given = kase.pending();
          await investigator.start({ prompt: promptFor(given), meta: given });   // returns at once
        }
      }
    },
  },
});
```

```sh
awf emit --target case.ts --run kombo-unique dd.changes '{"case":"kombo-unique"}' --id 83d34d7
```

- **Sending.** `workflow.emit(caseRun, run, name, data, { id })` imports its target, so a wrong name or
  shape fails `tsc`; `awf emit --target {file}` checks the same at run time. Either returns
  `accepted`, `duplicate` (the id is in the run's mailbox already) or `refused` (the run returned,
  or it has none and `starts` doesn't list the event). An id names one occurrence for good; without
  one, nothing deduplicates the event.
- **The run's id.** The sender names the run an event is for, as `awf send` names the run it
  writes to: `awf emit --run`, `workflow.emit`'s second argument. The ref is `{workflow}/{id}`, as
  for a run without events, and `workflow.runId` is the id. Run ids are letters, digits, `.`, `_`, `@` and `-`, starting
  with a letter or digit; event ids and stage names are the same, lowercase, so a stage named by
  an event id (`close-{id}`) is always valid.
- **Starting with no event.** `awf run {file} --id {id}` makes the run and starts it, detached in
  its project, as an event would; it runs to its first wait, which returns nothing, and parks. It
  ignores `starts`, and a run already there is
  only woken. Work to do once, on the first attempt, goes in a stage at the top of `run`.
- **`receive`** acknowledges what its last call returned, then returns every event not yet
  acknowledged, in arrival order, or the oldest alone with `take: "oldest"`. The first call takes
  the event that started the run, if one did. After a crash, the first call returns the unacknowledged batch
  again, alone. `label` is what `awf runs` shows; `until`, a time computed from the run's files,
  returns with no event once passed, and `awf tick` honours it while the run is parked.
- **Turns not awaited.** `agent.start()` takes what `run()` takes, plus `meta`, and returns once
  the turn is launched. Its end arrives at a wait as `agent:ended`, from the agent's key, with the
  outcome and `meta`; `agent.ended(e)` narrows it. `agent.turn` is set until a wait takes that end,
  and the agent refuses other work meanwhile. `agent.turn.cancel()` stops it; a tool call it has
  running is aborted through `call.signal`, and the end and `cancel()` wait for the handler, at
  most 5 s more.
- **Parking.** Waiting with nothing else of the run working (no turn, decision, sandbox or other
  stage) and nothing unacknowledged, the run ends its attempt
  `parked` and its process exits. Plain code running beside the wait, outside any awf call, is
  cut off and runs again on the continue: work that must finish goes in a stage or before the
  wait. The next event, or `awf tick` once `until` passes, continues it:
  agents reopen on their kept sessions, recorded stages are reused, and the loop's wait takes the
  new event. What must outlive that lives in files or a stage.
- **Agents on a wake.** Each agent reopens on its kept session, without its instructions again, and
  a pane agent's pane opens at its first turn. So before that turn, in an attempt, it can't be
  forked or compacted, and an agent `beside` it gets a tab of its own. An agent with skills or a
  sandbox, whose home is made anew, starts a new session, as one whose harness changed does.
- **Stages by content.** In a run with `events`, a succeeded stage is reused wherever and however
  often its name is entered, in any attempt and any version of the code, while its value fits.
  Name it by its one effect: `close-{event id}`, `post-f3@abc123`.
- **A participant routed to the code**, `connect({ key, to: "code" })`, turns each message into
  `participant:reply` from its key; `awf send {ref} --as {key} --id {message id} {text}` delivers
  one, and `participant.post(text)` writes back without a turn.
- **`return`** ends the run for good: later events for its key are refused. A run that may be
  needed again records what happened in its files and keeps waiting instead.

## Logging and usage

```ts
workflow.log("reviewed", { findings: 12 }); // a line in awf's live progress and in `awf logs`
workflow.usage();                            // this scope's finished operations: times and sessions
```

Costs are priced after the run, from each agent's tokens: each stage's line gains what its agents
cost, and one summary closes the run. `output.json` keeps the tokens, each stage's share and the
price table used.

## Plan allowance

`workflow.allowance(harness)` reads what is left of a harness's plan now, as `awf allowance` does,
with no model turn, on the login the run's agents get. It returns one harness of the
`awf.allowance/1` record: each window's `usedPercent`, its `resetsAt` and, for a window that limits
only some models, which. A `none` says why there was nothing to read, and means unknown, not room to
spare. The read isn't recorded: a continue reads again, and a stage keeps one.

```ts
// examples/event-sketches/dd-tick.ts: a tick that leaves the plan to the operator past 80%;
// a window of some models' only, as claude's `week (Fable)`, doesn't limit its sonnet
const plan = await workflow.allowance("claude");
if (plan.read === "plan" && plan.windows.some((w) => !w.models && w.usedPercent >= 80))
  return { changed: 0, skipped: "claude's plan is over 80% used" };
```

## Testing a workflow

A workflow's test sits beside it and runs it through the real engine, with each agent replaced by
a script of answers, typed by the schema each turn asks for. No agent starts, so a test takes
milliseconds and costs nothing. It checks the workflow's logic, its branches, loops and handling
of each outcome; how well real agents answer is what `awf-lab` measures.

```ts
// summarize.test.ts
import { expect, test } from "bun:test";
import { answer, reply, testWorkflow } from "agentswf/testing";
import summarize, { SUMMARY } from "./summarize";

test("returns the reader's summary", async () => {
  const run = await testWorkflow(summarize, { file: "README.md" }, {
    agents: { reader: answer(SUMMARY, { summary: "Two sentences." }) },
  });
  expect(run.value).toEqual({ summary: "Two sentences." });
  expect(run.turnsOf("reader")[0].prompt).toContain("Read README.md");
});

test("a reader that never answers is nudged once, then the summary says why", async () => {
  const run = await testWorkflow(summarize, { file: "README.md" }, {
    agents: { reader: reply.silent() },
  });
  expect(run.value.summary).toStartWith("no answer:");
  expect(run.turnsOf("reader").map((turn) => turn.nudge)).toEqual([false, true]);
});
```

```sh
awf test                               # every *.test.ts and *.spec.ts under here
awf test summarize.test.ts -t nudged   # one file, the tests whose names match
```

`testWorkflow(workflow, args, options)` calls `run` with `args` as given; `prepare` isn't called.
Its runtime aliases are `claude` and `codex`, and `runtimes` adds or replaces others. `awf test`
needs nothing installed in the folder, and takes paths, `-t`, `--watch` and `--timeout` (5 s a
test by default).

### Scripts

`agents` maps an agent's key, or a pattern such as `"verifier:*"`, to its script. An exact key
wins over a pattern.

- **`answer(SCHEMA, value)`** answers a turn that asks for `SCHEMA`, typed by it.
- **`answer(SCHEMA, (turn) => …)`** answers from the turn: `turn.n`, `turn.prompt`, `turn.agent`,
  `turn.cwd`, `turn.nudge`. It may be `async`, and may return a reply.
- **`answer("text")`** answers a turn that asks for text.
- **`reply.silent()`, `blocked()`, `failed()`, `timedOut()`, `hang()`** end a turn without an
  answer; `hang` holds it until the engine cancels it. **`reply.needsLogin(provider?)`** fails it
  as a missing login does. **`reply.waiting(reason)`** declares a wait, where a claude pane could.
- A silent turn is checked in on as in a real run, by the same script entry with `turn.nudge`
  true.

A script is one entry, which meets every turn of that agent, or a list, one entry per turn. A list
is strict: a turn past its end, or an entry never reached, fails the test. So a test can spread a
shared happy path and override, with lists, the agents its case is about:

```ts
// examples/feature-delivery/workflow.test.ts
const run = await testWorkflow(featureDelivery, args, {
  agents: {
    ...happyPath,
    planner: [
      answer(WORK, planned),
      answer(WORK, { docPath: doc, summary: "plan v2", decisions: ["name the cache"] }),
    ],
    reviewer: [asking("name the cache", "doc ok"), ready("code ok")],
  },
  messages: { planner: (message) => message.reply("Named it in the doc.") },
});
```

### Messages

A script messages as its agent would, and `turn.send` resolves with the reply:

```ts
// examples/feature-delivery/workflow.test.ts
const asking = (change: string, summary: string) =>
  answer(VERDICT, async (turn) => {
    const author = turn.label === "Review ticket doc" ? "planner" : "implementer";
    const revised = await turn.send(author, change, { awaitReply: true });
    return revised.kind === "replied"
      ? { kind: "ready", summary: `${summary}: ${revised.text}` }
      : { kind: "inconclusive", reason: `no revision: ${revised.kind}` };
  });
```

- **`turn.send(peer, text, { awaitReply? })`** resolves to `sent`, `replied` with `text`, `failed`
  with a `reason`, or `refused` with a `code`: values to test, not throws. **`turn.reply(peer, text)`**
  answers a question among `turn.messages`.
- **`turn.tool(name, input?)`**, and `message.tool` in a message turn, calls the agent's tool through
  the run's own checks and handler, as `wf tool` with JSON would, and resolves to `result` with its
  `output`, `failed` with its `outcome` and `error`, or `refused` with a `code` and the `error`
  the agent is told.
- **`messages`** maps an agent's key, or a pattern, to the script for each message it is woken by:
  `(message) => …`, with `message.from`, `text`, `asks`, and `reply`, `send`, `tool`, `silent` and `fail`.
- **`run.messagesOf(key)`** is the messages an agent got and how each ended; a turn's `cause` says
  which message started it.
- **`awaitReply: "anywhere"`** lets a test use `--await-reply` on a harness the engine doesn't
  support yet.

### A coordinator

`coordinators` maps a coordinator's key to a function called with what a holder would act on: each
route to the coordinator as it opens, and each message an agent sends it. It answers as a holder
would, or leaves a question open by returning:

```ts
const run = await testWorkflow(investigate, args, {
  agents: { investigator: [answer("…")] },
  coordinators: {
    coordinator: (event) =>
      event.kind === "message" && event.asks ? event.reply("Keep two, and link them.") : undefined,
  },
});
```

- **A `message` event** has `id`, `from`, `text` and `asks`; **`reply(text)`** answers it, as
  `awf reply --to` would, and **`send(agent, text)`** messages an agent, as `awf send` would.
- **A `route` event** has `agent`, `direction` and `purpose`; **`send(text)`** messages that agent
  first. Each resolves to `{ code: "delivered", id }` or a refusal's `code`.
- **When no turn runs, no script is still working, and everything left waits on a coordinator with
  no `until`,** the attempt ends and its open questions expire `attempt-ended`, so the test ends
  rather than hangs; `run.value` throws if the workflow hadn't returned. While a question has an
  `until`, from a short `timeoutMs`, the test waits for it, so it can expire `timeout`. A script that throws fails the test,
  and so does a route or message reaching a coordinator with no script.
- **`run.messagesOf("coordinator")`** is what it was sent and how each ended; a message to it is
  `delivered` once recorded.

### Decisions

`decisions` maps a decision's key, or a pattern, to one answer per question: a choice's option or
its probabilities, a score's level index or its probabilities, a yes-no's `true`, `false` or probability. A
returned `Error` fails the call.

```ts
// examples/triage/workflow.test.ts
decisions: {
  "triage:1": {
    team: { payments: 0.95, accounts: 0.03, frontend: 0.02 },
    bug: 0.97,
    urgency: [0.1, 0.3, 0.6],
  },
  "triage:2": { team: "frontend", bug: 0.05, urgency: [0.92, 0.08, 0] },
  "triage:3": {
    team: { payments: 0.4, accounts: 0.5, frontend: 0.1 },
    bug: 0.6,
    urgency: [0.05, 0.9, 0.05],
  },
},
```

### Allowance

`allowance` lists what `workflow.allowance` reads, a `HarnessAllowance` per harness; a harness with
none here reads `none`.

### What the run did

- **`run.value`** is what the workflow returned. If it threw, reading `value` throws:
  `expect(() => run.value).toThrow("lens ids must be unique")`.
- **`run.turnsOf(key)`** is one agent's turns in order, nudges included: `prompt`, `schema`,
  `label`, `n`, `nudge`, `model`, `effort`, `outcome` and `stage`. **`run.turns`** has everyone's.
- **`run.compactionsOf(key)`** and **`run.setsOf(key)`** are its compactions and switches. A
  compaction answers `""` unless `compactions` scripts it.
- **`run.agentOf(key)`** is what an agent was opened with, its `sandbox` and pane `layout`
  included, and `forkedFrom` for a fork. **`run.agents`** lists them all.
- **`run.decisions`**, **`run.logs`** and **`run.stages`** are the decisions, log lines and stage
  records; **`run.stopped`** is `{ reason, stage?, needs? }` when the attempt stopped.

Sandboxes in a test are fakes that confine nothing, so a test checks what each agent was given,
and the sandbox evals (`bun run eval`) check what a real provider enforces.

Under `parallel`, read agents by key, not by index. To prove two agents work at once, make one's
answer wait for the other's: run one after the other, the test stalls and fails.

### A workflow with events

```ts
const run = await testWorkflow(caseRun, {
  id: "kombo-unique",                                               // the run, as a sender names it
  event: { name: "dd.changes", data: { case: "kombo-unique" } },   // starts it; absent, it starts with none
  files: { cases: { "kombo-unique": { "case.md": "# kombo\n" } } },  // laid out under cwd first
  agents: { investigator: answer("case.md updated") },
  events: [{ during: "investigator#1", name: "participant:reply", from: "thread", data: { text: "is it the index?" } }],
});
run.parked;                                   // { label, until } of the wait it parked at
run.turnsOf("investigator")[1]?.prompt;       // what the second turn was asked
run.emits;                                    // events it sent other workflows, which a test doesn't start
run.mailbox;                                  // its mailbox as it left it
```

- **`id`** names the run, as `awf run --id` or a sender does. **`event`** starts it, as `awf emit`
  would, its data checked against its schema; without one, it starts with no event.
- **`events`** are sent each while an agent's `n`th turn runs (`"{agent}#{n}"`), before its script
  answers, in the order given; a reply's author, time and id are filled. `n` is the turn's
  `TurnRecord.n`, counting the turns the workflow started: a nudge or a wake for a message keeps
  the turn's number, so with one, `#2` is not `turnsOf(agent)[1]`. One whose turn never runs
  fails the test.
- **`files`** are laid out under the run's directory, which the test removes; a path outside it is
  refused, so a workflow under test finds its files from `workflow.cwd`.
- **`maxTurns`**, 20 by default, counts the turns the workflow started, not nudges or wakes for
  messages: a run that starts more fails the test, so a loop that never parks doesn't hang it.
- **`mailbox`** lays out what an earlier attempt left, and the test is its continue.
- The test returns when the run parks or returns; `run.value` throws for a parked run.

### Continuing over recorded stages

`recorded` runs the workflow as a continue over stages an earlier attempt recorded, keyed by
name. `fromStage` and `values` start at a stage, as `--from-stage` and `--values` do. This is how
a test catches code that only works on a first attempt:

```ts
const run = await testWorkflow(flow, args, {
  recorded: { "doc-review": { path: "docs/a.md" }, implement: { branch: "feat/a" } },
  agents: { worker: answer(QA, { preview: "ok" }) },
});
expect(run.compactions).toEqual([]); // a compaction inside implement isn't repeated
```

### What fails the test, not the workflow

- an agent, decision, message or coordinator with no script;
- a turn past a list's end, or a list entry never reached;
- an answer the turn's schema refuses, or a result while the agent owes a reply;
- a script that throws;
- a stall: nothing starting or ending for 2 s (`stallMs`), a wait for a coordinator question's
  `until` aside, so a stuck test fails rather than hangs.

Deadlines are real time: `reply.timedOut()` ends a turn as timed out at once, and `timeoutMs` sets
the run's deadline, none by default.

## Not built yet

These are in the types and throw `unavailable` today: `agents.attach` (beyond the calling
session), `steps` (durable steps and sleep), and `call` (one workflow calling another). Events
(story 034) are being built: `receive`, `emit`, `agent.start` and parking throw `unavailable` until
it lands. [`docs/status.md`](status.md) says what's next.

