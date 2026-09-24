---
title: Put the schema in the prompt, not a rendering of it
summary: The runner prompts through describe(), which drops every constraint the validator enforces — the arm E5 measured at 0% first-attempt validity.
type: story
status: done
discovered_in: "docs/findings/README.md (E5), packages/engine/src/workflow-runner.ts"
depends_on: []
---

> Done 2026-09-24, during story 002's human review. The operation prompt carries the schema
> itself, and shows the value in a quoted heredoc, since a quoted argument broke on shell quoting.
> `wf`'s rejection text mentions `< file` for a long value. Measured on headless codex: 20/20 valid
> first answers, no broken commands (story 002, human review). Of the open questions below,
> the rendering question is moot: `describe()` no longer reaches the agent, and the contract keeps
> it for error text only.

# Put the schema in the prompt, not a rendering of it

Why it matters: E5 measured first-attempt validity at 0/160 when the agent saw only a rendered shape
and 80/80 when it saw the schema itself. `packages/engine/src/workflow-runner.ts` builds every
operation prompt from `describe()`, and `describe()` in `packages/contract/src/schema.ts` renders the
shape while dropping `minimum`, `maximum`, `minItems`, `minLength` and `additionalProperties` —
every one of which the validator does enforce. The engine therefore reproduces the measured failing
arm on its default path: each operation is expected to fail validation once and self-correct, paying
an extra turn for a constraint it was never shown.

The correction loop is not the mitigation. E5 also settled that the loop works (240/240) and that the
per-field error text is what keeps it cheap. Both remain worth having. The point is that the prompt
should not need them for a constraint the schema already states.

Known context: E5 named two fixes — widen `describe()` to render the constraints, or append the
schema to the prompt alongside the shape. Neither was taken. No test asserts that a constrained
schema reaches the agent, which is why the gap survived the Stage 0 move and Story 001's reviews.

Refinement must decide which of the two fixes belongs in the contract and which in the engine:
`describe()` is contract-owned and its output is also the error-text vocabulary, so widening it
changes both. Appending the schema is engine-owned prompt policy and leaves the contract alone, at
the cost of prompt size — E1 found no truncation at 15KB on either backend, so size is measured, not
assumed.

Open questions:

- Does the agent-facing rendering belong to the contract at all, given the engine owns prompt
  construction?
- Should a schema carrying constraints that `describe()` cannot render be a type-level or test-level
  error rather than a silent downgrade?
