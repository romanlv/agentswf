---
title: Measure and classify Herdr pane settlement
summary: Make interactive prompt delivery and native completion observable without unsafe retries.
type: story
status: todo
discovered_in: "001 post-review live evidence"
depends_on: []
---

# Measure and classify Herdr pane settlement

Why it matters: the pane path now runs reliably, but it still cannot tell an undelivered prompt
from a delivered prompt whose pane state has not moved, and no provider reports turn-scoped
completion. Story 001 removed the one cause it could identify and left the ambiguity itself
standing, so the host's response to it is to spend the whole operation deadline waiting.

What Story 001 settled, and what it left here: Task 4 removed every place an ambiguous Herdr
observation decided something. `agent_prompt_stalled` no longer settles or resends, and lifecycle
state authorizes no continuation — the production host simply refuses a second operation on an
agent. This todo owns the measurement that would let the capability come back.

Evidence: the two earlier run roots under `/var/folders/.../T/awf-minimum-review-Du89Pi` and
`-msrKbu` were temporary and have since been purged. Story 001 re-measured on 2026-09-18 rather
than citing them, and its Task 7 section is the current record. The stall those runs saw is real
and reproduced: Herdr answered `agent_prompt_stalled` with `status is idle and state_change_seq
remained <n>`, which is the same shape `msrKbu` showed.

Story 001's Task 4 carries the upstream citations: Herdr's wait tracks lifecycle state rather than
an individual turn, and lifecycle classification comes from screen manifests even where Claude and
Codex report native session identity. What matters here is the consequence — output matching,
revision changes and quiet windows are diagnostics, not settlement authority.

Three things Story 001 deliberately did not build, each because it is a measurement problem:

- **Verified pane release.** A close acknowledgement is not proof the agent process is gone. A first
  attempt followed `pane close` with `pane get` and required the code `pane_not_found` — the code is
  real in Herdr 0.8.2, but with no release grace, no retry, and `herdr()` preferring stderr over the
  stdout envelope, a single warning line wedged the pane permanently and made a fully cleaned run
  report a cleanup failure. It needs a bounded poll, a disposition rather than a throw, and
  consumption only where it authorizes something.
- **A concurrent identity observer.** Session identity should be observed and cached while the
  operation runs, independently of lifecycle state, so that continuation rests on identity plus
  verified release rather than on `idle`. Note that on the accepted-result path the engine releases
  by cancelling, which aborts the prompt command before any identity is read — so an observer is
  the only way this evidence ever exists.
- **Pane continuation itself**, which depends on both of the above.

`agent_prompt_stalled` and the exact short-timeout prompt-observation response remain nonterminal.
Story 001 classifies only `agent_prompt_stalled`, because `timeout` is also what a pre-submission
daemon failure returns; separating them needs the full response shape, not the code alone.

Story 001's live runs found and removed its dominant cause: an agent that has just dismissed its
startup trust block reports `interactive_ready` about 200 ms before its terminal UI accepts input,
and a prompt submitted into that window is lost. With two seconds of settling it did not recur.
Two variants were observed and they need different repairs, which is why neither shipped. In one
the text is composed in the pane but unsent, and a single submit keystroke recovers the turn; that
keystroke was written and reverted, because in the other variant the text is discarded outright and
only a resend would help. Herdr's message distinguishes them at the source —
it reports the status and whether `state_change_seq` moved — but this host cannot act on that
until it can tell a non-delivery from a turn that is simply still quiet. That is the same
measurement as verified release.

One bounded pane observation would buy two of these at once. On a stalled prompt the host now waits
out the operation deadline without looking at the pane, so it sees neither a decisive native failure
— a wedged or dead agent costs the whole deadline and reports a bare timeout — nor any usage, and
this is the host's longest and most expensive turn. A single `agent read --source detection` before
returning yields `spec.readUsage` and a diagnostic from one command.

Story 001's live runs all reported `usageSamples: 0`: every turn settled correctly and none
reported a token, so a run cannot bound its own spend. The pane path reads usage nowhere, and this
observation is the only place it could.

Also here because it is the same area: `host.close` sets `topologyOpen = false` only after awaiting
the session close, so a concurrent `execute` can still split a pane that the imminent
`workspace close` then orphans. Pre-existing and narrow, but it belongs with release evidence.

Two constraints on whatever lands here: do not add a retry until delivery is provably absent, and
do not promote a heuristic to author-facing semantics without an explicit design decision.
