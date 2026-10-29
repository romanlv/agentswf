---
title: Todo
type: guide
status: active
---

# Todo

This directory is the inbox for possible stories discovered while refining or implementing another
story. Todo items are not approved scope and are not ready for implementation.

Use a descriptive filename; numbering is assigned only when an item is promoted to a refined story.
A todo needs only:

```md
---
title: <Short title>
type: story
status: todo
priority: <P0 | P1 | P2 | P3>
epic: <one of the epics below>
discovered_in: <story id, code path, test, or investigation>
depends_on: []
---

# <Short title>

<One sentence describing the work>

Why it matters: <failure, opportunity, or unresolved constraint>

Notes: <known evidence, likely area, and dependencies>
```

Frontmatter holds only short datapoints an Obsidian base can show as columns; prose, the summary
included, goes in the body.

A todo holds only work that remains. When a story takes it up, or another todo covers it, fold
what is still useful into that one and delete the file; git keeps the rest.

Prefer one concrete concern per file. Link the new todo from the originating story's implementation
notes, then continue the original scope.

## Epics

What a todo belongs to, one per file:

- **loop** — the autoresearch loop and the lab: proposer, comparison, scorer, datasets.
- **long-runs** — a long run of the operator's own workflows finishing, or stopping recoverably.
- **observability** — seeing what a run does and did: logs, progress, context, spend records.
- **agent-config** — what an agent runs with: effort, permissions, operator settings.
- **authoring** — writing and testing a workflow.
- **sandbox** — containing agents and workflows.
- **launch** — going public: npm, Node, private references, disclosure.
- **codebase** — the repository's own shape.

## Priorities

- **P0** — blocks running the autoresearch loop again, or the operator's own workflows.
- **P1** — next: what the operator's own workflows hit, or the loop's next research.
- **P2** — real, not urgent; mostly waits on something above.
- **P3** — for the public launch, or nice to have.

`_list.base` shows the same in Obsidian, sorted by priority. Set 2026-10-04 from the first live
loop's report (data repository, `reports/2026-10-01-first-live-loop.md`) and the implement-ticket
live runs.

### P0

- [[loop-next]] — the loop's own gaps from its first run: a proposer that thinks, spend a cut
  can't hide, a loop that outlives its shell, a scorer checked before spending.
- [[comparison-efficiency]] — a try that's no better stops at 8 cases, cases up to a look run in
  parallel, a resolution at 1 trial. The report's "3 hours and $24 for one try".
- [[020-agent-effort]] — now story 020, ready: an agent opens at an effort, and `set` switches
  its model or effort mid-run, recorded. Its contract is settled.
- [[021-turn-liveness-and-limits]] — now story 021, done: cooperative waiting and
  repeated check-ins within one deadline. Financial ceilings remain in [[live-spend-limits]].

### P1

- [[live-spend-limits]] — observed-spend enforcement after live coverage and attribution are proved;
  split from story 021 so accounting does not delay liveness.

- [[stopped-run-recovery]] — a stop says how to go on, and can wait on a person; after story 018.
- [[032-run-coordinator]] — now story 032, ready: an app outside awf, the coordinator, talks with
  a run's agents over messaging routes; a Slack app is one such coordinator, outside this repository.
- [[028-run-logs-and-telemetry]] — now story 028, awaiting human review: an agent reads a run with `awf runs` and `awf logs`; `operator-run-observation` folded in.
- [[agent-permission-mode]] — host claude runs in auto mode, a classifier on every command.
- [[readable-workflows]] — durations a person writes; the ticket workflow as its process.
- [[run-through-sleep]] — keep the machine awake for a run; record time slept through.
- [[review-shapes-and-models]] — the research program once the loop is cheap.
- [[crash-leftovers-reaper]] — a later awf ends the agents, sandboxes and control-plane
  directories a dead one left, from records each owner writes as it launches.
- [[woken-run-bounds]] — a woken run gets a deadline, and `awf tick` reaps an ended attempt still
  alive; one reading of liveness when `ps` can't answer.

### P2

- [[billing-provenance]], [[interrupted-accounting-read]] — what spend records claim.
- [[operator-settings]], [[context-size]].
- [[herdr-pane-settlement]] — with start and non-answered diagnostics folded in.
- [[mid-turn-messages]] — a message folded into a running claude turn; after story 029.
- [[key-growth-from-runs]], [[jev-noise-audit]], [[second-case-kind]] — the lab's data and scorer.
- [[workflow-in-sandbox]], [[sandbox-host-protection]] — containment.
- [[sandbox-setsid-escape]] — what leaves a sandbox's process group is ended with it.
- [[split-large-modules]].

### P3

- [[agent-release]] — release one agent's pane while its run stays live; after story 036.
- [[npm-launch]], [[scrub-private-references]], [[node-runtime]], [[live-eval-disclosure]] — the
  launch.
- [[judge-opus-voter]], [[workflow-test-generated-answers]],
  [[workflow-test-virtual-time]].
- [[test-host-teardown]] — a failing test still closes its Herdr hosts.
