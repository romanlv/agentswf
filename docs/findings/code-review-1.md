# Code review — the E1/E2 harness

Reviewed `wf-poc1/` core: `cli.ts`, `schema.ts`, `result-layer.ts`, `run-dir.ts`,
`return-method.ts`, `trial.ts`, `runner.ts`, `types.ts`, `backends/`. Roughly 1,700 lines of the
4,300; the `e1/` and `e2/` script directories are throwaway and were read but not reviewed line by
line.

Every defect below was reproduced before it was written down.

**All six are fixed.** Each fix was mutation-tested: the invariant was broken and the guarding test
watched to fail. 95 tests pass. One of the two new schema tests initially never ran at all —
`schema.test.ts` aliases bun's `describe` to `group` and imports a different `describe` from
`./schema`, so the block registered nothing and passed silently. Only the mutation pass caught it.

## Defects

### 1. The validator crashes on agent-controlled input

`schema.ts` looks properties up with `schema.properties[key]`, which reaches the prototype chain.
A value carrying a key named `toString` resolves to `Object.prototype.toString`, a truthy
non-schema, which `check` then switches on — no case matches, it returns `undefined`, and the
caller spreads it.

```
validate(objectSchema, JSON.parse('{"a":1,"toString":1}'))
  -> TypeError: Spread syntax requires ...iterable not be null or undefined
```

An agent can produce this by accident. It throws out of `acceptResult`, past the CLI's error
handling, so the agent sees a stack trace instead of the correction message the whole design rests
on. Same cause, quieter symptom: `key in record` for required properties is true for
`constructor`, `toString`, `valueOf` and friends, so a required property with one of those names
validates as present when it is absent — confirmed, returns no errors against `{}`.

Fix: `Object.hasOwn` in both places.

### 2. `wf result` silently corrupts string content

`cli.ts` does `rest.join(" ")` to reassemble arguments the shell split. For unquoted JSON that
turns runs of whitespace inside string literals into a single space, and the result is still valid
JSON, so it is accepted:

```
wf result {"msg": "a  b"}   ->  exit 0, stored value {"msg":"a b"}
```

The instructions do tell the agent to quote, but the rejoin is exactly what makes the unquoted path
succeed rather than fail. Silent wrong data is worse here than a rejection the agent can read and
fix.

Fix: take `rest[0]` and reject a second argument with "quote the JSON as one argument".

### 3. A second result overwrites the first, unremarked

`writeAccepted` writes `result.json` unconditionally. An agent that reports twice — plausible when
it is unsure — changes the answer, possibly after the engine has read it. Harmless in E2 because
collection happens right after the turn. Not harmless in an engine. Decide first-wins or last-wins
and enforce it; the attempt log already keeps both either way.

### 4. `appendLine` will lose records the moment E4 runs

`run-dir.ts` appends by reading the whole file and rewriting it. That is O(n²) across a run, and
two concurrent appends lose one. `runMatrix` is deliberately sequential so E2 is safe — but E4 is
the concurrency experiment, and this is where its data would go. Fix before E4, not after.

### 5. `nudgeFailed` does not measure what it says

`runner.ts` counts `settledAfterNudge === "unknown"` as a resume failure. `headless.ts` returns
`unknown` for a timeout, a nonzero exit, and a missing resume alike, so the three are conflated.
The column read 0 in E2 so nothing was misreported, but the metric would not survive a run where
it mattered.

### 6. Stale comment contradicting a measurement

`types.ts` says `transcript()` is "Null when the backend cannot read output — a pane, by design."
E2 refuted that: pane reads returned a short value 80 times out of 80. `pane.ts`'s own comment is
correctly hedged. Two files now disagree.

## What is right, and worth keeping

- **`absent` / `malformed` / `corrected` / `accepted` are four distinct states.** Most harnesses
  would have collapsed these into a boolean and measured nothing. The `corrected` state was added
  mid-experiment when the tally was caught merging in-turn fixes with clean delivery.
- **`acceptResult` is the single gate for all three channels**, and it never repairs a value. The
  rule the plan asks for is actually enforced in one place rather than restated in three.
- **`settledState` fails closed.** Anything Herdr reports that is not recognised is `unknown`,
  never `done` — the same rule `review-loop/liveness.ts` gives its reason for.
- **The negative control.** A 100% result is worthless without evidence the instrument can read
  zero, and that evidence exists.
- **`semantic.ts` is a real seam** — a type, a default, and no model call. Easy to fill, easy to
  ignore.

## Not defects, but decide before the engine

`headless.ts` falls back to a random `sessionHint` when a harness has `resumeTurn` but no
`readSessionId`. Unreachable today — all four harnesses have both — and a trap if a fifth is added.

`pane.ts` finds the JSON envelope by taking the first stdout line starting with `{`. Terminal text
read back through `agent read` could begin that way. Only `transcript()` is exposed to that, and it
uses raw stdout, so nothing is wrong today.
