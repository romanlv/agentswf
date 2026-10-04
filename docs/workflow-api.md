# The workflow API

A workflow is a TypeScript file whose `run` is an ordinary async function. You open agents, give
them work, and get typed answers back. Loops, branches and `Promise`s are plain TypeScript. The
engine owns the rest: agent processes, sessions, deadlines, sandboxes, cleanup and the run's
record.

This page covers every call you can make today. [README](../README.md) shows what they add up
to, and [`examples/`](../examples) has complete workflows.

## At a glance

```ts
workflow.agents.open({ key, runtime, instructions?, skills?, sandbox?, cwd? })  // → agent
agent.run({ prompt, schema?, timeoutMs?, label?, nudge? })  // → { outcome }; the same agent keeps its session
agent.compact({ prompt })                                    // → outcome; the harness's own compaction, with a focus
agent.fork({ key, placement?, instructions? })               // → a new agent on a copy of this one's session
workflow.agents.caller({ key })                              // → the session `awf run --here` was typed in, or null
isAnswered(outcome)                                          // narrows to { kind: "answered", value }

workflow.parallel(items, (item, i) => …, { concurrency?, label?, deadline? })  // → results in item order
workflow.sandboxes.open({ key, write?, read?, network?, srt? | docker? })        // → pass as { sandbox }
workflow.decisions.decide({ key, model: "jev", state, questions })              // → { answers } in ~200 ms

workflow.log(message, fields?)   workflow.usage()   workflow.deadline   workflow.cwd   workflow.runId

// In a test, from "agentswf/testing"; `awf test` runs it:
testWorkflow(workflow, args, { agents?, decisions?, runtimes?, caller?, timeoutMs?, stallMs?, cwd? })  // → run
answer(SCHEMA, value | (turn) => value)   answer("text")   reply.silent() | blocked() | failed() | timedOut() | hang() | interrupted()
```

| Concept | In one line |
| --- | --- |
| **Workflow** | A file that exports `defineExecutableWorkflow(…)`. `awf run file.ts` runs it. |
| **Agent** | A coding agent (claude, codex, pi, cursor) behind a key. It keeps its session between turns. |
| **Turn** | One `agent.run`: a prompt in, one outcome out. The answer is JSON checked against your schema. |
| **Outcome** | Always a value, never an exception: `answered`, `unanswered`, `blocked`, `timed-out`, `failed` or `cancelled`. |
| **Deadline** | Every wait has one. A child's deadline can be earlier than its parent's, never later. |
| **Sandbox** | What agents inside it can read, write and reach. They share it or get a private one. |
| **Decision** | Closed questions to a decision model (Jev). It returns probabilities, and no agent is involved. |

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
  report: (result) => `# Summary\n\n${result.summary}\n`,
});
```

- **`definition`** is the workflow: `meta` and `run(workflow, args)`. Its args and result must
  be JSON. `meta.name` names the folder its runs are kept in, so it is letters, digits, `.`, `_`
  and `-`; the file may move or be copied and stay the same workflow. An optional `meta.version`
  is semver, and is recorded with each attempt.
- **`prepare`** turns the command line (`argv` after `--`, and `cwd`) into args.
- **`present`** and **`report`** are optional. Without `present`, `awf run` prints the full result
  as JSON. `--json` always prints it.

The result, every agent's usage, and why the run ended are kept in `output.json` in the run's
folder, `.awf/runs/{workflow}/{id}` under the working directory. A run that fails or is cancelled
keeps this record too, and `awf run {file} --continue {id}` runs it again as its next attempt.
`workflow.runId` is the run's id, the same in every attempt, and `workflow.attempt` its number.

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
| `key` | The agent's name in this run. Opening the same key again returns the same agent. The part before `:` is its **stage** in the cost summary, so `review:security` and `review:style` both add up under `review`. |
| `runtime` | Which harness and model to use. You can pass an alias (`"claude"` or `"codex"`), or `{ harness, model, placement?, metered? }`, or `{ alias, … }` to constrain an alias. |
| `placement` | `"pane"` (the default) opens a terminal pane in [Herdr](https://herdr.dev) that you can watch and type into. `"headless"` runs a process per turn. |
| `metered: true` | Required for headless claude. `claude -p` is billed per token even on a subscription, so you have to opt in. A claude agent in a pane runs on your plan. |
| `instructions` | Standing instructions, given once when the agent opens. |
| `skills` | Exactly the skills this agent gets: `{ path }` for a directory holding a `SKILL.md`, or `{ repo: "owner/repo", skill, ref? }`. Each agent gets its own copy. |
| `sandbox` | A sandbox from `workflow.sandboxes.open`, or an inline spec for a private one. Leave it out to run unsandboxed. |
| `cwd` | Where the agent works. Defaults to the workflow's working directory, `workflow.cwd`, which `awf run --cwd` sets. |

A harness is the coding-agent CLI (`claude`, `codex`, `pi`, `cursor`). Your existing login for
each one is used. Each runs in a pane or headless.

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

- **With a `schema`**, the answer is JSON that the engine checks against it. The agent answers by
  running `wf result {call-id} '{json}'`, and the engine tells it how in the prompt. An answer that
  fails the check is refused, and the agent can try again within the same turn.
- **Without a schema**, the answer is a string.
- **The type argument** (`run<Type.Static<typeof X>>`) is how the answer gets its TypeScript type.
  A plain TypeBox schema doesn't carry one on its own.
- **`timeoutMs`** bounds this turn. It can't go past the enclosing deadline (see
  [Deadlines](#deadlines)).
- **`nudge`**: if the agent stops without answering, the engine asks once more by default.
  `nudge: false` turns this off, and `nudge: { prompt }` sets what the engine says.

### Outcomes

`run` resolves to `{ outcome }`. It only rejects when the whole scope's deadline has passed. A
turn that goes wrong is still a value:

| `kind` | Meaning |
| --- | --- |
| `answered` | `outcome.value` is the checked answer. |
| `unanswered` | The agent finished its turn without answering, even after the nudge. |
| `blocked` | The agent is showing a question only a person can answer, such as a permission prompt. |
| `timed-out` | The turn's deadline passed. |
| `failed` | The harness failed. `retryable` says whether trying again might help. |
| `cancelled` | The run or an enclosing scope was stopped. |

```ts
if (!isAnswered(outcome)) return { error: `${outcome.kind}: ${outcome.reason}` };
outcome.value.findings; // typed
```

### Sessions: talk to the same agent again

Every `run` on the same agent continues its session, so the agent remembers what it did. This is
how you build loops: ask for work, check it, ask for a fix, and ask for a different typed answer
each time.

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

`compact` runs the harness's own compaction, as an operator types `/compact` with a focus. The
`prompt` is that focus: what to keep and what to drop. It runs after the agent's earlier turns,
and the next `run` goes on in the compacted session.

```ts
const compacted = await builder.compact({
  prompt: "Keep the plan's decisions, the branch and the worktree. Drop file contents.",
});
if (!isAnswered(compacted)) workflow.log("compaction didn't finish", { reason: compacted.reason });
```

- **`answered`** means the harness compacted. `value` is its summary where the harness shows it,
  claude's and pi's, and `""` for codex, which keeps it encrypted.
- **Any other outcome** leaves the context as it was, so going on is usually right. A pane
  compaction past its deadline is left to finish rather than stopped, and the next turn waits for
  it.
- **Per harness**: claude, in a pane or headless, takes `/compact {prompt}`; codex takes the focus
  as a message just before its compaction; pi passes it as its compaction's instructions
  (`/compact {prompt}` in a pane), and only
  summarizes what is older than its last 20k tokens, so a short session fails "nothing to
  compact". cursor takes the focus as a message just before `/summarize`, in a pane only: headless
  it has no compaction, so `failed`, and nothing is sent.
- **Bounds and ids** are `run`'s: it runs within the workflow's deadline unless `timeoutMs` or
  `deadline` bounds it sooner, and an `id`, generated when omitted, makes it idempotent. The same
  spec again under one id returns the same outcome; another spec under it rejects.

### Forking: new agents that start from what one knows

`fork` opens a new agent on a copy of this agent's session, so it starts knowing what this agent
knew, without being told again, and its first request reads that context from the provider's cache
([ADR 0009](adr/0009-a-fork-is-a-new-agent-on-a-copy-of-the-session.md)).

```ts
await worker.run({ prompt: "Read the ticket and plan the change.", schema: PLAN });
const [security, tests] = await Promise.all([
  worker.fork({ key: "security", instructions: "Review the plan for security." }),
  worker.fork({ key: "tests" }),
]);
```

- **The copy is taken when `fork` is called**, after the agent's earlier operations: a `run` queued
  after it is not in it. From then on neither agent sees the other's turns.
- **A fork has its parent's** harness, model, working directory, sandbox and skills. It may name its
  own `placement` (with `metered`), `instructions`, which go with its first turn, and `labels`.
- **It rejects**, as `agents.open` does, before the agent's own first turn, once the agent is
  closed, and where its host cannot fork. Every harness forks, in a pane or headless, into either,
  in a sandbox too, where the fork shares its parent's sandbox.
- **The same key** with the same parent and spec returns the same agent; anything else under it
  rejects.
- **A test** scripts a fork by its own key like any agent, and `agentOf(key).forkedFrom` names the
  agent it copied and how many of its turns came before.

### The calling session

`awf run --here`, typed in a claude, codex, pi or cursor session in a Herdr pane, starts the run in
a tab of its own, and the run can drive that session as an agent
([ADR 0010](adr/0010-the-calling-session-is-an-agent.md)):

```ts
const author = await workflow.agents.caller({ key: "author" });
if (!author) throw new Error("start this workflow with awf run --here from an agent");
const { outcome } = await author.run({ prompt: "Pick a number and remember it.", schema: PICKED });
```

- **`null`** means the run has no calling session: refuse, or open an agent of your own instead.
  The same key again returns the same agent; another key rejects.
- **It is the operator's session**, so it is not opened: no `instructions`, and what it needs goes
  in its prompts. `compact` fails, a turn that fails, is cancelled or times out leaves it usable,
  the operator interrupting a turn settles it `cancelled`, and `execution.model` is `""`.
- **When the run ends**, answered, failed, timed out or stopped, the session gets one message
  saying how and where the run directory is. A run that is killed sends nothing.
- **In a test**, `caller: { harness }` gives the run one, scripted under its key like any agent;
  `reply.interrupted()` is the operator stopping a turn.
  [`examples/calling-session`](../examples/calling-session) has both.

## `parallel`

Runs one async function per item, with at most `concurrency` running at a time. Results come back
in item order. It's `Promise.all` with a limit and a deadline, and the engine tracks it.

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

- **`concurrency`** defaults to all items at once.
- **`label`** names the stage in `awf`'s live progress ("review 2/3").
- **`deadline`** can only make it earlier than the enclosing one.
- **It's fail-fast.** If one item throws, the others are cancelled (their agents' turns end as
  `cancelled`) and `parallel` rejects with that error. Outcomes other than `answered` don't throw,
  so in the usual pattern above one bad agent never stops the rest.
- **Nesting works.** A `parallel` inside another is cancelled with it. Two stages in a row are just
  two `await`s, and a fan-out that verifies each finding is a `parallel` inside a `parallel`.

## Deadlines

Every run has one deadline, 30 minutes by default (`awf run --timeout 2h`). It is
`workflow.deadline`. Everything inside inherits it, and anything can set an earlier one:

```
run deadline (--timeout)
 └─ parallel({ deadline })          earlier or equal
     └─ agent.run({ timeoutMs })    earlier or equal
```

A deadline is `{ unixMilliseconds }`. Agents get it as `deadline` and turns take `timeoutMs` as a
shortcut. When a deadline passes, the turns under it end as `timed-out`, while waits without an
outcome (`parallel`, `decide`) reject with `DeadlineExceededError`. When the run ends for any
reason, every agent is closed and every sandbox torn down.

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

- **`read`, `write`, `network`** say what the agents inside can see and reach. Every provider
  enforces them its own way.
- **`srt`** is Anthropic's sandbox-runtime on your machine, with your toolchain. **`docker`** is a
  container running as your user.
- **Agents that share a sandbox share its reach and files; what that means depends on the
  provider.** Under `docker` a sandbox is one container, and every agent in it runs inside that
  container, so each sees what the others leave anywhere in it. `srt` has no box to share: each
  agent's processes are wrapped by `srt` on their own, under one policy derived from the sandbox.
  They meet only in the host paths it makes writable and in the sandbox's temp directory. Either
  way, each agent has its own home, and can reach its own harness's model API. An inline spec is a
  separate container (docker) or a separate policy (srt).
- **git works.** A writable worktree can commit, but its hooks and config can't be changed from
  inside.
- A sandbox closes when the run does, after every agent in it.
- **The operator can sandbox the whole run instead:** `awf run --sandbox box.json`, with a spec
  such as `{ "read": ["/data/request.md"], "srt": {} }`, puts every agent in one sandbox working in
  `--cwd`, whether or not the workflow asked. A workflow that opens a sandbox of its own, or gives
  an agent one, is refused. `awf-lab` runs every trial this way.

## Decisions

Not every step needs a coding agent. `decide` asks a decision model closed questions about a
piece of state and returns a probability for every possible answer, in about 200 ms. The state is
billed once per call, however many questions you ask, so ask them all together.

```ts
import { choice, score, yesNo } from "agentswf/workflow";

const { answers } = await workflow.decisions.decide({
  key: "triage:42",   // the part before ":" is its cost stage
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
  `OPENROUTER_API_KEY` in the environment or in a `.env` in the directory you run `awf` from. The
  engine holds the key, and no agent sees it.
- **Keep the probabilities and set your own threshold.** The top pick is only a convenience. The
  [findings](findings/system-one-models.md) show where Jev is reliable (matching text to options)
  and where it isn't (anything that needs reading code).
- **A decision that didn't answer rejects** with `DecisionError` (or `DeadlineExceededError`).
  It's recorded either way.

## Logging and usage

```ts
workflow.log("reviewed", { findings: 12 }); // a line in awf's live progress
workflow.usage();                            // this scope's finished operations: times and sessions
```

Costs aren't counted inside the run. After the run, `awf` prices every agent's tokens and prints the
total, and a line per stage when there are several (stages come from key prefixes, as above). `output.json` keeps the tokens and the
price table it used.

## Testing a workflow

A workflow's test sits beside it and runs it through the real engine. Each agent is replaced by a
script: the answers you write for it, each typed by the schema its turn asks for. No agent
starts, so a test takes milliseconds and costs nothing. It checks the workflow's own logic, its
branches, loops and what it does with each outcome; how well real agents answer is what `awf-lab`
measures.

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

`testWorkflow(workflow, args, options)` calls `run` with `args` as they are; `prepare` isn't
called, so a test of it calls it itself. Its runtime aliases are `awf run`'s, `claude` and `codex`;
`runtimes` adds others, or replaces one by name. `awf test` serves `agentswf/workflow`,
`agentswf/testing` and `typebox` as `awf run` does, so the folder needs nothing installed. It
takes paths, `-t`, `--watch` and `--timeout` for each test (5 s by default), and exits 0 when every
test passed, 1 when one failed or none was found, 2 on a usage error. For editor types, the
README's `tsconfig.json` maps `agentswf/testing` too.

### Scripts

`agents` maps an agent's key to its script. A key may be a pattern, where `*` matches anything:
`"verifier:*"`. An exact key wins over a pattern; two patterns matching one key is a mistake the
test reports.

- **`answer(SCHEMA, value)`** answers a turn that asks for `SCHEMA`. The value is typed by the
  schema, so a missing field, or a `kind` the schema's union doesn't list, doesn't compile.
- **`answer(SCHEMA, (turn) => …)`** answers from the turn: `turn.n` (its number in that agent's
  session), `turn.prompt`, `turn.agent`, `turn.cwd`. It may be `async`, and may return a reply.
- **`answer("text")`**, with no schema, answers a turn that asks for text.
- **`reply.silent()`, `blocked()`, `failed()`, `timedOut()`, `hang()`** end a turn without an
  answer. `hang` holds the turn until the engine cancels it, as `parallel` does when another item
  fails.

A silent turn is nudged once, as a real one is. The nudge is met by the same entry, so `turnsOf`
shows two records with the same `n`, the second with `nudge: true`; a function sees `turn.nudge`
and can answer it.

A script is one entry, which meets every turn that agent is asked, or a list, one entry per turn in
order. A list is strict: a turn past its end, or an entry never reached, fails the test. A single
entry may go unused, which makes it the right shape for a happy path shared by several tests:

```ts
// examples/feature-delivery/workflow.test.ts
const args = {
  ticket: "ABC-1",
  runtimes: { planner: "claude", implementer: "codex", reviewer: "codex", additionalReviewers: [] },
};
const doc = "docs/ABC-1.md";
const ready = (summary: string) => answer(VERDICT, { kind: "ready", summary });

/** Every agent does its part at once: the doc is approved, then the code. */
const happyPath: Record<string, Script> = {
  planner: answer(WORK, { docPath: doc, summary: "plan", decisions: [] }),
  reviewer: ready("ok"),
  implementer: answer(WORK, { docPath: doc, summary: "built", decisions: ["LRU"] }),
};
```

A test spreads it and overrides the agents its case is about with lists:

```ts
// examples/feature-delivery/workflow.test.ts
const run = await testWorkflow(featureDelivery, args, {
  agents: {
    ...happyPath,
    planner: [
      answer(WORK, { docPath: doc, summary: "plan", decisions: [] }),
      answer(WORK, { docPath: doc, summary: "plan v2", decisions: ["name the cache"] }),
    ],
    reviewer: [
      answer(VERDICT, { kind: "changes-requested", feedback: ["name the cache"] }),
      ready("doc ok"),
      ready("code ok"),
    ],
  },
});
```

A fan-out is scripted by pattern; `runtimes` adds the workflow's `cheap` and `judge`. Here `holds`
is the test's own verifier answer, `answer(VERDICT_SCHEMA, { refuted: false, … })`, met by every verifier:

```ts
// examples/catalogue-review/workflow.test.ts
const run = await testWorkflow(judged, judged.prepare({ argv: [], cwd: "/repo" }), {
  runtimes: {
    cheap: { harness: "codex", model: "cheap" },
    judge: { harness: "codex", model: "judge" },
  },
  agents: {
    "lens:database": answer(FINDINGS_SCHEMA, {
      findings: [raw("observation", 1), raw("issue", 2)],
    }),
    "lens:deploys": answer(FINDINGS_SCHEMA, { findings: [raw("observation", 5)] }),
    "verifier:*": holds,
  },
});
```

### Decisions

`decisions` maps a decision's key, or a pattern, to its answers, one per question in the
question's own terms: a choice's option or its probabilities, a score's level index or its
probabilities, a yes-no's `true`, `false` or probability of yes. A returned `Error` fails the
call, as a provider outage would.

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

### What the run did

- **`run.value`** is what the workflow returned. If it threw instead, reading `value` throws with
  the workflow's error as the cause, so a test of a failure reads
  `expect(() => run.value).toThrow("lens ids must be unique")`.
- **`run.turnsOf(key)`** is one agent's turns in order, nudges included, each as the workflow
  wrote it: `prompt`, `schema`, `label`, `n`, `nudge`, and its `outcome`. An agent never asked has
  none: `expect(run.turnsOf("implementer")).toEqual([])`. **`run.turns`** has every agent's.
- **`run.compactionsOf(key)`** is one agent's compactions in order, each with its `id`, `focus`
  and `outcome`. They are not turns, and take no entry in the agent's script: each answers `""`
  unless `compactions` scripts it, by key or pattern like `agents`, with `answer("a summary")` or a
  `reply`, a list one entry per compaction.
- **`run.agentOf(key)`** is what an agent was opened with: `execution`, `instructions`,
  `labels`, `skills`, and `sandbox`, absent for an agent on the host. **`run.agents`** lists them
  all.
- **`run.decisions`** and **`run.logs`** are each decision asked and each `workflow.log` line.

An agent's `sandbox` is the sandbox as the run's record keeps it: its `key` (`agent:{key}` for an
agent's own), its `provider`, its settings in `spec` (`read`, `write`, `network`, `cwd` and the
provider's own, with paths absolute and links resolved), and `domains`, everything it can reach in
the end, the harness's model included. So a test can check that each agent runs where it should,
and can reach no more than it should:

```ts
// examples/sandboxes/workflow.test.ts
const team = run.agentOf("ada").sandbox!;
expect(team.spec).toMatchObject({ write: [team.spec.cwd], network: ["registry.npmjs.org"] });
expect(team.domains).toContain("registry.npmjs.org");
const auditor = run.agentOf("auditor").sandbox!;
expect(auditor).toMatchObject({ key: "agent:auditor", provider: "srt" });
expect(auditor.spec).toMatchObject({ read: [], write: [], network: [] });
expect(auditor.domains).not.toContain("registry.npmjs.org");
```

The sandbox itself is a fake that confines nothing, so what a real provider enforces is for the
sandbox evals (`bun run eval`) to show.

Under `parallel`, what starts first is up to the scheduler, so read an agent's turns with
`turnsOf` and an agent with `agentOf` rather than by index. To prove two agents work at once, let
one's answer wait for the other's:

```ts
// examples/minimum-review/workflow.test.ts
const { promise: maintained, resolve: maintainabilityAnswered } = Promise.withResolvers<void>();
const run = await testWorkflow(minimumReview, args, {
  agents: {
    "reviewer:correctness": answer(reviewSchema("correctness"), async () => {
      await maintained;
      return { lens: "correctness", summary: "correctness review complete", findings: [nan] };
    }),
    "reviewer:maintainability": answer(reviewSchema("maintainability"), () => {
      maintainabilityAnswered();
      return {
        lens: "maintainability",
        summary: "maintainability review complete",
        findings: [coupled],
      };
    }),
  },
});
```

Run one after the other, correctness would wait forever, and the test fails as stalled.

### What fails the test, not the workflow

- an agent or a decision with no script;
- a turn past a list's end, or a list entry never reached;
- an answer for a schema other than the turn's, or one the schema refuses;
- a decision's answer its question can't take, or that is no distribution;
- a script that throws;
- a stall: nothing starting or ending for 2 s (`stallMs`), which names the turns in flight, so a
  stuck test fails rather than hangs.

Each message names the agent or decision and the turn, and usually the first line of the turn's
prompt.

Deadlines are real time. `reply.timedOut()` ends a turn as timed out at once; `testWorkflow`'s
own `timeoutMs` sets the run's deadline, 30 minutes by default. Testing what a workflow does as
time passes needs virtual time, which isn't built.

## Not built yet

These calls are in the types and throw `unavailable` today: `agents.attach`, except for the calling
session's key, and `agents.stop`,
`agent.enqueue`, `steps` (durable steps and sleep), `signals` (waiting for
outside input), `participants` and `messages` (agents talking to each other), and `call` (one
workflow calling another). [`docs/status.md`](status.md) says what's next.

## Where to go next

- [`examples/quick-check`](../examples/quick-check): the smallest real workflow.
- [`examples/minimum-review`](../examples/minimum-review): one review round through two lenses.
- [`examples/catalogue-review`](../examples/catalogue-review): fan out over lenses and verify each
  finding.
- [`examples/sandboxes`](../examples/sandboxes): shared and private sandboxes.
- [`examples/calling-session`](../examples/calling-session): driving the session the run was
  started from.
- [`examples/triage`](../examples/triage): decisions with thresholds.
- [`examples/feature-delivery/workflow.test.ts`](../examples/feature-delivery/workflow.test.ts):
  a workflow's tests, review loops and fan-out included.
- [`packages/contract/src/workflow`](../packages/contract/src/workflow): the types themselves, with
  every field documented.
