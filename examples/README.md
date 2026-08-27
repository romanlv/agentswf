# Examples

Scenario workflows written against the author surface — `@wf/contract/workflow` — and nothing
else. They do not run yet: they exist to typecheck, and a change to the author surface that
makes one of them worse is a bad change.

| File | Shape |
| --- | --- |
| `review-loop.ts` | MR review, a findings ledger, publication to GitLab |
| `catalogue-review.ts` | fan-out over domain lenses, per-finding verification |
| `feature-delivery.ts` | plan, implement, review, revise until clean |

All three describe things that run today as ad-hoc scripts and skills; see
`docs/foundation.md` §7.

The import boundary is checked: `bun run scripts/check-boundaries.ts` fails if a workflow
reaches for the engine or a harness.
