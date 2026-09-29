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
isAnswered(outcome)                                          // narrows to { kind: "answered", value }

workflow.parallel(items, (item, i) => …, { concurrency?, label?, deadline? })  // → results in item order
workflow.sandboxes.open({ key, write?, read?, network?, srt? | docker? })        // → pass as { sandbox }
workflow.decisions.decide({ key, model: "jev", state, questions })              // → { answers } in ~200 ms

workflow.log(message, fields?)   workflow.usage()   workflow.deadline   workflow.cwd   workflow.runId
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
import { defineExecutableWorkflow, isAnswered } from "agentswf/workflow";
import Type from "typebox";

const SUMMARY = Type.Object({ summary: Type.String() }, { additionalProperties: false });

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
  be JSON.
- **`prepare`** turns the command line (`argv` after `--`, and `cwd`) into args.
- **`present`** and **`report`** are optional. Without `present`, `awf run` prints the full result
  as JSON. `--json` always prints it.

The result, every agent's usage, and why the run ended are kept in `output.json` under
`~/.awf/runs/{run}`. A run that fails or is cancelled keeps this record too.

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
| `cwd` | Where the agent works. Defaults to the workflow's directory. |

A harness is the coding-agent CLI (`claude`, `codex`, `pi`, `cursor`). Your existing login for
each one is used. Cursor runs only in a pane, and pi runs headless.

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

Costs aren't counted inside the run. After the run, `awf` prices every agent's tokens and prints a
line per stage (stages come from key prefixes, as above). `output.json` keeps the tokens and the
price table it used.

## Not built yet

These calls are in the types and throw `unavailable` today: `agents.attach` and `agents.stop`,
`agent.enqueue` and `agent.compact`, `steps` (durable steps and sleep), `signals` (waiting for
outside input), `participants` and `messages` (agents talking to each other), and `call` (one
workflow calling another). [`docs/status.md`](status.md) says what's next.

## Where to go next

- [`examples/quick-check`](../examples/quick-check): the smallest real workflow.
- [`examples/minimum-review`](../examples/minimum-review): fan out, verify and loop.
- [`examples/sandboxes`](../examples/sandboxes): shared and private sandboxes, skills.
- [`examples/triage`](../examples/triage): decisions with thresholds.
- [`packages/contract/src/workflow`](../packages/contract/src/workflow): the types themselves, with
  every field documented.
