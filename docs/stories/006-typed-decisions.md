---
id: "006"
title: Ask a decision model a typed question from a workflow
summary: A workflow asks a System One model, Jev first, typed questions about a state and gets probabilities back, recorded and costed with the run; autoresearch uses it to match review findings to an answer key.
type: story
status: done
discovered_in: "ideas.md (Jev), 2026-09-26"
depends_on: ["004"]
---

# Ask a decision model a typed question from a workflow

## Outcome

A workflow asks a decision model several closed questions about one piece of state, and gets a
probability for every allowed answer back in about 200 ms, for well under a cent:

```ts
import { choice, score, yesNo } from "@agentswf/contract/workflow";

const { answers } = await workflow.decisions.decide({
  key: `triage:${ticket.id}`,
  model: "jev",                                   // an alias the operator configured
  state: { ticket: ticket.text },
  questions: {
    team: choice("Which team owns `ticket`?", { payments: "Checkout, billing", frontend: null }),
    bug: yesNo("Does `ticket` report broken behaviour?"),
    urgency: score("How urgent is `ticket`?", ["later", "this week", "now"]),
  },
});

answers.team.choice;               // "payments" | "frontend"
answers.team.probabilities.payments;
answers.bug.yes;                   // P(yes)
answers.urgency.level;             // 0 | 1 | 2, the most likely level
answers.urgency.expected;          // 1.96, the probability-weighted level
answers.team.probabilities.account; // compile error: not an option
```

A decision other workflows reuse is a plain function that returns the call, and it can live in any
pure module:

```ts
export const SEVERITY = score("How severe is `issue`?", ["nit", "could-fix", "should-fix", "must-fix"]);

export function matchFinding(finding: Finding, key: AnswerKey) {
  const issues = Object.fromEntries(key.issues.map((issue) => [issue.id, issue.mechanism]));
  return {
    key: `match:${key.fixture}`,
    model: "jev",
    state: { finding: finding.text },
    questions: { issue: choice("Which known problem does `finding` raise?", { ...issues, none: "None of these." }) },
  };
}

const { answers } = await workflow.decisions.decide(matchFinding(finding, key));
answers.issue.choice;              // string: the options were only known at run time
```

- **The call is recorded and costed.** `output.json` lists every decision with the model snapshot
  that answered and what it cost, and every accounting slice shows decision spend beside agent
  spend. The full request and its answers go to the run's artifacts, so thresholds can be fitted
  again later without calling the model.
- **Nothing but the engine sees the credential.** The engine reads `OPENROUTER_API_KEY` from the
  operator's environment and withholds it from every agent and sandbox.
- **Autoresearch can match review findings to an answer key with it.** A confident match is taken
  as it is, and anything else goes to the agent judge. Moved to [[011-compare-variants|decision-matching]] when the story
  closed: the surface it needs is built, and `examples/triage` is its consumer meanwhile.

Why now: the review scorer ([[008-review-scorer]]) has to match every finding of every run of
every variant to a key issue. Its agent judge reads all of a fixture's findings in one call,
because it has to apply the claim-once and duplicate rules. A decision model can't replace that
call, but it can settle the easy matches first, so the judge reads less and argues less. On review
comments, Jev settled 72% of matches at 99% accuracy, for under $0.0001 each
([findings S8](../findings/system-one-models.md)). Those comments are the ones the key was drafted
from, so how well this holds on a variant's own findings is what Task 4 measures. Jev is the first
of a family ("System One" models), so the interface has to fit models that don't exist yet, not
only Jev.

## How it works

```
workflow ──decide({key, model, state, questions})──▶ engine: decisions directory
                                                        │ resolve alias → {provider, model}
                                                        │ deadline, cancel, retry 429/5xx
                                                        ▼
                                              DecisionProvider (engine-internal seam)
                                                        │ openrouter: POST /api/alpha/decisions
                                                        ▼
            answers ◀── map to awf's answer shape ◀── {model snapshot, answers, usage}
                │
                ├─▶ {runDir}/decisions/{n}.json    request + answers, for offline thresholds
                └─▶ output.json decisions[]         key, provider, snapshot, attempts, tokens, cost
```

- **One call is one state and many questions.** The provider bills the state once per request,
  whatever the number of questions: 1, 10 and 50 questions over one state cost within 9% of each
  other, and 200 questions answer in 192 ms (S3). A call per question would pay for the state each
  time. The questions are answered independently and can't see each other's answers.
- **Three question types.** `choice` picks one named option (a description each, or `null`).
  `score` places the state on ordered levels. `yes-no` gives the probability of yes. They are
  Jev's three. TypeSafe's own adapter serves the same three over any LLM, and Cohere's classifier
  serves `choice` only ([research](../research/system-one-models.md#implications-for-a-provider-neutral-typed-decision-abstraction)).
  awf renames Jev's "noul" to `yes-no`, and gives each type its own field (`options`, `levels`,
  `criteria`) where Jev overloads `criteria`. The provider translates.
- **The answer is the distribution.** Every answer carries the probabilities, and the top pick is
  only a convenience. On severity, Jev's top pick agreed with the graders less often than the grader
  pairs agreed with each other. Its expected level, cut at thresholds fitted on other MRs, was the
  best result (S6). **A provider must return a distribution.** A model that only returns a pick,
  such as an LLM asked through structured output, needs a provider that builds one (from logprobs,
  or by sampling), or it doesn't qualify. The vendor's `confidence` is left out: it can't be rebuilt
  from the probabilities, and the top probability ranks right answers above wrong ones exactly as
  well (S10).
- **Model identity is pinned by the record.** Output varies slightly between identical calls (S5),
  and aliases such as `jev-latest` move, so a threshold only holds for the snapshot it was fitted
  on. Every record keeps the snapshot that answered (`typesafe/jev-1.13-20260917`).
- **Limits belong to the provider.** 255 options, 10 levels and about 32k tokens are Jev's
  limits, and it rejects anything past them with a clear 400 (S2). awf passes that error on rather
  than hard-coding one vendor's numbers.

### The interface: typed questions, one call, reusable as plain functions

The goal is a model any workflow can use, so the interface has to be the part that is hard to get
wrong. Four ways of typing a classifier's result exist in libraries today:

| Library | How a question is written | How the result gets its type | Probabilities |
| --- | --- | --- | --- |
| TypeSafe SDK ([`typesafe-sdk-js`](https://github.com/typesafe-ai/typesafe-sdk-js), `src/questions.ts`, `src/types.ts`) | builders `choice(instructions, options)`, `score(instructions, levels)`, `noul(instructions)` with `const` generics; many per call | `answers.{name}` inferred per question: a choice's `choice` is the union of its option keys, a score's `probabilities` and `legend` are keyed by level index | yes |
| Vercel AI SDK ([`Output.choice`](https://ai-sdk.dev/docs/reference/ai-sdk-core/generate-text)) | a spec object, `Output.choice({ options })`, passed to a generic `generateText` | `output` is one of the options | no; one output per call |
| BAML ([functions](https://github.com/boundaryml/baml/blob/canary/fern/03-reference/baml/function.mdx)), DSPy signatures | a named function declared once, `function Classify(text) -> Category`, called many times | code generation from the declaration; options only known at run time need a `@@dynamic` enum | no |
| awf's own agents | `agents.run({ prompt, schema })` with `OutputSchema<T>` | `T` from the schema | not applicable |

What awf takes:

- **Builders, from TypeSafe's SDK.** `choice`, `score` and `yesNo` are pure functions in
  `@agentswf/contract/workflow`, and they return typed question values. Without them, an author writes
  the discriminant by hand, and a question built outside the call widens `type` to `string` and
  fails to compile unless it is annotated. With them, answers are typed without annotations:
  - a choice's answer is the union of its options;
  - a score's `level` is the union of its level indices, and `probabilities` is keyed by them;
  - a yes-no gives `yes`.

  The builders also reject an empty option map or level list when they are called, so the mistake
  shows up where it was made. This was checked under the repo's strict `tsc`.
- **One call, many questions.** Per-type methods such as `decisions.choice(state, …)` read well for
  one question, but each would pay for the state again (S3). The AI SDK's one-output-per-call shape
  is right for a generative model and wrong for this one. A single question is just a map with one
  entry.
- **Reuse is a plain function, not a registry.** BAML's lesson is that a decision is worth naming
  and defining once. awf already has that in TypeScript: a function that returns the call, like
  `matchFinding` above, living in whatever pure module owns the domain. It needs no new
  declaration kind and no code generation. Options known only at run time, such as a key's issues,
  widen to `string`, as in BAML's dynamic enums. A named "decision definition" type is the step to
  take once two workflows share a decision and need something a function can't give. Neither does
  yet.
- **What a fitted threshold binds to.** A threshold is only valid for the questions it was fitted
  on and the snapshot that answered (S5, S6). The record keeps a digest of the questions (their
  types, instructions, options and levels), as `draft-key` does with `PROCEDURE`. A reused decision
  function therefore gets a stable identity for free, and changing a word in its instructions shows
  up as a new one.

The case people will ask about first is why this isn't an agent. An agent has a session, turns, a
result slot, a nudge, and a pane or process. A decision has none of them: it is one stateless
HTTP call that returns in 200 ms and never produces text. Putting it behind `agents.open` would
make `OperationRecord` lie about sessions and placement. It also can't simply be a helper function:
its spend would then be missing from a run's cost, and autoresearch compares variants on cost.

## Scope

In scope:

- The author surface: `WorkflowContext.decisions.decide`, its question and answer types, and type
  inference from the questions.
- The run record:
  - a `DecisionRecord` per call in `output.json`;
  - the request and answers in the artifacts;
  - decision figures in every `RunAccounting` slice.
- The engine-internal provider seam, a fake provider for the engine's tests, and an OpenRouter
  provider for Jev. The OpenRouter provider is installed when `OPENROUTER_API_KEY` is set, and the
  key is withheld from agents.
- A first consumer: `matchFindings` in `packages/lab` and the workflow that runs it.

Out of scope:

- Severity grading with Jev. It measured poorly without cut points fitted per snapshot, and it
  doesn't read the code (S6, S7). The records this story keeps are what such a fit would need.
- The TypeSafe native API and an LLM-backed provider (like TypeSafe's own
  `system-one-adapter`). The seam allows both, but neither has a consumer yet.
- Agents asking decisions through `wf`. Only workflow code calls `decide`.
- The review scorer itself ([[008-review-scorer]]); it will call `matchFindings`.
- Any use in `SemanticCheck` (`packages/contract/src/semantic.ts`). A yes-no question fits that
  seam, but nothing asks for it.

## Context and evidence

- Fact: the API, its limits and its price, from primary sources:
  [`research/system-one-models.md`](../research/system-one-models.md).
- Fact: what live calls showed, S1–S10: [`findings/system-one-models.md`](../findings/system-one-models.md).
  The ones the design rests on:
  - the state is billed once per request (S3);
  - the distribution matters more than the top pick (S6);
  - `confidence` can't be rebuilt from the probabilities and isn't needed (S10);
  - output varies slightly between identical calls (S5);
  - the provider enforces its own limits (S2);
  - matching works on comments (S8).
- Fact: `jev-1.13` refuses OpenRouter's chat endpoint (S1), so no OpenAI-compatible client or
  harness can drive it.
- Fact: every agent inherits the operator's environment, apart from
  `METERED_CREDENTIAL_ENVIRONMENT` (`packages/engine/src/operator-runtime.ts:146`). That one list
  is both refused at startup and emptied for agents. `OPENROUTER_API_KEY` must be withheld without
  being refused, so the list has to split. Otherwise a harness that reads provider keys, such as
  pi, could bill against it.
- Fact: every figure in `AccountingFigures` counts agents (`known`, `priced` and `billed` are "how
  many of `agents`"), and `describeAccounting` prints them as ratios over agents
  (`packages/engine/src/accounting/format.ts`). Decisions need figures of their own.
- Constraint: [ADR 0001](../adr/0001-unbuilt-interface-leaves-the-surface.md). A published type
  lands in the same change as its implementation and a workflow that needs it. So the types and
  the engine are one task, and `match.workflow.ts` is this story's consumer.
- Constraint: `contract` stays pure (boundary 1). The provider does I/O, so it lives in the engine.
- Constraint: autoresearch imports only `@agentswf/contract` and `@agentswf/engine`, never a subpath
  (boundary 5, `scripts/check-boundaries.ts`). It reaches decisions through `WorkflowContext`, and
  its tests stub `decisions.decide` by hand.
- Constraint: data leaves the machine. OpenRouter lists the TypeSafe endpoint as `training: false,
  retainsPrompts: false` (research §6). The record names the provider on every call, so
  [[010-eval-isolation|story 010]] can see it.
- Assumption: other System One models will keep the "a state, many typed questions,
  probabilities back" shape. OpenRouter's Decisions API is a generic surface named for decisions
  rather than for Jev, which suggests it will, but nothing has confirmed it.
- Not measured: matching on a variant's own findings (S8 used the comments the key was drafted
  from), and whether a cheap LLM matches as well. Sending the private fixtures to a second provider
  was not approved.

## Code map

### contract

- `packages/contract/src/workflow/decisions.ts` (new), exported from
  `packages/contract/src/workflow/index.ts`:
  - `DecisionSpec<Q>`;
  - `DecisionAliasName` (a string, like `RuntimeAliasName`);
  - `Question` (`ChoiceQuestion<O> | ScoreQuestion<L> | YesNoQuestion`) and `Answer<Q>`;
  - the builders `choice`, `score` and `yesNo`: pure, typed by `const` generics, and rejecting an
    empty option map or level list;
  - `DecisionRecord`, what `decide` returns and `DecisionError` carries. It lives here, as
    `OperationRecord` lives in `agents.ts`, because `workflow/` never imports `records.ts`;
  - `DecisionDirectory`, and `DecisionError` (a class, as `DeadlineExceededError` is in
    `timing.ts`).
- `packages/contract/src/workflow/workflow.ts`: `WorkflowContext` gains
  `readonly decisions: DecisionDirectory`. Every other implementation of `WorkflowContext` gets it
  too; the engine's test helpers are among them, so search for them.
- `packages/contract/src/records.ts`:
  - `SettledDecision = DecisionRecord & { charged?: Money }`, as `SettledOperation` adds spend to
    `OperationRecord`, and `OutputRecord.decisions?: SettledDecision[]`, absent when there are none,
    like `sandboxes`;
  - `DecisionFigures`, `{ calls, attempts, tokens: { input, output }, estimate?, charged?, priced }`,
    as `decisions?` on `AccountingFigures`, so every slice (totals, stage, agent) shows it;
  - `RunAccounting.byModel` gains decision models, and `unpriced` names a decision model with no
    rate;
  - `OUTPUT_RECORD_VERSION` goes to 3. Agent figures are unchanged, but a reader that sums only
    `estimate` misses decisions.
- `packages/contract/src/workflow/decisions.typecheck.ts` (new), after the pattern of
  `deadlines.typecheck.ts`. It checks that:
  - a choice's `choice` is its options' union;
  - a score's `level` is its indices' union;
  - an unknown option, level or question is a compile error;
  - a reusable function's dynamic options widen to `string`.
- `packages/contract/AGENTS.md`: the new subpath content.

### engine

- `packages/engine/src/decisions/` (new):
  - `seam.ts`: `DecisionProvider` and `DecisionProviderError`.
  - `directory.ts`: `decide`. It resolves aliases, applies deadlines and cancellation, retries and
    counts attempts, computes `questionsDigest`, writes the artifact, and records the call.
  - The digest is SHA-256 over the questions as JSON with keys sorted, in the engine, because
    `contract` can't hash (boundary 1). `draft-key`'s `PROCEDURE` uses `Bun.CryptoHasher` the same
    way.
  - `openrouter.ts`: the Jev provider.
  - `fake.ts`: a scripted provider, for the engine's own tests only.
- `packages/engine/src/workflow-runner.ts`:
  - `RunWorkflowOptions` takes the installed decisions;
  - `WorkflowOwner` builds `context.decisions` beside `sandboxes`, and closes by waiting for calls
    still in flight;
  - `SettledRun` and `WorkflowRunError` carry `decisions`, so a failed run keeps them.
- `packages/engine/src/run-usage.ts`: the ledger keeps decision records beside agents.
- `packages/engine/src/accounting/summary.ts`, `prices.ts` and `format.ts`:
  - `summarizeRun` takes decisions too. It is public (`engine/src/index.ts`); its callers are
    `workflow-runner.ts` and `accounting.test.ts`.
  - Decisions are priced by `snapshot`. `RATES` in `prices.ts` gains `typesafe/jev-1.13` ($0.042/M
    input, $0 output and cache), and `lookup`'s dated-id rule maps `typesafe/jev-1.13-20260917` to
    it.
  - `charged` comes from the provider's `usage.cost` when it reports one.
  - `describeAccounting` prints decisions on a line of their own.
- `packages/engine/src/operator-runtime.ts`:
  - `OperatorRuntimeInstallation` gains `decisions`.
  - `installDecisions(environment)` installs the OpenRouter provider, and a default `jev` alias →
    `typesafe/jev-1.13`, when `OPENROUTER_API_KEY` is set. It is the only importer of
    `./decisions/openrouter`.
  - `METERED_CREDENTIAL_ENVIRONMENT` splits into what is refused and what is withheld from agents.
    `OPENROUTER_API_KEY` is withheld. Herdr's `emptyEnvironment` and the headless host's
    `withholding(run, …)` take the withheld list; both already accept any list.
- `packages/engine/src/operator-cli.ts`: passes the decisions to `startWorkflow`, and `recordOf`
  writes them into `output.json`.
- `scripts/check-boundaries.ts`: a rule that only `operator-runtime.ts` imports
  `./decisions/openrouter`. `providerImport` covers only `@agentswf/sandbox/*` today.
- `packages/engine/AGENTS.md`: the decisions folder.
- Checked, no change: `cli-agent` (agents can't call it), the `sandbox` package and `harness`.

### autoresearch

- `packages/lab/src/review/match.ts` (new): `matchFindings(workflow, key, findings,
  { model, threshold })`. `findings` is `{ id: string; text: string; path?: string; line?:
  number }[]`, since the `ReviewFinding` type story 005 describes doesn't exist in code yet. It
  asks one choice per finding (issues + `none`) and returns `{ finding, issue | "none",
  probability, decided }`:
  - At or above the threshold, `decided` is true.
  - Below it, `decided` is false and the caller's judge settles the finding.
  - A decided `none` still goes to the judge, which labels it `new`, `noise` or `wrong`.
  - Two findings decided onto one issue are left for the scorer to label as duplicates.

  The call itself is a reusable function, `matchFinding(finding, key)`, built with the builders.
- `packages/lab/src/review/match.workflow.ts` (new): runs `matchFindings` over a fixture
  set and a findings file, and returns each match with its probabilities as its value, with a
  report of the decided share. It is the consumer ADR 0001 asks for, and Task 4 measures with it.
  - Its args are `{ set, findings }`. `set` is a fixture set's path. `findings` is a JSON file of
    `{ fixture, findings[] }`, so Task 3 can build one from the set's comments and Task 4 from a
    variant's output.
  - It is run by path, like `fixtures.workflow.ts`, and `index.ts` exports `matchFindings` and
    `matchFinding`.

### docs

- `docs/foundation.md`:
  - §7 gains a row: "fast typed decisions (System One models)" lands in `contract/workflow` (types),
    `engine/src/decisions/` (seam and providers) and `records`;
  - §10 gains a row: a `decisions` package is extracted when a provider needs its own dependency;
  - §8's cost-record questions (charge basis, funding pool) apply to decisions too: they are
    metered on the operator's OpenRouter account.
- `docs/testing.md`: the new live eval and what it costs.

## Proposed design

**Author types and builders** (`@agentswf/contract/workflow`). They were checked under the repo's
strict `tsc`, including the compile errors, and follow the TypeSafe SDK's `ResultFor`.

```ts
type DecisionText = string | JsonObject;           // structured instructions are allowed, as Jev allows
type DecisionAliasName = string;
type DecisionOptions = Record<string, DecisionText | null>;
type DecisionLevels = readonly DecisionText[];   // non-empty is checked by the builder, so a run-time list compiles

interface ChoiceQuestion<O extends DecisionOptions = DecisionOptions> {
  readonly type: "choice"; readonly instructions: DecisionText; readonly options: O;
}
interface ScoreQuestion<L extends DecisionLevels = DecisionLevels> {
  readonly type: "score"; readonly instructions: DecisionText; readonly levels: L;
}
interface YesNoQuestion {
  readonly type: "yes-no"; readonly instructions: DecisionText;
  readonly criteria?: { yes: DecisionText; no: DecisionText };
}
type Question = ChoiceQuestion | ScoreQuestion | YesNoQuestion;

declare function choice<const O extends DecisionOptions>(instructions: DecisionText, options: O): ChoiceQuestion<O>;
declare function score<const L extends DecisionLevels>(instructions: DecisionText, levels: L): ScoreQuestion<L>;
declare function yesNo(instructions: DecisionText, criteria?: { yes: DecisionText; no: DecisionText }): YesNoQuestion;

/** A tuple's indices as numbers, or `number` for a list only known at run time. */
type LevelOf<L extends DecisionLevels> = number extends L["length"]
  ? number
  : Extract<keyof L, `${number}`> extends `${infer N extends number}` ? N : never;

type Answer<Q> =
  Q extends ChoiceQuestion<infer O>
    ? { type: "choice"; choice: keyof O & string; probabilities: { readonly [K in keyof O]: number } }
  : Q extends ScoreQuestion<infer L>
    ? { type: "score"; level: LevelOf<L>; expected: number; probabilities: readonly number[] }
  : { type: "yes-no"; yes: number };

interface DecisionSpec<Q extends Record<string, Question>> {
  key: string;                    // record identity and accounting stage; not unique
  model: DecisionAliasName;
  state: string | JsonValue;
  questions: Q;                   // at least one
  deadline?: AbsoluteDeadline;    // defaults to the scope deadline
}

interface DecisionDirectory {
  /** Rejects with DeadlineExceededError past the deadline, and DecisionError on any other failure. */
  decide<const Q extends Record<string, Question>>(
    spec: DecisionSpec<Q>,
  ): Promise<{ answers: { [K in keyof Q]: Answer<Q[K]> }; record: DecisionRecord }>;
}

class DecisionError extends Error {
  readonly record: DecisionRecord;  // outcome "failed" or "cancelled"
}
```

A question written as a bare object literal still works inline. Built elsewhere, it needs
`satisfies Question` or its `type` widens to `string`, which is why the builders are the
documented way to write one.

**The seam** (engine-internal, not published):

```ts
interface DecisionProvider {
  decide(
    request: { model: string; state: string | JsonValue; questions: Record<string, Question> },
    signal: AbortSignal,
  ): Promise<{
    snapshot: string;                              // the versioned model that answered
    answers: Record<string, ProviderAnswer>;       // awf's shape, with the full distribution
    tokens: { input: number; output: number };
    charged?: Money;
    requestId?: string;
  }>;
}
// Rejects with DecisionProviderError { retryable } — 429, 5xx and 529 are retryable.
```

**The record** (`DecisionRecord` in `@agentswf/contract/workflow`; `output.json` holds
`SettledDecision`, which adds `charged` in `@agentswf/contract/records`):

```ts
type DecisionRecord = {                    // @agentswf/contract/workflow
  callPath: string[];
  key: string;
  alias: string;                  // as the workflow asked
  provider: string;
  model: string;                  // as the alias resolved
  snapshot?: string;              // as answered; absent when none did
  startedAt: string;
  settledAt: string;
  questions: { id: string; type: Question["type"] }[];
  /** SHA-256 of the questions, a choice's option order included: what a fitted threshold binds to, with `snapshot`. */
  questionsDigest: string;
  outcome: "answered" | "failed" | "timed-out" | "cancelled";
  error?: string;
  /** Requests sent, retries included; each may have been billed. */
  attempts: number;
  /** Summed over attempts, as far as the provider reported them. */
  tokens?: { input: number; output: number };
  requestId?: string;
  /** Under the run's artifacts: the request and answers, for fitting thresholds offline. */
  artifact: string;
};

type SettledDecision = DecisionRecord & { charged?: Money };  // @agentswf/contract/records

type DecisionArtifact = {                                      // decisions/{n}.json
  record: SettledDecision;
  request: { state: JsonValue; questions: Record<string, Question> };
  answers?: JsonObject;                                        // as `decide` returned them
};
```

Invariants and errors:

- `decide` resolves only with an answer for every question asked, each of the asked type, with a
  complete distribution: every option of a choice, every level of a score. An answer missing any
  of that is a failure and never a partial result. OpenRouter's schema marks `probabilities`
  optional, so this is checked, not assumed.
- Probabilities are passed on as the provider gives them. Jev rounds them to two decimals and they
  sum to 0.99–1.00 (S10); awf does not renormalise them. It rejects a distribution whose sum is
  further from 1 than that rounding allows (0.02, or 0.005 per value past four).
- A failure rejects `decide`, after retries within the deadline: `DeadlineExceededError` when the
  deadline passed, otherwise `DecisionError` with the provider's message. It is still recorded
  with its attempts and whatever spend was reported. A failed run keeps its decisions, as story
  003 keeps agent spend. A spec the engine refuses (an unknown alias, no questions, an invalid
  deadline) rejects with an `Error` before anything is sent, and leaves no record.
- An answered call whose artifact can't be written is recorded `failed`: its answer could not be
  fitted again. Any other outcome stands, with the lost write added to its error.
- The artifact is written by the engine, the only writer of the run directory. It holds the state,
  so it is as private as the run's other artifacts.
- The credential is read once, when the operator runtime starts. It is withheld from every agent's
  environment, pane or headless, sandboxed or not, and nothing puts it into a prompt.

Alternatives rejected:

- A fetch helper in autoresearch. The spend would be invisible to the run's cost, which is what
  variants are compared on. It would have no deadline or cancellation, every caller would handle
  the key, and `examples/` could not use it.
- A harness, behind `agents.open`. A decision has no session, turn, result slot, nudge, pane or
  text, and `OperationRecord` would carry fields that mean nothing for it.
- Chat completions with a structured-output enum. That returns no distribution, and Jev refuses
  the endpoint (S1).
- Jev's wire shape as the author surface (`noul`, an overloaded `criteria`, `confidence`). It ties
  workflows to one vendor, and `confidence` can't be reproduced (S10).
- One question per call, or per-type methods such as `decisions.choice(state, …)`. Each pays for
  the state again (S3).
- Named decision definitions, BAML- or DSPy-style. A function returning the call already names
  and reuses a decision, and `questionsDigest` gives it an identity. A declaration kind waits
  until two workflows need something a function can't give.
- Bare object literals as the documented way to write a question. They lose their literal `type`
  once built outside the call, and nothing checks an empty option map before a request.
- Limits in the contract. They are per provider, and the provider already rejects past them
  clearly (S2). A constant would be wrong for the next model.
- Decision spend folded into the agent figures. `known`, `priced` and `billed` count agents, so a
  decision model with no rate would lower `estimate` and no gap would show.

## Tasks at a glance

- [x] 1. `decide` end to end on a fake provider: the types, the engine, the record, the accounting
- [x] 2. The OpenRouter provider, installed from the operator's environment, with its key withheld from agents
- [ ] 3. `matchFindings` and its workflow in autoresearch — moved to [[011-compare-variants|decision-matching]]
- [ ] 4. Measure matching on a variant's own findings — moved to [[011-compare-variants|decision-matching]]

## Decisions

Settled 2026-09-26, when the story was readied for implementation. Each can be reopened at its
task's plan step, but only by changing this section first.

- **`yes-no`, not `noul`.** The author surface stays vendor-neutral, and the OpenRouter provider
  translates. The builder is `yesNo`.
- **`decide` rejects on failure.** A decision failing is exceptional (an HTTP error), where an agent
  not answering is normal, so it doesn't copy `agents.run`'s outcome union. A deadline rejects with
  the contract's `DeadlineExceededError`, as other deadline-bound calls do, and any other failure
  with a `DecisionError` carrying the record. The record in `output.json` says `timed-out`,
  `cancelled` or `failed` either way. If workflows start catching `timed-out` to branch on it, the
  union is the change to make.
- **The artifact always holds the full request.** Offline thresholds need the state, and a run's
  directory is already private. At Jev's 32k-token limit, a file is at most about 150 KB.

## Open questions

### 1. `decide` end to end

- None.

### 2. The OpenRouter provider

- None.

### 3. `matchFindings`

- None.

### 4. Measure matching

- **Where the findings come from.** Nothing in the repository has run a review variant over the
  fixtures yet. The cheapest source is the minimum review workflow from story 001, run over a few
  fixtures, at the agents' cost. Labelling its findings needs a judge: an agent judge, or the
  scorer once it exists. This is settled at Task 4's plan step and blocks only Task 4; Tasks 1–3
  don't depend on it.
- **An LLM baseline.** It is unmeasured whether a cheap LLM matches as well as Jev. Running one on
  the private set needs the operator's approval to send that data to a second provider.

## Task execution rule

Process one task at a time. Every task repeats the checklist shown under its details. Do not begin
the next task because the current implementation merely compiles: its design must be recorded, its
diff reviewed by subagents, findings resolved, and focused verification complete.

After all tasks are complete, run story-level verification and request human review of the complete
deliverable.

## Task details

### 1. `decide` end to end on a fake provider: the types, the engine, the record, the accounting

Outcome: a workflow run on the fake provider gets typed answers, and `output.json` records and
prices every call. The types and their implementation land together (ADR 0001).

Execution:

- [x] Plan: the ledger's shape for decisions, and the retry backoff (in the directory, not the
  provider).
- [x] Implement: this task's contract and engine files from the code map, and the foundation rows.
- [x] Review: architecture and scope; correctness and proof.
- [x] Resolve: disposition every finding.
- [x] Verify: the focused tests, `bun test`, `bunx tsc --noEmit`, `bun run scripts/check-boundaries.ts`.

Work:

- The contract:
  - the author types and the typecheck file;
  - `DecisionRecord`, `DecisionFigures`, `OutputRecord.decisions?`, and version 3.
- The engine:
  - `decisions/{seam,directory,fake}.ts`;
  - the runner wiring, with the decisions in `SettledRun` and `WorkflowRunError`;
  - the ledger, `summarizeRun` and its callers, and `describeAccounting`.
- Alias resolution, and the deadline and cancel through `AbortSignal`.
- Retries of retryable errors within the deadline, counted in `attempts`.
- The artifact file, and closing by waiting for calls still in flight.

Done when:

- The typecheck file proves the answer types listed in the code map, and a unit test proves the
  builders reject an empty option map or level list.
- The same questions give the same `questionsDigest`, and a changed word in one gives a new one.
- There are engine tests for:
  - an answered call;
  - an answer missing a question or its probabilities (rejects, recorded as failed);
  - a retryable error then success (`attempts: 2`);
  - a deadline expiring mid-call (`timed-out`, recorded);
  - cancellation;
  - a failed run keeping its decisions;
  - accounting showing a decision's cost in its slice, and an unpriced decision model in `unpriced`.
- `contract` still imports nothing and performs no I/O.

### 2. The OpenRouter provider, installed from the operator's environment, with its key withheld from agents

Outcome: `awf run` with `OPENROUTER_API_KEY` set answers `decide({ model: "jev", … })` from Jev, and
no agent can read the key.

Execution:

- [x] Plan: map the request and answers both ways, classify HTTP errors, and split the credential
  list.
- [x] Implement: `openrouter.ts`, `installDecisions`, the withheld list, and the boundary rule.
- [x] Review: architecture and scope; correctness and proof.
- [x] Resolve: disposition every finding.
- [x] Verify: unit tests against recorded responses, the environment test, and the live eval.

Work:

- The request mapping: `options`/`levels`/`criteria` → Jev's `criteria`, and `yes-no` → `noul`.
- The response mapping: `score` → `expected`, and the argmax → `level`.
- `usage.cost` → `charged`, and `model` → `snapshot`. 400s are not retryable; 429 and 5xx are.

Done when:

- A headless agent's environment and a pane's command both lack `OPENROUTER_API_KEY`, and setting
  it does not refuse the run.
- `tests/decisions.eval.ts` makes one call with all three question types on synthetic state. It
  checks the answer shapes, the snapshot and a cost under $0.001, and skips, rather than fails,
  when no key is set. Like the other evals, it refuses to run without `WF_LIVE_EVAL=1` and prints
  the `{ ok, estimateUsd }` summary that `scripts/eval.ts` totals.

### 3. `matchFindings` and its workflow in autoresearch

Outcome: the review scorer (story 008) can call `matchFindings`, and `match.workflow.ts` runs it over a fixture
set.

Execution:

- [ ] Plan: the threshold default (0.9 from S8) and what the state holds (the finding's text, and
  its location if it has one).
- [ ] Implement: `match.ts`, `match.workflow.ts`, and a test with a hand-written `decisions.decide`
  stub.
- [ ] Review: architecture and scope; correctness and proof.
- [ ] Resolve: disposition every finding.
- [ ] Verify: the focused test, `check-boundaries`, and one live run over the private set's comments.

Work:

- One `decide` per finding, with every key issue as an option and `none` besides.
- Split the results into decided and escalated at the threshold, and write each match with its
  probabilities.

Done when:

- The stubbed test covers:
  - a decided match;
  - an escalation below the threshold;
  - a decided `none`;
  - two findings decided onto one issue.
- A live run over the private set's comments reproduces S8 within noise: at least 95% of decided
  matches are right, and at least 60% of findings are decided. This checks the plumbing against a
  known result, not the benefit.

### 4. Measure matching on a variant's own findings

Outcome: the findings say how well `matchFindings` does on findings a review variant produced,
which is what the scorer will feed it.

Execution:

- [ ] Plan: settle this task's open questions.
- [ ] Implement: no code; a measurement.
- [ ] Review: have one subagent check the labelling and the arithmetic.
- [ ] Resolve: disposition every finding.
- [ ] Verify: the numbers are in `docs/findings/system-one-models.md`.

Work:

- Run a review variant over a few fixtures, and label its findings against the keys.
- Run `match.workflow.ts` on them, and fit the threshold.

Done when:

- A new S row records the decided share and its accuracy on those findings, and the threshold
  `matchFindings` defaults to.
- If fewer than half the findings are decided at 95% accuracy, record that the scorer should not
  use it, and say so in [[008-review-scorer]].

## Verification

Automated:

- [x] `decisions.typecheck.ts`: answers are typed from their questions.
- [x] Engine tests on the fake provider (Task 1's list).
- [x] OpenRouter mapping tests against recorded responses, and the withheld-key test.
- [ ] `matchFindings` with a stub — moved to [[011-compare-variants|decision-matching]].
- [x] `bun test`
- [x] `bunx tsc --noEmit`
- [x] `bun run scripts/check-boundaries.ts`

Manual or live evaluation:

- [x] `bun run eval decisions`: four live calls through `examples/triage`, under $0.001.
- [ ] `match.workflow.ts` over the private set's comments — moved to [[011-compare-variants|decision-matching]].
- [ ] Task 4's measurement — moved to [[011-compare-variants|decision-matching]].

## Review record

### Refinement

- 2026-09-26, one read-only subagent against the code, the ADRs and the findings. Its findings, and
  what was done with each:
  - The key would have leaked to agents. It is now withheld.
  - Folding decisions into the agent figures would hide unpriced ones. They now have figures of
    their own.
  - Autoresearch can't import the engine's fake. Its test now uses a stub.
  - Nothing enforced the provider import rule. There is now a boundary rule.
  - Task 1 as planned left the types without their implementation (ADR 0001). The types and the
    engine are now one task, and `match.workflow.ts` was added as the consumer.
  - A missing distribution was not rejected. It is now a failure.
  - S8 measured the wrong population. Task 4 now measures on a variant's findings.
  - Some figures weren't in the findings. They were corrected or added there.
  - The code map missed some callers. They are mapped now.
  - Retries were hidden. Each record now counts its attempts.
  - The eval would have failed without a key. It now skips.

### Task 1

Two read-only subagents on 2026-09-26, one per dimension. Every finding was checked against the
code, and each has a disposition.

- Architecture and scope:
  - The artifact was an unnamed format, and `questions` meant two things. **Fixed:**
    `DecisionArtifact` in `records`, `{ record, request, answers }`, written with the settled
    record, `charged` included.
  - A score's `probabilities` was typed as an object and returned as an array. **Fixed:** it is
    `readonly number[]`.
  - `decide`'s documentation promised a record for every rejection. **Fixed:** a refused spec is
    documented as an unrecorded `Error`.
  - `decisions` meant a count on `ModelFigures` and figures elsewhere, and `byAgent` allowed it.
    **Fixed:** `ModelFigures.decisionCalls`, and `byAgent` omits `decisions` in its type.
  - The price basis still named 2026-09-23. **Fixed:** 2026-09-26, the day Jev's rate was read.
  - `summarizeRun`'s decisions were optional, so a re-pricing caller could silently drop them.
    **Fixed:** required.
  - Helper types were exported without a consumer. **Fixed:** `LevelOf` and the three answer
    types are no longer exported. `DecisionOptions` and `DecisionLevels` stay, because they
    constrain exported generics.
  - `DecisionInstallation` is not in the engine's public entry. **No change:** autoresearch reaches
    decisions through `WorkflowContext` and never builds an installation.
  - The unwritable-artifact rule lived only in a comment. **Fixed:** it is in the invariants.
- Correctness and proof:
  - An unwritable artifact turned a timeout into a failure. **Fixed:** only `answered` is
    downgraded, and the rest keep their outcome. Tested.
  - A choice was not checked the way a score is: all zeros passed, and so did a sum of 2. **Fixed:**
    both types reject a sum further from 1 than rounding allows. Tested.
  - A second currency on a retry dropped the whole `charged`. **No change:** one provider bills one
    currency. A mixed sum is unknown rather than wrong, as for agents.
  - An option named `__proto__` gave a partial answer. **Fixed:** own-key reads, and the result is
    built from entries. Tested.
  - A NaN `deadline` was ignored. **Fixed:** it is validated before being combined. Tested.
  - Stage lines hid partial pricing. **Fixed:** they show the same gaps as the totals line.
  - An empty option map or level list still compiles. **No change, recorded:** a non-empty tuple
    type would reject level lists known only at run time, so the builder checks when it is called.
  - The cancel reason is generic ("workflow closed", "parallel deadline exceeded"). **No change:**
    the outcome is right, and the reason is the engine's existing scope-cancel message, which
    agents get too.
  - The digest ignored option order, which breaks ties. **Fixed:** option order counts. Tested.
  - Missing proofs are now tested: a wrong-typed answer, a yes-no without `yes`, an extra option,
    a NaN, the cap of three requests, a retry skipped at the deadline, and a stage with both agents
    and decisions.

### Task 2

Two subagents on 2026-09-26, one per dimension, after the live run. Every finding was checked
against the code, and each has a disposition.

- Architecture and scope:
  - The triage example needs both subscription logins, because `awf run` checks them at start even
    for a workflow with no agent. **Documented** in `examples/README.md`. Making the check lazy
    changes the operator runtime's contract, which is a story of its own.
  - The live eval stubbed the runtime, so `awf run` → `installOperatorRuntime` → runner was never
    run live. **Fixed:** the eval uses the real installer.
  - `minimum-review.eval.ts` keeps its own credential list, without the key. **Fixed:** the key
    was added there, and `docs/testing.md` loads `.env` for `eval decisions` alone.
  - The new boundary was not in `AGENTS.md`. **Fixed:** it is in boundary 4.
  - The rule let `operator-runtime.ts` import the fake. **Fixed:** the rule is split, and tested.
  - Without the key, the error did not say what to set. **Fixed:** `DecisionInstallation.unavailable`
    names the reason, as sandboxes do: `decision model "jev" is unavailable: OPENROUTER_API_KEY is
    not set`.
  - Aliases are hard-coded for one model. **No change:** the seam takes more providers and
    aliases, and a second model adds a block or an operator alias file.
  - `triageTicket` is exported with no importer. **No change:** it shows how a decision is shared,
    and examples export their helpers.
- Correctness and proof:
  - A key containing a line break was quoted back by the transport's error, retried three times,
    and written to the record, the artifact and `output.json`. **Fixed:** `installDecisions`
    refuses a key that is not one printable token, and the provider redacts the key from any
    error. Tested.
  - Missing `usage` was recorded as zero tokens, so the call was priced at $0. **Fixed:**
    `ProviderResponse.tokens` is optional, and unknown stays unknown. Tested.
  - A body cut off mid-read was not retried. **Fixed:** it is retried like a failed connection.
    Tested.
  - Spend reported with an error was dropped. **Fixed:** it is kept. Tested.
  - A 200 carrying `{ error }` was treated as permanent, and its message was lost. **Fixed:** it is
    classified by its code. Tested.
  - A choice answered as a score was reported as unanswered, and a score keyed past its levels was
    accepted. **Fixed:** both are rejected, with the reason. Tested.
  - A number, boolean or `null` state was sent and refused by Jev. **Fixed:** `DecisionSpec.state`
    is `string | JsonObject | JsonValue[]`, and it is checked before sending. Tested.
  - Missing proofs are now tested: a confident "no" on the yes-no, a flagged bug, and 402, 413, 500,
    503 and 524.

### Task 3

- Architecture and scope:
- Correctness and proof:

### Task 4

- Labelling and arithmetic:

## Readiness

- [x] Outcome and boundaries are concrete.
- [x] Relevant implementation, callers, and tests are mapped.
- [x] Evidence and research support the proposed design.
- [x] Expensive interface, record-format, and stage-gate decisions are settled (see Decisions).
- [x] Tasks are ordered, coherent, and independently verifiable.
- [x] Open questions are resolved or explicitly moved out of scope. Task 4's source of findings and
  the LLM baseline are left to Task 4's plan step, and they block nothing before it.

## Implementation notes

### Task 1

Built in the worktree `../worktrees/awf-story-006-typed-decisions`, branch
`story-006-typed-decisions`, from `56c47be`. Where it differs from the design above, and why:

- **No `DecisionSelection` and no `timeoutMs`.** `model` is an alias name only, and `deadline` is
  the one bound. The `{ provider, model }` form and a second timeout had no consumer (ADR 0001).
  The record keeps both `alias` and the `model` it resolved to.
- **Decisions are not in the agent ledger.** `RunDecisions` (`engine/src/decisions/directory.ts`)
  keeps them, as `RunSandboxes` keeps sandboxes. A decision is complete when it settles, while the
  ledger exists to read agents' session files once the run has ended. `run-usage.ts` is unchanged.
- **`DecisionRecord` is in `contract/workflow`, `SettledDecision` in `records`.** `decide` returns
  the record and `DecisionError` carries it, and `workflow/` never imports `records.ts`.
- **Decision figures are on `totals`, `byStage` and `byModel`, never `byAgent`.** A decision has no
  agent. A stage is its key's prefix, as an agent's is.
- **Priced by `snapshot`, else the requested model.** `RATES` has `typesafe/jev-1.13`.
- **Retries:** at most 3 requests, backing off 500 ms then 1 s, and only while the backoff ends
  before the deadline.
- **Cancellation:** a parallel scope's deadline cancels its calls, and closing the workflow
  cancels any call still in flight, which is then recorded `cancelled`. A provider that ignores
  its `AbortSignal` still can't hold a call past its end.
- **An answered call whose artifact can't be written is recorded `failed`.** Without the artifact,
  its answer can't be fitted again.
- `OperatorRuntimeInstallation.decisions` is optional and unset until Task 2 installs OpenRouter.

### Task 2

- **An example, at the operator's request:** `examples/triage/`. It routes support tickets with
  one decision each, and flags an answer below 0.9 as `unsure`. `tests/triage.test.ts` runs it
  offline, and the live eval runs it on Jev.
- **The eval runs the example** through `awf run` and the real operator runtime, not a bare call.
  It needs both subscription logins, as every eval does.
- **The provider keeps only distributions.** It keeps probabilities, the snapshot, tokens, cost and
  the request id. Jev's `choice`, `score` and `confidence` are dropped, and the directory derives
  the picks.
- **Retryable:** 429, any 5xx, and a connection that fails or breaks mid-body. A 200 carrying
  `{ error }` is classified by its code.
- **The key is read from the environment, else from `.env`.** `bunfig.toml` keeps Bun from loading
  `.env`, because its Claude token would change how agents log in, so `openRouterKey` reads that
  one name from the file itself. An eval that skips is shown as skipped: a skipped `decisions` was
  once read as a pass.
- **`installDecisions` always returns an installation.** Without a usable key it has no aliases,
  and `unavailable` says why.
- **The first accounting line of a run with no agents** reads `0 agents · 0s`, not a list of
  agent gaps that cannot apply.
- **Live**, 2026-09-26: `bun run eval decisions` passed, 4 tickets for $0.00007, all four routed as
  expected. `awf run examples/triage/workflow.ts` on two tickets flagged the ambiguous answers.

## Human review

- [x] Tasks 1 and 2 are complete, and story-level verification passes. Tasks 3 and 4 moved to
  [[011-compare-variants|decision-matching]].
- [x] Presented to the operator on 2026-09-26: the outcome, the decisions, both tasks' review
  findings and dispositions, and the live runs.
- [x] Approved on 2026-09-26: "looks good, merge, update ticket to done". The operator had run
  `awf run examples/triage/workflow.ts` and asked for two changes first, both made: an example, and
  a key read from `.env`.
- [x] Marked `done` and merged into `main`.

Verification at merge, rebased onto `main` with story 007: `bun run check` clean; `bun test` 806
pass, 2 skip, 0 fail; `bun run eval decisions` 1/1 passed live, and `bun awf run
examples/triage/workflow.ts` answered four tickets from Jev.
