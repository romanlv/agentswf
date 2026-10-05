---
title: Stories
type: guide
status: active
---

# Stories

A story is a complete deliverable: one coherent outcome that can be planned, implemented, reviewed,
verified, and accepted by a human. Tasks are the ordered units of work inside a story.

## Lifecycle

1. Capture newly discovered deliverables in [`todo/`](todo/). A todo records enough context to
   recover the idea later, but it is not implementation-ready and must not expand the current
   story's scope.
2. Refine selected work into a numbered story in this directory using
   [`_template.md`](_template.md).
   Refinement includes reading the relevant code, repository evidence, and external sources when
   they can change the design.
3. Mark the story `ready` only when every readiness item is satisfied. `ready` means the proposed
   direction is coherent; it does not skip the implementation agent's planning pass.
4. Execute the story's tasks in order. Each task goes through planning, implementation, subagent
   review, finding resolution, and focused verification before the next task starts.
5. After every task is complete, run story-level verification, set the story to
   `awaiting-human-review`, and hand it to the user with
   the outcome, review findings, verification evidence, deviations, and remaining risks.
6. Mark the story `done` only after explicit human approval. Git preserves completed stories; do not
   turn this directory into a changelog.

Number stories in creation order as `NNN-short-name.md`. Frontmatter is authoritative metadata. Story
status is one of `todo`, `draft`, `ready`, `in-progress`, `blocked`, `awaiting-human-review`, or
`done`; guides use `active` or `archived`.

## Stories at a glance

- [`001` — Run a minimum multi-agent review workflow](001-multi-agent-review.md) —
  `done` — Run parallel review agents through `awf run` and compose accepted structured
  results.
- [`002` — Know what each run cost and how long it took](002-cost-and-time-accounting.md) —
  `done` — The engine records time, tokens and cost for every agent in a run, without workflow
  code, so variants can be compared on price as well as quality.
- [`003` — Report what a failed run spent](003-failed-run-accounting.md) —
  `done` — A run that fails or is cancelled still reads its agents' spend, rejects with it,
  and keeps it in `output.json`.
- [`004` — Run agents inside sandboxes the workflow opens](004-sandboxed-agents.md) —
  `done` — A workflow opens a sandbox with what it can reach and, optionally, its provider, then
  opens agents inside it or in a private one; srt and docker first.
- [`005` — Replay old MRs as review tests with an answer key](005-review-fixtures.md) —
  `done` — The format for a review test (an old MR frozen when review started, plus the real
  problems found in it, graded), and the tools that build them; the data lives outside this
  repository.
- [`006` — Ask a decision model a typed question from a workflow](006-typed-decisions.md) —
  `done` — A workflow asks a System One model, Jev first, typed questions about a state and gets
  probabilities back, recorded and costed with the run.
- [`007` — Give each agent the skills the workflow names](007-agent-skills.md) —
  `done` — A workflow names each agent's skills, as a path or a public skill in a git repository,
  and the agent sees exactly those, on the host or in a sandbox.
- [`008` — Score a review variant against a case's answer key](008-review-scorer.md) —
  `done` — `awf-lab` runs a review variant and a scorer per case, keeps each trial's
  findings and the scorer's labels as records, and reports recall by severity, precision, wrong
  claims, noise, cost and time; `output.json` gains `timed-out` first.
- [`009` — Run agents.wf on another machine from GitHub](009-publish-agentswf.md) —
  `in-progress` — One naming rule, an engine that serves the author surface to any folder,
  `awf --version`, and v0.0.1 installed from a clone on a second machine; npm waits for the launch.
- [`010` — Count a review trial only when its reviewer could not see the answer](010-eval-isolation.md) —
  `done` — every trial's agents run in one sandbox awf-lab gives the run (`awf run
  --sandbox`), holding the checkout and the request; the reviewer's repository is laid out as its
  clone was.
- [`011` — Say whether a workflow variant beats the incumbent, and how sure that is](011-compare-variants.md) —
  `done` — awf-lab says whether a variant beats the baseline, with its
  uncertainty, by a comparison the project can replace; runs several trials a case, runs until the
  verdict stops it, checks a dataset's resolution, and scores with match first.
- [`012` — Test a workflow's own logic next to it, with no agents](012-workflow-tests.md) —
  `done` — an author scripts what each agent and decision model answers in `workflow.test.ts`
  beside the workflow, typed by the schema each turn asks for, and checks what it did, through the
  real engine and for free.
- [`013` — Let an agent propose review workflows and keep the better ones](013-autoresearch-loop.md) —
  `in-progress` (tasks done; its first live loop's gaps are [`loop-next`](todo/loop-next.md)) — `awf-lab loop` has a codex agent write one changed review workflow per try, runs it
  contained against the incumbent, keeps it only on `better`, logs the tree, caps spend, and checks
  the final incumbent once on a holdout.
- [`014` — Run a workflow from inside the session you are in](014-workflow-in-current-session.md) —
  `done` — The operator starts a workflow from a claude, codex, pi or cursor session in a Herdr
  pane; the run starts outside the session's sandbox, drives that session as one of its agents, and
  hands it back when it ends.
- [`015` — Compact an agent with its harness's own compact command](015-native-compaction.md) —
  `done` — `agent.compact` runs the harness's native compaction with the workflow's focus,
  and a pane agent takes more than one operation, so one agent can carry a long task.
- [`016` — Fork an agent so new agents start from what it knows, from the cache](016-fork.md) —
  `done` — `agent.fork({ key })` opens a new agent on a copy of the agent's session, whose first
  request reads the parent's context from the provider's cache on claude and pi.
- [`017` — Run pi in a Herdr pane, as claude and codex run](017-pi-pane-agent.md) —
  `done` — a pi agent may take placement pane, on the host and in sandboxes, with
  turns, continuation and compaction there.
- [`018` — Run a workflow as named stages, and continue it from one](018-workflow-stages.md) —
  `in-progress` — a run has an id and numbered attempts; stages are marked inline, and a continue reuses
  the stages that succeeded and runs the rest; awf gains `stage` and `stop`.
- [`019` — Cursor as a full harness, and a harness definition that cannot be half-added](019-cursor-harness.md) —
  `awaiting-human-review` — cursor runs in a pane, compacts, records its tokens, takes skills and
  runs in a sandbox; each harness is one file whose every capability is built or absent with a
  reason tsc checks.
- [`020` — An agent runs at the effort and model its workflow sets, and switches them mid-run](020-agent-effort.md) —
  `done` — an agent opens at a reasoning effort, and `set` switches its model or effort in
  the same session: headless by the next resume's flags, in a pane by relaunching the harness on
  its session; cursor takes none, and every operation records its settings.

- [[021-turn-liveness-and-limits|021 — Keep a waiting agent alive within fixed limits]] —
  `in-progress` — Repeated cooperative check-ins share one deadline and result slot; an accepted
  answer returns only after native release.

This is the high-level index of numbered stories. Keep each entry to its title, status, and
one-sentence summary; put code maps, research, design, tasks, and verification in the linked story.
Todo items stay in [`todo/`](todo/) until selected for refinement.

## What belongs in a story

A story owns the proposed outcome, scoped code map, implementation approach, tasks, and verification
plan. It opens with `How it works`: a diagram and a plain explanation of the mechanism, readable
before any of the design detail.
It links to authoritative material instead of copying it:

- `docs/findings/` for what the measurements settled, and `experiments/_archive/*/results/` for the raw rows;
- `docs/research/` for background reading;
- `docs/design/` for interface design;
- `docs/adr/` when a decision changes `foundation.md`;
- `docs/foundation.md` for package ownership and stage gates.

Research is proportional to uncertainty. A local behavior may only require code and test reading.
An external interface or unsettled design may require primary-source research. Record what was
checked and what conclusion it supports; a list of links alone is not a handoff.

## Task and story gates

Every numbered story contains ordered tasks under `Tasks at a glance`. Every task uses the first
four gates below, including focused verification in Gate 4, before the next task begins. Story-level
verification and human review happen only after all tasks are complete. Todo inbox notes do not
need these gates.

### 1. Plan and choose the architecture

- Re-read the story, the current task, their comments, `foundation.md`, the affected package
  instructions, and the current code and tests before editing.
- Check the working tree and preserve unrelated user changes.
- Identify the modules, their interfaces, the seams, ownership of state and I/O, invariants,
  failure modes, and the tests that will exercise the same interfaces callers use.
- Prefer deep modules: keep the interface small, hide complexity in the implementation, and avoid
  adding a seam until more than one adapter actually needs it.
- Compare credible alternatives when a decision is expensive. Record why the selected design is
  cleaner and what was rejected.
- Update the story before coding when evidence changes its proposed design. Ask the user only when
  the choice changes product behavior, scope, a public record format, a package seam, or another
  decision that needs their attention.
- Resolve technical unknowns through code reading, repository evidence, focused experiments, and
  primary-source research. An implementation detail being unknown is not by itself a reason to ask
  the user.

### 2. Implement

- Implement the current task's smallest coherent slice.
- Add focused tests with each slice so incorrect behavior is caught while the context is local.
- Put newly discovered adjacent deliverables in `todo/`; do not silently expand the story.
- Record only meaningful deviations and their evidence in `Implementation notes`.

### 3. Review with subagents

- After the coherent implementation and focused tests pass, ask at least two independent subagents
  to review the actual diff. Reviewers report findings; they do not edit the implementation.
- Give both reviewers the story, current task, relevant foundation constraints, diff, and focused
  test results.
- Give one reviewer architecture and scope: module depth, interface size, seam placement, ownership,
  compatibility, and accidental expansion.
- Give another reviewer correctness and proof: races, failure paths, security, cleanup, test gaps,
  and whether the acceptance criteria are genuinely demonstrated.
- Record each actionable finding and its disposition. A reviewer saying only that the code looks
  good is not evidence; the review should name what it checked.

### 4. Resolve findings

- Fix every accepted blocking or important finding and rerun the affected focused tests.
- Explain rejected findings with concrete evidence.
- Request another targeted subagent review when a fix materially changes an interface or the
  architecture selected during planning.
- Run the current task's focused checks, satisfy its `Done when` items, and record the results. Only
  then check the task in `Tasks at a glance` and begin the next task.

### 5. Verify

- After all tasks pass their focused verification, run the story's repository-wide checks and any
  bounded manual or live evaluation specified by the story.
- Record exact commands and outcomes. Do not hide a failure behind retries or mark an unrun check
  complete.
- When no blocking review finding or required verification remains, set the story status to
  `awaiting-human-review` and prepare the evidence for the user.

### 6. Human review and close

- Present the implemented outcome, important architecture decisions, subagent findings and their
  dispositions, exact verification results, meaningful deviations, and remaining risks.
- The human may approve, request changes, or change the story's scope. Requested changes return the
  affected task to the appropriate earlier gate and must be reviewed and verified again as needed.
- Only explicit human approval permits changing the story status to `done`.

## Markdown format

Story files target Obsidian:

- Put note properties in YAML frontmatter at the top of the file.
- Use ordinary relative Markdown links between files so the notes also work outside Obsidian.
- Use Obsidian wikilinks for headings in the same note: `[[#Heading|Label]]`.
- Use `- [ ]` and `- [x]` for task checkboxes.
- Prefer headings and lists over HTML, wide tables, or GitHub-specific formatting.

## Agent rules

- Refine before implementing. Do not mark a story `ready` by filling placeholders with guesses.
- Do not edit production code for a task before its planning and architecture gate is recorded.
- Do not start the next task until the current task's focused verification and review findings are
  complete.
- Do not mark a numbered story `done` without explicit human approval.
- Add every numbered story to `Stories at a glance`, and update its status there and in
  [`../status.md`](../status.md) when the frontmatter changes.
- Treat `Out of scope` as a constraint. Add adjacent work to `todo/` rather than silently widening
  the story.
- Cite paths and symbols in the code map. Line numbers may be added for navigation but are not the
  identity of the code.
- Prefer headings and short lists for detailed material. Use tables only for compact mappings whose
  cells stay easy to scan in a plain Markdown editor.
- Separate observed facts, proposed decisions, and assumptions.
- Put one `Open questions` section immediately after `Tasks at a glance`. Group questions under the
  affected task number and include enough context to show what decision or later work each blocks.
  Write `None.` when no questions remain.
- Stop and return the story for refinement when an unresolved question could change an expensive
  interface, record format, package seam, or stage gate.
- Keep the story current when implementation invalidates its plan. The code is authoritative for
  completed behavior; the story should explain meaningful deviations, not narrate every edit.
