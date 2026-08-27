# E5 — does the schema error get the agent to correct itself

Run 2026-08-23, macOS 25.5.0, one laptop, sequential. Herdr 0.8.0, session `wf-lab`, no `CLAUDE_*`
in the server's environment. Binaries: claude 2.1.241, codex 0.149.0, pi 0.84.2, cursor-agent
2026.08.11.

Script: `../../experiments/_archive/e5.ts`, report `../../experiments/_archive/e5/report.ts`. Raw rows: `../../experiments/_archive/e5/results/e5-shipped/`,
`../../experiments/_archive/e5/results/e5-terse/`, `../../experiments/_archive/e5/results/e5-schema/` — `trials.jsonl` plus one
`calls/<id>/attempts.jsonl` per trial holding every value the agent offered and why it was
refused. Tables regenerate with `bun run e5/report.ts e5/results/e5-shipped e5/results/e5-terse
e5/results/e5-schema`.

320 trials. Return method `cli-callback` throughout — the only one of the three that can refuse.

## Verdict

**The correction loop works, completely, and it should almost never run.**

- 240 of 240 refused turns fixed themselves inside the same turn. Nothing looped, nothing was
  lost, the engine never re-prompted, and the nudge never fired.
- 0 of 240 first attempts were valid, because the instructions the engine actually sends describe
  the *shape* of the value and none of its *constraints*. `describe()` renders
  `confidence: integer`; the schema says `1..5`. Every agent guessed a percentage.
- Pasting the JSON Schema into the prompt moves first-attempt validity from **0% to 100%**, on all
  four harnesses, 80 for 80, and makes the turn faster and cheaper than the corrected one.
- Taking the error text away does **not** change whether the agent recovers — it changes what
  recovery costs: 2 attempts becomes up to 11, and claude's turn goes from $0.115 to $0.346.

## The schema

Nested object, two enums, a `minItems` array, a bounded integer, two `minLength` strings,
`additionalProperties: false` at both levels. The task is a four-line JavaScript function with an
off-by-one and an uninitialised accumulator.

```json
{ "verdict": {"enum": ["approve","revise","reject"]},
  "confidence": {"type": "integer", "minimum": 1, "maximum": 5},
  "findings": {"type": "array", "minItems": 2,
               "items": {"severity": {"enum":["low","medium","high"]},
                         "note": {"type":"string","minLength":10}}},
  "summary": {"type": "string", "minLength": 20} }
```

## Arm 1 — the instructions as shipped

`return-method.ts` sends `describe(schema)`, which is what an engine step would send today.
20 trials per harness per backend.

| harness | backend | n | valid 1st | corrected in-turn | still bad | never tried | attempts to accept | delivered |
|---|---|---|---|---|---|---|---|---|
| claude | pane | 20 | 0 (0%) | 20 | 0 | 0 | 2.00, max 2 | 20/20 |
| claude | headless | 20 | 0 (0%) | 20 | 0 | 0 | 2.00, max 2 | 20/20 |
| codex | pane | 20 | 0 (0%) | 20 | 0 | 0 | 2.00, max 2 | 20/20 |
| codex | headless | 20 | 0 (0%) | 20 | 0 | 0 | 2.00, max 2 | 20/20 |
| pi | pane | 20 | 0 (0%) | 20 | 0 | 0 | 2.00, max 2 | 20/20 |
| pi | headless | 20 | 0 (0%) | 20 | 0 | 0 | 2.00, max 2 | 20/20 |
| cursor | pane | 20 | 0 (0%) | 20 | 0 | 0 | 2.00, max 2 | 20/20 |
| cursor | headless | 20 | 0 (0%) | 20 | 0 | 0 | 2.00, max 2 | 20/20 |

**Exactly two attempts, 160 times out of 160.** Not a mean of two — every single trial was refused
once and accepted on the retry. No trial needed a nudge, none was lost, none errored, and the
backend made no difference at all: pane and headless are identical to the trial.

What the refusal was:

| first rejection | count |
|---|---|
| `value.confidence: expected at most 5; got 95` (or 100, 99, 92, 90) | 159 |
| `the value is not valid JSON: Expected '}'` | 1 |

Nothing else. `minItems`, `minLength`, both enums and `additionalProperties` were satisfied on the
first try in all 160 trials. The one JSON failure was a pane claude value truncated at 925
characters mid-object; it too was fixed on the retry.

First-turn wall clock, the whole refuse-and-fix cycle included: pi 13.4 s pane / 14.9 s headless,
cursor 15.7 / 16.0, codex 15.5 / 18.3, claude 23.6 / 24.7. Mean dollars where reported:
claude headless $0.1151, pi headless $0.0092.

### The 0% is the instrument, not the model

`describe()` renders `{ verdict: one of "approve", "revise", "reject", confidence: integer,
findings: array of { severity: …, note: string }, summary: string }`. It drops `minimum`,
`maximum`, `minItems`, `minLength` and `additionalProperties` — every constraint the validator
will actually enforce. The agent is told the shape and judged on the bounds.

Every first attempt picked a percentage: 100 seventy-seven times, 95 seventy times, then 90, 99,
92. That is not a model getting a fiddly schema wrong. That is four different models all reading
"confidence: integer" the same reasonable way.

## Arm 3 — the same thing with the schema in the prompt

Same task, same validator, same `wf`; the prompt carries the JSON Schema verbatim as well.
Headless only, 20 per harness.

| harness | n | valid 1st | attempts | mean first turn | claude $ |
|---|---|---|---|---|---|
| claude | 20 | **20 (100%)** | 1.00 | 15.1 s | $0.0875 |
| codex | 20 | **20 (100%)** | 1.00 | 12.7 s | — |
| pi | 20 | **20 (100%)** | 1.00 | 10.9 s | $0.0094 |
| cursor | 20 | **20 (100%)** | 1.00 | 12.5 s | — |

80 for 80, first try, every harness. Every one of them put `confidence: 5`. The turn is 25–40%
faster than the corrected turn in arm 1 and claude's dollars drop 24%.

**So the correction loop in arm 1 is entirely avoidable, and avoiding it is strictly cheaper.**
The engine already holds the schema — `run-dir.ts` writes it into `call.json`. It just does not
send it.

## Arm 2 — the deliberately worse error message

`e5/bin-terse/wf` runs the same acceptance path — same `acceptResult`, same schema, same attempt
log — and prints `wf: result rejected.` instead of the per-field message. Nothing else changes;
the prompt still tells the agent that a nonzero exit means retry, so intent-to-retry is held
constant and only the diagnostic content differs. Headless only, 20 per harness.

| harness | valid 1st | corrected | attempts, mean | attempts, max | total attempts (20 trials) | mean first turn | claude $ |
|---|---|---|---|---|---|---|---|
| claude | 0 (0%) | 20/20 | **3.25** | **11** | 65 | 64.2 s | **$0.3462** |
| codex | 0 (0%) | 20/20 | **4.95** | 8 | 99 | 48.8 s | — |
| pi | 0 (0%) | 20/20 | **4.85** | 8 | 97 | 34.1 s | $0.0099 |
| cursor | 0 (0%) | 20/20 | **2.90** | 3 | 58 | 26.8 s | — |

Against arm 1's 2.00 / max 2 / 40 total on every cell.

**The correction rate does not move. Everything else does.**

- Attempts per trial: 2.00 → 2.90–4.95, and one claude trial took eleven.
- claude's first turn: 24.7 s → 64.2 s, and $0.1151 → $0.3462. **A bad error message costs 3x.**
- The *answer changes*. With the message, all 160 corrected values landed on `confidence: 5`.
  Without it, 27 of 80 landed on `1` — the blind descent overshot the bound and stopped at the
  other end.

Blind, the agents binary-search the number they cannot see:

```
codex  100 → 100 → 95 → 100 → 99 → 90 → 100 → 5      (8 attempts)
pi     100 → 100 → 99 → 100 → 10 → 1                 (6 attempts)
cursor  95 → unparseable → 5                         (3 attempts, every trial)
```

cursor's second attempt was non-JSON in 18 of 20 trials — the same object-literal habit E2 found —
and then it converged.

### The one that came closest to looping

claude headless, terse arm, trial 6. Eleven attempts, and the damage spread well past the field
that was wrong:

| # | confidence | findings | what was actually wrong (from the log, not shown to the agent) |
|---|---|---|---|
| 1 | 95 | 4 | `confidence: expected at most 5` |
| 2 | — | — | not valid JSON |
| 3 | 95 | 0 | `confidence: expected at most 5` |
| 4 | 50 | 1 | `confidence: expected at most 5` |
| 5 | 5 | 1 | `findings: expected at least 2 items; got 1` |
| 6 | 0.9 | 1 | `confidence: expected an integer` |
| 7 | — | 0 | `verdict: required property is missing` |
| 8 | 50 | 1 | `confidence: expected at most 5` |
| 9 | — | — | not valid JSON |
| 10 | 50 | 0 | `verdict: expected one of …` |
| 11 | 5 | 4 | accepted |

It got `confidence` right at attempt 5 and then broke it again, because it had no way to know
which of its edits helped. **A refusal that does not say what was wrong turns one wrong field into
a search over the whole value.**

## Turns that did not converge

**None.** 240 refused turns across three arms, every one accepted inside the same turn. No trial
was nudged, none was lost, none errored, none hit the 240 s timeout, and every turn settled
`idle` (pane) or `done` (headless).

That is a stronger result than the design needs and it comes with two caveats. Nothing bounds the
number of attempts — the eleven-attempt trial stopped when the agent chose to, not when anything
told it to. And this is one schema whose violations were nearly all one field; a value wrong in
four places at once is untested.

## What this settles, and what it warns about

1. **Abstraction 4 holds.** The agent reads the failure on its own terminal, inside the turn, and
   fixes it. 240 for 240, four harnesses, both backends, no engine involvement.
2. **The pane/headless choice is irrelevant here.** Arm 1's pane and headless columns are
   identical to the trial. Whatever picks the backend, it is not self-correction.
3. **Send the schema, not a rendering of it.** 0% → 100% first-attempt validity, faster and
   cheaper. `describe()` is fine for a human reading a prompt and wrong as the only statement of
   what will be enforced. Either widen `describe()` to carry the constraints, or append the schema
   itself — the engine already has it in `call.json`.
4. **Keep the per-field message even after doing that.** It is what makes the residual failures
   cost 2 attempts instead of 11, and it is the difference between a value that converges to the
   right answer and one that ends up at the other end of the range.
5. **The error text steers the value, not just its shape.** Every corrected `confidence` went to a
   boundary — 5 with a useful message, 1 or 5 without. A model that is told "expected at most 5"
   answers 5; it does not re-estimate its confidence on the new scale. If a field's *value* matters
   and not only its validity, a rejection is not a neutral event.

## Where this contradicts E2 and the plan

Nothing contradicted. Two gaps closed:

- E2 recorded `fixed-1st: 0` across its whole matrix and said the `corrected` state was "proven
  only by unit test, not by a live case. E5 will produce them." It produced 240.
- E2's four cursor `delimited-line` failures were object literals recovered by a nudge. Here the
  same habit shows up on `cli-callback` — 18 of 20 terse cursor trials had an unparseable second
  attempt — and `wf`'s JSON parse error recovered every one inside the turn, with no nudge. The
  return channel that can refuse is worth more than the two that cannot, which is what E2 already
  concluded on other grounds.

## What this did not measure

- **A value wrong in several places at once.** 159 of 160 first rejections named one field. The
  eleven-attempt trial is the only evidence about multi-error correction and it is one sample.
- **An attempt cap.** Nothing stops an agent retrying; an engine would need one, and E5 says
  nothing about where to put it.
- **A schema whose constraints are semantic rather than structural.** `semantic.ts` was
  `acceptAny` throughout, so nothing here tests a rejection the agent cannot fix by editing JSON.
- **Whether 100% first-attempt validity survives a harder schema.** Arm 3's schema is the same
  one arm 1 failed on; a longer or more ambiguous one is untested.
- **codex and cursor dollars.** No figure exists, as E1 and E3 both found. The terse arm's 3x cost
  is claude's number; codex and pi's attempt counts rose further than claude's, so their cost
  multiple is probably larger, and it is not measurable.
