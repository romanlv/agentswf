---
title: Measure and classify Herdr pane settlement
summary: Make interactive prompt delivery and native completion observable without unsafe retries.
type: story
status: todo
discovered_in: "001 post-review live evidence"
depends_on: []
---

# Measure and classify Herdr pane settlement

Why it matters: the pane path completed normally in one post-trust-fix live run, accepted both
results while one native turn stayed non-terminal in another, and later returned
`agent_prompt_stalled` for Claude while Codex reached its turn deadline. The engine correctly fails
closed, but operators cannot distinguish an undelivered prompt from a delivered prompt whose pane
state did not change.

Immediate Story 001 constraint: the current symmetric run host maps Herdr `idle` to completed and
permits continuation when a session reference is present. That is not justified by this evidence.
Story 001 Task 4 must fail closed on ambiguous `idle` before its bounded live proof. This todo owns
the broader provider measurement and classification work after that minimum safety correction.

Evidence: inspect the retained Story 001 roots
`/var/folders/4g/s95glx9x6n71bq4hc08ly2gm0000gn/T/awf-minimum-review-Du89Pi` and
`/var/folders/4g/s95glx9x6n71bq4hc08ly2gm0000gn/T/awf-minimum-review-msrKbu` while available, plus
the frozen E1, E3, and E7 findings. In `Du89Pi`, both results were accepted by +140.024 s but Claude
never reported native completion before the +300 s deadline. In `msrKbu`, Claude stayed idle with
an unchanged state sequence and Herdr returned `agent_prompt_stalled`; retrying the same operation
could duplicate an ambiguously delivered prompt.

Refinement must decide how to measure prompt delivery and terminal state independently, retain safe
native diagnostics, and whether accepted result settlement should end or detach the native turn.
Do not add a retry until delivery is provably absent, and do not change the author-facing turn
semantics without an explicit design decision.
