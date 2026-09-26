---
id: "<NNN>"
title: "<Outcome-oriented title>"
summary: "<One sentence for the story index>"
type: story
status: draft
depends_on: []
---

# <Outcome-oriented title>

## Outcome

Describe the user- or system-observable result. State why it matters now.

## How it works

Explain the mechanism so someone new to it can follow in two minutes: one diagram (the data, the
flow, or the timeline), then a few plain sentences on each part and on the case people will ask
about first. Name files or types only where the reader needs them. Keep it current as the design
changes.

## Scope

In scope:

- <behavior or artifact>

Out of scope:

- <nearby work deliberately excluded>

## Context and evidence

- Fact: <relevant observation with a link to code, findings, design, or research>
- Constraint: <foundation rule, compatibility requirement, or stage gate>
- Assumption: <anything not yet verified>

## Code map

### <Package or module>

- Paths and symbols: `<path>` — `<symbol>`
- Relevance: <current behavior and likely change>

Include callers, tests, and the interface or record formats the change may affect. Say explicitly
when an area was checked and does not need to change.

## Proposed design

Describe the smallest coherent change. Name the module, its interface, and the seam when the story
introduces or changes one. Record important invariants and error behavior.

Alternatives rejected:

- <alternative> — <reason>

## Tasks at a glance

- [ ] 1. <Short outcome>
- [ ] 2. <Short outcome>

Keep this list short. It is the progress view; details belong below. Check a task only after its
own planning, implementation, subagent review, finding resolution, and focused verification are
complete.

## Open questions

Group questions by the task they affect. Include enough context to show the decision and what it
blocks. Write `None.` when every question is resolved.

### 1. <Short outcome>

- <question and context>

### 2. <Short outcome>

- <question and context>

## Task execution rule

Process one task at a time. Every task repeats the checklist shown under its details. Do not begin
the next task because the current implementation merely compiles: its design must be recorded, its
diff reviewed by subagents, findings resolved, and focused verification complete.

After all tasks are complete, run story-level verification and request human review of the complete
deliverable.

## Task details

### 1. <Short outcome>

Outcome: <observable result of this task>

Execution:

- [ ] Plan: inspect the relevant code and tests, settle the cleanest module, interface, seam,
  invariants, failure behavior, and focused proof, and record material alternatives before coding.
- [ ] Implement: make only this task's coherent change and add focused tests with it.
- [ ] Review: have two read-only subagents review this task's actual diff and test output—one for
  architecture and scope, one for correctness and proof.
- [ ] Resolve: fix or explicitly disposition every material finding; request targeted re-review
  when a fix changes the selected architecture.
- [ ] Verify: run this task's focused checks and satisfy every `Done when` item before checking the
  task in `Tasks at a glance` or starting the next task.

Work:

- <coherent change, including the relevant module or seam>

Done when:

- <focused proof that makes the next task safe to start>

### 2. <Short outcome>

Outcome: <observable result of this task>

Execution:

- [ ] Plan: inspect the relevant code and tests and record the architecture and focused proof.
- [ ] Implement: make only this task's coherent change and add focused tests with it.
- [ ] Review: obtain architecture/scope and correctness/proof subagent reviews of the actual diff.
- [ ] Resolve: disposition findings and obtain targeted re-review after material design changes.
- [ ] Verify: satisfy every `Done when` item before checking this task.

Work:

- <coherent change>

Done when:

- <focused proof>

Tasks are checkpoints, not a file-by-file edit script. The implementation agent may adjust the
implementation without changing their outcomes, order, or the story's scope.

## Verification

Automated:

- [ ] <focused test and expected behavior>
- [ ] `bun test`
- [ ] `bunx tsc --noEmit`
- [ ] `bun run scripts/check-boundaries.ts`

Manual or live evaluation:

- [ ] <only when behavior cannot be proved cheaply in automated tests; note cost and prerequisites>

## Review record

Record reviews under the task they cover.

### Task 1

- Architecture and scope: <what was checked; finding and disposition>
- Correctness and proof: <what was checked; finding and disposition>

### Task 2

- Architecture and scope: <what was checked; finding and disposition>
- Correctness and proof: <what was checked; finding and disposition>

## Readiness

- [ ] Outcome and boundaries are concrete.
- [ ] Relevant implementation, callers, and tests are mapped.
- [ ] Evidence and research support the proposed design.
- [ ] Expensive interface, record-format, and stage-gate decisions are settled.
- [ ] Tasks are ordered, coherent, and independently verifiable.
- [ ] Open questions are resolved or explicitly moved out of scope.

## Implementation notes

Leave empty during refinement. During implementation, record task-level planning decisions,
meaningful deviations from the proposal, newly discovered follow-up stories, and exact verification
outcomes.

## Human review

- [ ] Every task is complete and story-level verification passes.
- [ ] Set the story status to `awaiting-human-review` and present the outcome, architecture
  decisions, task-level subagent findings and dispositions, exact verification results, deviations,
  and remaining risks.
- [ ] Record the human's explicit approval or requested changes here.
- [ ] If changes are requested, return to the affected task and repeat its review and verification.
- [ ] Only after explicit approval, mark the story `done` and update `Stories at a glance`.
