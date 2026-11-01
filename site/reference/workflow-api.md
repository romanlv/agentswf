---
title: Workflow API
description: "Every call a workflow can make today, its options and defaults, on one page."
---

# The workflow API

A workflow is a TypeScript file whose `run` is an ordinary async function. You open agents, give
them work, and get typed answers back. Loops, branches and `Promise`s are plain TypeScript. The
engine owns the rest: agent processes, sessions, deadlines, sandboxes, cleanup and the run's
record.

This page covers every call you can make today. [README](https://github.com/romanlv/agentswf/blob/main/README.md) shows what they add up
to, [`examples/`](https://github.com/romanlv/agentswf/tree/main/examples) has complete workflows, and
[`packages/contract/src/workflow`](https://github.com/romanlv/agentswf/tree/main/packages/contract/src/workflow) has the types, with every
field documented. [Testing a workflow](./testing-api) covers its tests.

## At a glance

```ts
wf.agents.open({ key, runtime, instructions?, skills?, sandbox?, cwd?, layout?, keepPane?, tools? })  // → agent
agent.run({ prompt, schema?, timeoutMs?, label?, nudge? })  // → { outcome }; the same agent keeps its session
agent.compact({ prompt })                                    // → outcome; the harness's own compaction, with a focus
agent.set({ model?, effort? })                               // → outcome; later turns run at these, in the same session
agent.fork({ key, placement?, effort?, instructions?, layout?, keepPane?, tools? })  // → a new agent on a copy of this one's session
wf.agents.stop(key, reason?)                                // → boolean; true once done, false if absent or already stopped
wf.agents.caller({ key })                                    // → the session `awf run --here` was typed in, or null
wf.agents.forkCaller({ key, placement?, effort?, instructions?, layout?, keepPane? })  // → a new agent on a copy of the session awf run was started from, or null
isAnswered(outcome)                                          // narrows to { kind: "answered", value }
tool({ description, input?, handler, timeoutMs? })           // → a tool the agent calls mid-turn with `wfa tool`

wf.parallel(items, (item, i) => …, { concurrency?, label?, deadline? })  // → results in item order
wf.sandboxes.open({ key, write?, read?, network?, sockets?, webSearch?, srt? | docker? }) // → pass as { sandbox }
wf.decisions.decide({ key, model: "jev", state, questions })                    // → { answers } in ~200 ms
wf.messages.allow({ from, to, purpose, maxMessages?, timeoutMs? } | { between: [a, b], purpose, … })  // agents may message
wf.participants.connect({ key, labels? })                     // → a participant outside the run, a route end; .release(reason?)

wf.stage(name, { result, summary? }?, async () => …)  // → its value; reused on a continue
wf.stop(reason)                                               // ends the attempt stopped
wf.sleep(name, "14d" | date)                                  // → once the time recorded under name has come
wf.now()                                                      // the run's time: a test's virtual clock in a test

// A workflow with events adds { file: import.meta.path, events, starts? }; a sender names the run
wf.receive({ label?, take? })                                 // → the events not yet acknowledged
wf.race(name, { branch: source | "2d", … }, { label? })  // → { key, [key]: what won }, recorded under name
for await (const next of wf.select({ branch: source, … }))  // each event a branch takes, one at a time
wf.timer(name, "2d" | date)   timer.cancel()                  // a source: due once, fires as timer:due
wf.signal("dd.closed")   wf.timers()                         // sources: a declared event, any timer
wf.at(() => ledger.nextNudge())                               // a select's branch: due at a time the state holds
wf.after("3h")                                                // a Date: now() plus it, for the run's state to keep
wf.started                                                    // the event that started the run
agent.start({ prompt, schema?, meta? })   agent.turn          // a turn not awaited; its end is agent:ended
agent.is<Meta, T>(e)   participant.is(e)   timer.is(e)        // narrow an event; each is a source too
wf.agents.open({ …, keepAlive: { timeoutMs?, onTimeout? } })  // the run stays live after its turns
wf.participants.connect({ key, to: "code" })                  // replies come as participant:reply; .post(text)
wf.emit(target, run, name, data, { eventId? })                // → "accepted" | "duplicate" | "refused"

wf.log(message, fields?)   wf.usage()   wf.deadline   wf.cwd
wf.runId   wf.attempt
wf.allowance(harness)                                         // → what is left of its plan, as `awf allowance` reads it

// In a test, from "agentswf/testing"; `awf test` runs it:
testWorkflow(workflow, args, { agents?, messages?, participants?, compactions?, awaitReply?, decisions?, allowance?, runtimes?,
                              caller?, timeoutMs?, stallMs?, cwd? | files?, recorded?, fromStage?, values? })  // → run
testWorkflow(eventWorkflow, { id, args?, event?, events?: [{ during | after: "agent#1", name, data, from? }], maxTurns?, maxTimers?, … })  // → run, .emits, .parked, .timers
answer(SCHEMA, value | (turn) => value)   answer("text")   reply.waiting(reason, timeoutMs?) | silent() | blocked() | failed() | needsLogin(provider?) | timedOut() | hang() | interrupted()
```

| Concept | In one line |
| --- | --- |
| **Workflow** | A file that exports `defineWorkflow(…)`, which `awf run file.ts` runs, and, with `events`, the events it declares start too. |
| **Agent** | A coding agent (claude, codex, pi, cursor) behind a key. It keeps its session between turns. |
| **Turn** | One `agent.run`: a prompt in, one outcome out. The answer is JSON checked against your schema. |
| **Outcome** | Always a value, never an exception: `answered`, `unanswered`, `blocked`, `timed-out`, `failed` or `cancelled`. |
| **Deadline** | Set where you want one. A child's deadline can be earlier than its parent's, never later. |
| **Sandbox** | What agents inside it can read, write and reach. They share it or get a private one. |
| **Decision** | Closed questions to a decision model (Jev). It returns probabilities, and no agent is involved. |
| **Route** | Lets one agent message another while both work, for a purpose the workflow states. |
| **Participant** | Someone outside the run that agents report to and ask, such as a coordinator; a terminal, a session or an app answers for it. |
| **Run** | One piece of work, with an id. Each `awf run` of it is an attempt; `--continue` adds one. |
| **Stage** | A named step of a run. A continue reuses what stages succeeded and runs the rest. |
| **Event** | Starts the run its sender names, or lands in its mailbox; the run takes it at a wait, and parks between events. |

## A workflow file

```ts
// summarize.ts
import { defineWorkflow, isAnswered } from "agentswf/workflow";
import Type from "typebox";

export const SUMMARY = Type.Object({ summary: Type.String() }, { additionalProperties: false });

export default defineWorkflow({
  meta: { name: "summarize", description: "Summarize one file." },
  async run(wf, args: { file: string }) {
    const agent = await wf.agents.open({ key: "reader", runtime: "claude" });
    const { outcome } = await agent.run<Type.Static<typeof SUMMARY>>({
      prompt: `Read ${args.file} and summarize it in two sentences.`,
      schema: SUMMARY,
    });
    return isAnswered(outcome) ? outcome.value : { summary: `no answer: ${outcome.reason}` };
  },
  // Turns the command line into args: `awf run summarize.ts -- src/index.ts`.
  prepare: ({ argv }) => ({ file: argv[0] ?? "README.md" }),
  // Optional: what a person sees at the terminal instead of the JSON.
  present: (result) => result.summary,
  // Optional: Markdown saved beside the run as report.md.
  report: (result) => (result ? `# Summary\n\n${result.summary}\n` : undefined),
});
```

- **`meta`** and **`run(wf, args)`** are the workflow; args and result must be JSON.
  `meta.name` names the folder its runs are kept in (letters, digits, `.`, `_`, `@` and `-`). An optional
  `meta.version` is semver; [Stages](#stages) says what it guards.
- **`prepare`** turns the command line (`argv` after `--`, and `cwd`) into args. Left out, the
  workflow takes no arguments: its args are `null`, and any argv is refused. A run an event starts
  has no argv, so its args are what `prepare` makes of none.
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
const reviewer = await wf.agents.open({
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
| `sandbox` | A sandbox from `wf.sandboxes.open`, or an inline spec for a private one. Left out, the agent is unsandboxed. |
| `cwd` | Where the agent works; `wf.cwd` by default, which `awf run --cwd` sets. |
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

- **With a `schema`**, the agent answers by running `wfa result`, as its prompt tells it: with flags,
  `--verdict 'approve'`, for an object of up to 6 strings, numbers, booleans or enums, else with
  JSON. The engine checks it, and a refused answer can be retried within the same turn.
- **Without a schema**, the answer is a string.
- **The type argument** (`run<Type.Static<typeof X>>`) gives the answer its TypeScript type; a
  TypeBox schema doesn't carry one on its own.
- **`timeoutMs`** bounds the whole turn, recovery included, within the enclosing
  [deadline](#deadlines).
- **`nudge`** is the recovery for an agent that goes quiet: the engine checks in and asks for its
  answer. `nudge: false` turns it off; `nudge: { prompt }` adds to what the check-in says. An
  agent with long work in progress can say so with `wfa waiting`, where its placement supports it
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
if (outcome.kind === "failed" && outcome.login) wf.stop(outcome.reason);
// "pi needs a login for openai-codex: run `pi`, then /login (pi said: OAuth refresh failed …)"
```

**A turn that fails or times out closes its agent**, and the agent takes no more turns. The
calling session is the exception.

`wf.agents.stop(key, reason?)` closes an agent the workflow is done with, such as a lens
that has answered, so it doesn't sit idle until the run ends. A turn it is running ends
`cancelled`, and its key can't be opened again. It resolves `true` once the agent is closed, and
`false` for a key never opened or already stopped. Stopping the calling session hands it back to
its operator then rather than at the end of the run.

### Sessions: talk to the same agent again

Every `run` on the same agent continues its session, so it remembers what it did. That is how you
build loops: ask for work, check it, ask for a fix, with a different typed answer each time.

```ts
const builder = await wf.agents.open({ key: "build", runtime: "claude" });
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
if (!isAnswered(compacted)) wf.log("compaction didn't finish", { reason: compacted.reason });
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
const reviewer = await wf.agents.open({ key: "reviewer", runtime: { alias: "codex", effort: "high" } });
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
([ADR 0009](https://github.com/romanlv/agentswf/blob/main/docs/adr/0009-a-fork-is-a-new-agent-on-a-copy-of-the-session.md)).

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
([design](https://github.com/romanlv/agentswf/blob/main/docs/design/pane-layout.md)):

```ts
const lead = await wf.agents.open({
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
([ADR 0010](https://github.com/romanlv/agentswf/blob/main/docs/adr/0010-the-calling-session-is-an-agent.md)):

```ts
const author = await wf.agents.caller({ key: "author" });
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
  (await wf.agents.forkCaller({ key: "fixer", layout: { workspace: "origin" } })) ??
  (await wf.agents.open({ key: "fixer", runtime: "claude" }));
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

const reviews = await wf.parallel(
  LENSES,
  async (lens) => {
    const agent = await wf.agents.open({ key: `review:${lens}`, runtime: "codex" });
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
attempt. A stage is a named step whose result the run keeps, so `awf run file.ts --id {id} --continue`
reuses what succeeded and picks up at the stage that didn't.

```ts
const doc = await wf.stage("doc-review", { result: DOC, summary: (d) => d.path }, async () => {
  const doc = await ask(worker, DOC, `Review the ticket doc for ${ticket}`);
  if (doc.kind === "no-doc") wf.stop(doc.reason); // inside: a continue redoes doc-review
  return doc;
});
await wf.stage("notify", async () => {                // no result: it only has to happen
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
- **`wf.stop(reason)`** ends the attempt `stopped` (exit 3) rather than failed; inside a
  stage, a continue redoes that stage. Don't catch it. Write `return wf.stop(reason)` where
  TypeScript should know the code after it isn't reached.
- **`meta.version`** guards reuse: a record from another major version (another minor under
  `0.x`), or one whose value no longer fits its schema, stops the continue at that stage, and
  `--from-stage {stage}` redoes from there.

`wf.runId` is the run's id and `wf.attempt` the attempt's number. The full model is in
[`design/runs-and-stages.md`](https://github.com/romanlv/agentswf/blob/main/docs/design/runs-and-stages.md).

## Deadlines

A run has no deadline unless `awf run --timeout 2h` gives it one, as `wf.deadline`, absent
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
const box = await wf.sandboxes.open({
  key: "work",
  write: ["."],                   // the working directory is writable; everything else is read-only
  network: ["registry.npmjs.org"], // beyond each harness's own model API
  srt: {},                         // or docker: { image? }; omit both for the operator's default
});

const coder = await wf.agents.open({ key: "code", runtime: "claude", sandbox: box });
const tester = await wf.agents.open({ key: "test", runtime: "codex", sandbox: box });
const reader = await wf.agents.open({
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

const { answers } = await wf.decisions.decide({
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
  [findings](https://github.com/romanlv/agentswf/blob/main/docs/findings/system-one-models.md) show Jev is reliable at matching text to options, and
  not at anything that needs reading code.
- **A decision that didn't answer rejects** with `DecisionError` (or `DeadlineExceededError`).

## Tools: the agent calls your code

A tool is a function in your workflow an agent calls while it works, and reads what it returns.
Holding a tool is what lets the agent call it.

```ts
import { tool } from "agentswf/workflow";

const triager = await wf.agents.open({
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
  `wfa tool close_item --id <text> --status done|wontfix --why <text>`, which the agent fills in
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
await wf.messages.allow({
  between: [reviewer, implementer],
  purpose: "Revise the implementation until the reviewer approves it.",
  maxMessages: 6,
});
const verdict = await reviewer.run({ prompt: "Review the change; ask the implementer for fixes.", schema: VERDICT });
```

- **A route** is `{ from, to }`, one way, or `{ between: [a, b] }`, both ways. Its `purpose` comes
  with every message. Granted inside a stage, it closes with the stage. `maxMessages` lowers the
  ceiling of 40 a route, replies included.
- **Agents use `wfa`**, which their prompt teaches them: `wfa peers`, `wfa send {peer}`,
  `wfa send --await-reply {peer}` to ask and wait, and `wfa reply {peer}`.
- **A message arrives between turns**, never into a running one. An idle agent gets a turn of its
  own for it, at its own cost; a busy one gets it with its next turn. An agent that is asked a
  question can't give its result until it replies.
- **`--await-reply`** works on headless claude, codex and pi, and on a claude pane that confirms
  what it is sent. Elsewhere the agent is told to send without waiting.
- **Costs and logs:** `wf.usage()` marks each operation a message started, and `awf run`,
  `awf logs` and `awf runs` show the messages.

### A coordinator outside the run

A workflow can let agents report to, and ask, something outside the run: a coordinator. Who answers
for it is chosen when the run starts, not here: `awf run`'s terminal, another claude or codex
session, or an app such as a Slack bridge.

```ts
const coordinator = await wf.participants.connect({
  key: "coordinator",
  labels: { audience: "operator" },
});
await wf.messages.allow({
  between: [investigator, coordinator],
  purpose: "report findings that hold up; ask when the logs can't settle it",
  timeoutMs: 2 * 60 * 60_000,
});
```

- **Agents talk to it as to any peer:** `wfa send coordinator` reports, and
  `wfa send --await-reply coordinator` asks; the answer starts the agent's next turn, in the same
  session, hours later if need be.
- **`labels`** is any JSON object for whatever answers; awf only passes it along. `operator`, `awf`,
  `system` and `user` are refused as keys.
- **`timeoutMs`**, only on a route to a participant, closes a question unanswered after that long;
  without it, a question waits until it is answered. An agent's `--timeout` can only shorten it.
- **It stays connected** past the workflow's return while a question to it is open, so the run
  waits for the answer. `coordinator.release(reason)` ends it sooner.
- **Run in a terminal**, `awf run` asks each question there. Otherwise the answer comes from
  `awf reply`, by a session or an app reading `awf inbox` ([Answering for a participant](../guide/people)).

claude's own messaging between sessions is a different thing, on by default:
[`design/messaging.md`](https://github.com/romanlv/agentswf/blob/main/docs/design/messaging.md#claudes-own-messaging) says what it reaches.

## Events

A workflow that reacts to things that happen declares the events it takes, beside the rest of its
definition, and each sender names the run an event is for. An event starts that run, or lands in its mailbox; the run takes waiting
events at a wait, handles them in plain code, and starts an agent turn only when one is needed.
Between events the run parks: its process exits, and the next event runs its code from the top.

```ts
export default defineWorkflow({
  meta: { name: "dd-case", description: "Investigate one Datadog case." },
  file: import.meta.path,                                   // where senders find it, and its runs live
  events: { "dd.changes": Changes, "dd.closed": Closed },   // a schema per name; no colon
  starts: ["dd.changes"],                                   // the events that may start one; absent, any
  async run(wf) {
    const kase = openCase(wf.runId);                       // state lives in files, not variables
    const investigator = await wf.agents.open({ key: "investigator", runtime: "claude" });
    for (;;) {
      const events = await wf.receive({ label: `${kase.unseen()} unseen` });
      for (const e of events) {
        if (investigator.is<Given>(e) && isAnswered(e.data.outcome)) kase.markGiven(e.data.meta);
        if (e.name === "dd.closed") await wf.stage(`close-${e.id}`, () => kase.close(e.data));
      }
      if (!investigator.turn && kase.needsLook()) {
        const given = kase.pending();
        await investigator.start({ prompt: promptFor(given), meta: given });   // returns at once
      }
    }
  },
});
```

```sh
awf emit --target case.ts --id kombo-unique dd.changes '{"case":"kombo-unique"}' --event-id 83d34d7
```

- **Sending.** `wf.emit(caseRun, run, name, data, { eventId })` imports its target, so a wrong name or
  shape fails `tsc`; `awf emit --target {file}` checks the same at run time. Either returns
  `accepted`, `duplicate` (the id is in the run's mailbox already) or `refused` (the run returned,
  or it has none and `starts` doesn't list the event). An id names one occurrence for good; without
  one, nothing deduplicates the event.
- **The run's id.** The sender names the run an event is for, as `awf send` names the run it
  writes to: `awf emit --id`, `wf.emit`'s second argument. The ref is `{workflow}/{id}`, as
  for a run without events, and `wf.runId` is the id. Run ids are letters, digits, `.`, `_`, `@` and `-`, starting
  with a letter or digit; event ids and stage names are the same, lowercase, so a stage named by
  an event id (`close-{id}`) is always valid.
- **Starting by hand.** `awf run {file} --id {id} -- {args}` makes the run with those args and
  starts it, detached in its project, as an event would; it runs to its first wait, which returns
  nothing, and parks. `id(args)` may name it instead of `--id`. It ignores `starts`, and a run
  already there is only woken. A run an event starts gets what `prepare` makes of no argv: a
  sender is refused when `prepare` refuses that. Work to do once, on the first attempt, goes in a
  stage at the top of `run`.
- **Without `events`** a workflow has no `receive`, and its runs never park: nothing could wake
  them. It can `sleep`, which waits in its process.
- **`receive`** acknowledges what its last call returned, then returns every event not yet
  acknowledged, in arrival order, or the oldest alone with `take: "oldest"`. The first call takes
  the event that started the run, if one did. After a crash, the first call returns the unacknowledged batch
  again, alone. `label` is what `awf runs` shows. A time to act is a timer, which comes as an
  event: see [Waiting on time](#waiting-on-time).
- **Turns not awaited.** `agent.start()` takes what `run()` takes, plus `meta`, and returns once
  the turn is launched. Its end arrives at a wait as `agent:ended`, from the agent's key, with the
  outcome and `meta`; `agent.is(e)` narrows it. `agent.turn` is set until a wait takes that end,
  and the agent refuses other work meanwhile. `agent.turn.cancel()` stops it; a tool call it has
  running is aborted through `call.signal`, and the end and `cancel()` wait for the handler, at
  most 5 s more.
- **Parking.** Waiting with nothing else of the run working (no turn, decision, sandbox or other
  stage) and nothing the wait takes, the run ends its attempt
  `parked` and its process exits. Plain code running beside the wait, outside any awf call, is
  cut off and runs again on the continue: work that must finish goes in a stage or before the
  wait. The next event the wait takes, or `awf tick` once its timer is due, continues it:
  agents reopen on their kept sessions, recorded stages are reused, and the loop's wait takes the
  new event. What must outlive that lives in files or a stage. `awf tick` wakes the runs of the
  project it runs in, the ones `awf runs` lists there; `awf tick --all`, every project's.
- **Kept alive.** An agent opened with `keepAlive` keeps the run live, not parked, for a window
  after each turn it runs, awaited, started or a message's: `timeoutMs`, an hour by default, the
  life of claude's prompt cache on a subscription. Its pane and the run's process stay, so a
  message then is a warm turn in the same pane, and its end opens a new window. Once the window
  passes, a wait with nothing to take and nothing working calls `onTimeout(agent)`, if a turn ended
  since it last ran, and awaits it in the wait's scope; the run parks once no window is open and no
  handler is due. A turn the handler runs opens no window, though a message it sends a peer is that peer's turn,
  and so is an answer the peer sends back after the handler's turn has ended, which opens this
  agent's window again: a wrap-up that asks a peer each time keeps the run live; a started one ends at the loop as any
  does, told apart by its `meta`. A throw is logged, and the run parks anyway. A turn that fails or
  times out closes the agent, and a closed agent holds no window. Every agent's pane stays with the
  run: none is released alone. Elsewhere `keepAlive` fails `tsc`, and open refuses it.

  ```ts
  const investigator = await wf.agents.open({
    key: "investigator",
    runtime: "claude",
    keepAlive: {
      onTimeout: async (agent) => {
        // Written when the window passes, from the case as it is then, while the cache is warm.
        await agent.compact({ prompt: focusFor(kase.view()) });
      },
    },
  });
  ```

  The run's terminal shows "live until {time}" on the row of each idle agent whose window is
  open; `awf runs` shows the run live and waiting.
- **Agents on a wake.** Each agent reopens on its kept session, without its instructions again, and
  a pane agent's pane opens at its first turn. So before that turn, in an attempt, it can't be
  forked or compacted, and an agent `beside` it gets a tab of its own. An agent with skills or a
  sandbox, whose home is made anew, starts a new session, as one whose harness changed does.
- **Stages by content.** In a run with `events`, a succeeded stage is reused wherever and however
  often its name is entered, in any attempt and any version of the code, while its value fits.
  Name it by its one effect: `close-{event id}`, `post-f3@abc123`.
- **A participant routed to the code**, `connect({ key, to: "code" })`, turns each message into
  `participant:reply` from its key; `awf send {ref} --as {key} --event-id {message id} {text}` delivers
  one, and `participant.post(text)` writes back without a turn.
- **`return`** ends the run for good: later events for it are refused. A run that may be
  needed again records what happened in its files and keeps waiting instead.

### Waiting on time

A timer is a time recorded once under a name; due, it fires into the mailbox as `timer:due`, from
its name, at its due time. A **source** is something a wait can take: a timer, a declared event
(`wf.signal(name)`), a participant routed to the code, an agent (any of its turns' ends) or
a started turn (its end). Three waits take sources, beside `receive`:

```ts
// A reminder every two days, an approval, or an expiry at fourteen.
const expiry = wf.timer("doc-expires", "14d");
for (let round = 1; ; round++) {
  const next = await wf.race(`approval-${round}`, {
    reply: approvals,                 // a participant routed to the code
    remind: "2d",                     // a timer of the race's own
    expiry,                           // a timer the code made, shared by every round
  }, { label: "awaiting approval" });
  if (next.expiry) return abandon();
  if (next.reply && isApproval(next.reply.text)) return approve(next.reply);
  if (next.remind) await wf.stage(`remind-${round}`, () => approvals.post(REMINDER));
}

// Straight-line code that waits, and goes on.
await wf.stage("release", () => release(ticket));
await wf.sleep("follow-up", "14d");

// A loop that handles the events it names, one at a time.
for await (const next of wf.select({ reply: thread, closed: wf.signal("dd.closed") })) {
  if (next.closed) return close(next.closed.data);
  if (next.reply) await answer(next.reply);
}
```

- **`wf.timer(name, when)`** returns its source at once. `when` is `"{n}d"`, `"{n}h"` or
  `"{n}m"` from the first call under the name, or a `Date`. The first call names the time: a later
  one, in this attempt or any other, gets the recorded timer, and one asking another time is
  logged and ignored. So a timer per round is named per round, and a fixed time is a duration or
  a `Date` from the run's files: one built from `now()` differs on every rerun. `timer.cancel()` stops it, and a `timer:due` of it not yet taken is withdrawn; a name
  stays cancelled. A name has no `@`. In a `receive` loop, `timer.is(e)` tells its event, or
  `e.name === "timer:due"` with `e.from`, its name, for one an earlier attempt made.
- **`race(name, branches)`** waits for the first of its branches and answers `{ key, [key]: … }`:
  `if (next.reply)` and `switch (next.key)` both narrow. It takes only what it names: the rest
  stays in the mailbox for a later wait, and doesn't wake a run parked at the race. Its answer is
  recorded under `name`, so a rerun gets it back and walks on: a race in a loop is named per round,
  and a name answers once an attempt. Of two ready, the earlier `at` wins; of two branches taking
  one event, the first declared. A branch given a duration is a timer of the race's own,
  `{name}@{branch}`, cancelled when another branch wins; a `wf.timer()` passed in is the
  code's to cancel. A branch takes a duration, not a `Date`: a fixed time is
  `wf.timer(name, date)`. `race`, `sleep` and `select` throw in a stage or a tool's
  handler, and races and sleeps share their names.
- **What a branch hands back**: a reply as its `text` and `author`, a turn's end as its `outcome`
  and `meta`, a timer's as its `name`, each with the event's `id` and `at`; a signal, the event.
- **`sleep(name, when)`** is a race of one timer of its own, `{name}@sleep`: past its time, it
  returns at once. A sleep in a loop is named per round, as a race is.
- **`select(branches)`** yields each event its branches take, one at a time, under its branch's
  name, until the loop returns or breaks. An event is acknowledged when the loop asks for the next;
  after a crash, the one taken and not acknowledged comes back once. `wf.timers()` takes any
  of the run's timers, so one made in the loop, `retry-{id}`, is caught by `next.timer.name`. Its
  `label` may be a function, asked at each wait. A branch is a source, not a duration: a timer in
  a loop is `wf.timer()`'s.
- **`wf.at(read)`** is a select's branch due at a time the run's state holds: `read` returns
  a `Date`, or `null` for none, and is called at each wait, so the branch follows the state as the
  code moves the time. It answers `{ at }`, the time it came for.

  ```ts
  for await (const next of wf.select({
    reply: engineer,
    nudge: wf.at(() => ledger.nextNudge()),         // Date | null, from the ledger's file
  })) {
    if (next.nudge) await nudge();                  // which puts ledger's nextNudge off, or clears it
    if (next.reply) ledger.answered();              // nextNudge = null: no more nudges
  }
  ```

  It isn't a timer: nothing is recorded under a name, there is nothing to cancel, and it lives as
  long as its loop. Events ready at the wait, timers' among them, come before it, as the handler may
  move the time. A time returned once isn't returned again by a branch of that name, so a handler
  that leaves the state alone doesn't fire on every pass. After a crash, a time returned and not
  acknowledged comes back once, if the state still says it. `read` is cheap and synchronous, and
  reads state that outlives the process (files, or what is rebuilt from them): a parked run wakes in
  a new one and reads it again. A time is kept in the state, not made at the read, which would never
  come due: `wf.now()` and `wf.after()` throw inside it, as does anything but a valid
  `Date` or `null`. A race refuses it; a fixed time there is `wf.timer(name, date)`.
- **`wf.after(duration)`** is `now()` plus `"{n}d"`, `"{n}h"` or `"{n}m"`: a time for the
  state to keep, where it is set.
- **`wf.started`** is the event that started the run, absent for one started by hand.
- **`wf.now()`** is the run's time. Workflow code reads it, not `Date.now()`, so a test's
  clock is the one it reads.
- **Parked**, a run's `until` in `awf runs` is the earliest timer, or time read from state, its
  wait takes, and `awf tick` continues it once that is due.

## Logging and usage

```ts
wf.log("reviewed", { findings: 12 }); // a line in awf's live progress and in `awf logs`
wf.usage();                           // this scope's finished operations: times and sessions
```

Costs are priced after the run, from each agent's tokens: each stage's line gains what its agents
cost, and one summary closes the run. `output.json` keeps the tokens, each stage's share and the
price table used.

## Plan allowance

`wf.allowance(harness)` reads what is left of a harness's plan now, as `awf allowance` does,
with no model turn, on the login the run's agents get. It returns one harness of
`awf allowance --json`'s report: each window's `usedPercent`, its `resetsAt` and, for a window that limits
only some models, which. A `none` says why there was nothing to read, and means unknown, not room to
spare. The read isn't recorded: a continue reads again, and a stage keeps one.

```ts
// examples/event-sketches/dd-tick.ts: a tick that leaves the plan to the operator past 80%;
// a window of some models' only, as claude's `week (Fable)`, doesn't limit its sonnet
const plan = await wf.allowance("claude");
if (plan.read === "plan" && plan.windows.some((w) => !w.models && w.usedPercent >= 80))
  return { changed: 0, skipped: "claude's plan is over 80% used" };
```

## Not built yet

These are in the types and throw `unavailable` today: `agents.attach` (beyond the calling
session), `steps` (durable steps and sleep), and `call` (one workflow calling another).
[`docs/status.md`](https://github.com/romanlv/agentswf/blob/main/docs/status.md) says what's next.

