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

The aim, set 2026-11-02: someone can use agents.wf seriously and get value from it, as
[agents.wf](https://agents.wf) promises: runs that are durable, where a crash costs only the stage
that was running; an engine that handles an agent that goes quiet or hangs; a run that parks with
no process left. The autoresearch loop is a long-term bet, and security edge cases wait.

- **P0** — stands in the way of serious use: a run that can't be recovered or understood, what it
  leaves running, an author surface that will change under its users.
- **P1** — next: what a serious user hits soon after.
- **P2** — real, not urgent; mostly waits on something above.
- **P3** — the loop's research, the rest of the launch, or nice to have.

`_list.base` shows the same in Obsidian, sorted by priority. Reset 2026-11-02, from the
2026-10-04 list.

### P0

- [[stopped-run-recovery]] — a stop says where and how to go on, and can keep its agent open
  for a person to finish the step.
- [[non-answered-evidence]] — a turn that didn't answer keeps its screen, so a misread `blocked`
  can be told apart.
- [[crash-leftovers-reaper]] — a later awf ends the agents, sandboxes and control-plane
  directories a dead one left. A record format: designed first.
- [[039-one-way-author-api|039]] — one way to do each thing in the author API, now a numbered
  story, before more people build on the beta.

### P1

- [[concurrent-agents]] — a dozen agents at once stay reliable: E4 measured, a turn read from its
  harness's records, a limit if the numbers call for one.
- [[woken-run-bounds]] — a woken run gets a deadline, and `awf tick` reaps an ended attempt still
  alive; one reading of liveness when `ps` can't answer.
- [[agent-own-config]] — an agent runs on the setup the workflow gives it, not the operator's.
- [[agent-permission-mode]] — host claude runs in auto mode, a classifier on every command.
- [[claude-file-login]] — a sandboxed claude signs in from a login file, not a setup token.
- [[run-through-sleep]] — keep the machine awake for a run; record time slept through.
- [[interrupted-accounting-read]] — a Ctrl-C after the work is done keeps the spend.

### P2

- [[herdr-pane-settlement]] — measuring delivery and release in a pane.
- [[live-spend-limits]], [[billing-provenance]], [[plan-percent-value]] — what spend records claim
  and enforce.
- [[operator-settings]], [[context-size]], [[agent-identity]], [[attended-agent]].
- [[run-in-background]], [[mid-turn-messages]], [[workflow-state]], [[workflow-schedules]].
- [[comparison-efficiency]], [[loop-next]] — the loop's next version, when it runs again.
- [[workflow-in-sandbox]], [[sandbox-host-protection]], [[sandbox-setsid-escape]] — containment's
  edge cases.
- [[linux-host-sandbox]] — a sandbox on the host on Linux, where awf refuses srt (X24).
- [[split-large-modules]], [[test-host-teardown]] — the repository's own.

### P3

- [[review-shapes-and-models]], [[key-growth-from-runs]], [[jev-noise-audit]],
  [[second-case-kind]], [[judge-opus-voter]] — the loop's research and the lab's data.
- [[npm-launch]], [[scrub-private-references]], [[node-runtime]], [[live-eval-disclosure]],
  [[wfa-help]] — the launch.
- [[agent-release]], [[workflow-test-generated-answers]], [[workflow-test-virtual-time]].
