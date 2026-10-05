---
title: Stop governed work at an observed spend threshold
type: story
status: todo
priority: P1
epic: long-runs
discovered_in: "021 turn liveness design review, 2026-10-04"
depends_on: ["021"]
---

# Stop governed work at an observed spend threshold

Let an operator stop a run when its observed spend reaches a chosen threshold. Admit this policy
only where the live reader covers the work being governed. Delayed usage and in-flight requests
can overshoot the threshold; it is not a promise of an exact bill ceiling.

Split from [[021-turn-liveness-and-limits]] so incomplete live accounting does not delay fixing
premature operation completion. The [[turn-liveness-and-limits|source research]]
explains provider-specific gaps: cumulative resumed-session totals, partial token fields, child
usage, and telemetry delay. Current finished-run readers do not prove live coverage.

## Proposed ownership and behavior

- Harness extracts native usage with freshness, completeness and stable request identities.
  `SessionAccounting.read` currently requires a closed host; introduce a live lifecycle while
  sharing parsing. Do not repeatedly call the final reader and label it live.
- Engine owns one shared ledger, admission and cancellation. Concurrent agents draw from the same
  balance; each does not receive a separate copy of the remaining budget.
- `engine/src/accounting` stays pure and prices observations against a rate card pinned for the run.
  Choose provider-reported metered USD or estimated list-price USD explicitly. Subscription value
  and money charged remain distinct; missing prices and usage are unknown, never zero.
- Include agent requests, nudges, decisions and delegated work. Refuse requested enforcement before
  dispatch if the selected harness/placement cannot supply the required coverage. During a source
  outage, stop new admission and recover within a bound, then cancel if coverage stays unavailable.
- Crossing the threshold closes new admission and cancels active governed work, including child
  scopes, using 021's stop/release path. Continue bounded accounting through cleanup; report late
  charges and the final known total without backdating the stop.

## Attribution is a prerequisite

`packages/engine/src/run-usage.ts::share` currently assigns requests by the next operation's delivery
time. That can give a late request from operation A to operation B. Deduplication alone does not
fix ownership. Establish originating operation/request identity and make final and live accounting
agree. If ownership cannot be established, mark the affected breakdown incomplete; do not guess.

Cover copied fork history, resumed sessions, counter resets, model changes, partial updates,
subagent costs and caller hand-back. An agent being idle does not prove no request is still billed.

## Proof and open decisions

Before publishing options or record fields:

1. Compare live usage with final accounting on fixtures and bounded probes, including child agents.
   Record precisely which combinations support which basis; do not invent complete coverage.
2. Demonstrate one shared threshold with concurrent agents, decisions and late usage. Record the
   detection delay, cancellation delay and overshoot rather than asserting an exact cap.
3. Decide whether a continued run's threshold covers one attempt or all attempts. Stage thresholds
   require [[018-workflow-stages]] and attribution to the originating stage, including late charges.
4. Define records for basis, rate card, freshness, threshold, observed spend at stop and final spend.
   Reuse existing accounting formats where possible; settle compatibility explicitly.

An accepted answer remains evidence if a budget stops its scope. Stop ordering, safe release and
which work may be admitted afterward must agree with story 021. Native/provider-side reservations
would be needed for a stronger financial guarantee; they are outside this proposal.
