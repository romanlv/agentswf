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
- [[runtime-effort]] — effort per agent and per turn, recorded. A published type change to
  `ExecutionConfig`: settle the values first.
- [[turn-liveness-and-limits]] — an agent waiting on its own background work is not done; limits by
  progress and cost. Lost implement-ticket's run one step from the end.

### P1

- [[stopped-run-recovery]] — a stop says how to go on, and can wait on a person; after story 018.
- [[run-logs-and-telemetry]] — `awf logs`, each agent's native session linked from the run dir.
- [[expired-login]] — stop and say which harness to log in again.
- [[agent-permission-mode]] — host claude runs in auto mode, a classifier on every command.
- [[readable-workflows]] — durations a person writes; the ticket workflow as its process.
- [[headless-orphans]] — a stopped headless turn's commands keep running (bug).
- [[run-through-sleep]] — keep the machine awake for a run; record time slept through.
- [[review-shapes-and-models]] — the research program once the loop is cheap.

### P2

- [[billing-provenance]], [[interrupted-accounting-read]] — what spend records claim.
- [[operator-settings]], [[operator-run-observation]], [[context-size]].
- [[herdr-pane-settlement]] — with start and non-answered diagnostics folded in.
- [[key-growth-from-runs]], [[jev-noise-audit]], [[second-case-kind]] — the lab's data and scorer.
- [[workflow-in-sandbox]], [[sandbox-host-protection]] — containment.
- [[split-large-modules]].

### P3

- [[npm-launch]], [[scrub-private-references]], [[node-runtime]], [[live-eval-disclosure]] — the
  launch.
- [[judge-opus-voter]], [[herdr-layout-policy]], [[workflow-test-generated-answers]],
  [[workflow-test-virtual-time]].
