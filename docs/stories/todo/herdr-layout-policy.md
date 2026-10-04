---
title: Control how workflow agents are displayed in Herdr
type: story
status: todo
priority: P3
epic: observability
discovered_in: "001 Task 7 user review"
depends_on: []
---

# Control how workflow agents are displayed in Herdr

Add a small presentation policy for grouping workflow agents into Herdr tabs and panes.

Why it matters: the production host currently chooses one workspace and gives every agent a tab
of its own. Sibling panes in one tab came first and stopped being readable at five agents, because
each split halved the root. A tab per agent reads well but still hard-codes one arrangement. Larger workflows will need readable grouping
without teaching workflow definitions or the engine Herdr commands, pane identifiers, or topology
bookkeeping.

Known context: `createHerdrRunHostFactory` in
`packages/harness/src/adapters/herdr.ts` owns workspace, tab, and pane I/O. `AgentRunHostFactory`
is intentionally provider- and topology-neutral. Each agent reaches the engine over a socket of its
own, through a launcher whose path is named in that agent's prompt rather than placed in any pane's
environment; changing presentation must preserve that binding, lifecycle, inspection, continuation,
and whole-run cleanup behavior.

Likely seam: an operator-owned presentation policy supplied to the Herdr host. Its interface should
describe intent such as grouping, labels, split direction, and relative size. The adapter should
translate that intent into concrete Herdr operations and keep native identifiers private. Workflow
authors should not choose raw workspace, tab, or pane IDs.

Refinement must compare at least two real layouts before adding an interface—for example, all peers
as a tab per agent versus role groups sharing a tab. Keep the module deep: callers
choose a small policy while the implementation owns admission order, deterministic placement,
concurrent topology changes, focus behavior, socket and launcher lifetime, reflow limits, and
cleanup.

Open questions:

- Is layout purely operator configuration, or is there a portable workflow hint worth adding to
  the author surface? Prefer operator ownership unless a non-Herdr adapter demonstrates the same
  need.
- Is static placement at agent activation sufficient, or must the policy support later movement and
  resizing? Do not expose dynamic topology until a concrete workflow requires it.
- How should more agents than comfortably fit in one tab be grouped without making scheduling order
  visible as product semantics?

This todo is not part of Story 001 acceptance.
