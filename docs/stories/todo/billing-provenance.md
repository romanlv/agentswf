---
title: Record whether billing was observed or assumed, and settle headless claude's
type: story
status: todo
priority: P2
epic: observability
discovered_in: "story 008, the trial"
depends_on: ["002"]
---

# Record whether billing was observed or assumed, and settle headless claude's

output.json says a headless claude agent was "metered" and "charged" by a harness rule and claude's
own printed cost, and readers take that for a bill.

Why it matters: after story 008's trial the operator was told about $40 had been charged. It had
not been shown: no `ANTHROPIC_API_KEY` was set, and the runs used a subscription login. The
record's words carried the claim:

- `billing: "metered"` for every headless claude agent comes from a rule, `meteredHeadless: true`
  in `packages/harness/src/spec.ts`, applied in `packages/harness/src/usage/accounting.ts`, not
  from a login or key check.
- `charged` is then claude's own printed `total_cost_usd`, which claude prints on a subscription
  too (`packages/engine/src/run-usage.ts`: a charge is kept wherever billing is `metered`).
- So `awf run`'s accounting line and `awf-lab`'s report say "charged" for an assumption, and the
  trial's "claude charged above its list price" was the printed cost against awf's price table,
  not a bill.

It is not the first time a reader has taken these fields for observed spend.

Two parts:

1. **Provenance in the record.** `Billing` gains how it was decided: `observed` (a login check,
   an API key in the environment, a provider's report) or `assumed` (a harness rule). `charged` is
   recorded only for observed metered billing; a self-reported figure is kept under its own name,
   such as `reportedCost`. The accounting line and `awf-lab`'s report print "charged" only for
   observed billing, and list-price estimates as estimates. `OutputRecord` is a published format:
   bump its version, and change `awf.review-findings/1` and `awf.review-score/1`'s run summary
   with it (story 008 keeps `charged` there today).

   **Done, 2026-11-06, before 0.1.0:** the rename. `charged` is `reportedCost` wherever awf
   records or sums it (`spend.json`, `SettledOperation`, `SettledDecision`, `AccountingFigures`,
   `DecisionFigures`), `out.json` is version 6, and `awf run`'s line prints `$0.42 reported`. Each
   JSON file in `ops/{key}.{n}/` now carries a `version` (1), and a reader refuses a file without
   it, or with another: its usage, or the run's cost, reads as unknown. **Remains:** provenance
   itself, `observed` or `assumed` on `Billing`, and a `charged` kept only for observed metered
   billing; and `awf-lab`'s
   run summary, which still keeps the figure as `charged`: its formats are already at
   `awf.review-findings/2`, `awf.review-score/2` and `awf.review-partial/2`, read beside `/1`,
   so renaming it is a `/3` with a third reading, left for the operator to decide.
2. **The rule itself.** `meteredHeadless` rests on E3 and story 002 ("`claude -p` bills per token
   even on a subscription login", untried live then, as the account had no API credit); story 004
   left the setup-token case open "until the account's usage shows otherwise". Measure it: one
   headless claude turn on a subscription login, compared with the account's usage page before and
   after. If it is covered by the plan, drop `meteredHeadless`, the `metered: true` consent it
   forces on workflows and on `format/runtime.ts`, and correct the claims in `docs/testing.md`,
   `docs/foundation.md` §4, `examples/quick-check` and `examples/single-agent-review`.

Evidence since (story 022, 2026-10-05): one headless `claude -p` turn on a subscription login
printed a `rate_limit_event` with `isUsingOverage: false` and moved the plan's five-hour and
seven-day windows, and `claude -p /usage` says "You are currently using your subscription to power
your Claude Code usage". Both point to headless claude drawing on the plan. `awf allowance claude`
before and after a turn is now the measurement part 2 asks for.

Until then, spend is reported as list-price estimates, and headless claude's billing as
unverified.
