---
title: Make live-evaluation disclosure explicit
summary: Name the local payload and external providers at the live-agent consent boundary.
type: story
status: todo
discovered_in: "001 Task 7 approval gate"
depends_on: []
---

# Make live-evaluation disclosure explicit

Why it matters: `AWF_LIVE_EVAL=1` proves deliberate spending, but its error only says that live
agents will start. It does not state which local content will leave the machine or identify the
provider destinations. That ambiguity blocked Story 001's approved evaluation before any agent was
launched. `bun run eval` now sets `AWF_LIVE_EVAL=1` itself (`scripts/eval.ts`): running the command
is the consent, and it names no payload or provider either.

Known context: there are fourteen live evals (`tests/*.eval.ts`), across claude, codex, pi and
cursor, sandboxes and the review judge. `minimum-review` sends only the disposable contents copied
from `examples/minimum-review/fixtures/review-target.ts`; it rejects metered credentials,
fingerprints the repository, retains private evidence, and does not retry. Other evals and general
workflows select different targets and providers, so a hard-coded confirmation string is not a
reusable interface.

Refinement must decide where a workflow declares its external disclosure and how the operator
renders and confirms it before runtime installation. The interface should describe payload scope
and destinations without exposing credentials or claiming that provider-side retention is under
AWF's control. Non-interactive automation needs an explicit, auditable acknowledgement mechanism.

Open questions:

- Is disclosure metadata part of an executable workflow descriptor or operator-owned runtime
  policy?
- What stable provider identity can be shown before aliases are resolved without moving runtime
  configuration into workflow code?
- Should acknowledgement bind to an exact target fingerprint so a changed payload requires new
  consent?
