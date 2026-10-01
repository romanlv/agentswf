---
id: "015"
title: Compact an agent with its harness's own compact command
summary: "agent.compact runs the harness's native compaction with the workflow's focus, so one agent can carry a long multi-stage task the way an operator does with /compact; a pane agent takes more than one operation to make that useful."
type: story
status: in-progress
discovered_in: "an implement-a-ticket workflow written against the author surface, 2026-10-01"
depends_on: []
---

# Compact an agent with its harness's own compact command

## Outcome

A workflow keeps one agent across the stages of a long task and compacts it between them, the
way an operator does by hand: plan → `/compact focus on the ticket details` → implement, fix
review findings, open the MR → `/compact` → test plan, record, publish. The operator reports that
this works well; the only part handed to separate agents was the review.

Two things stood in the way: `AgentRef.compact` rejected as `unavailable`, and a pane agent took
one operation, so the second turn, compaction or not, was refused. The ticket workflow written
against the author surface opened seven or more fresh agents where the operator used two
sessions, and its fixer never saw why the implementer chose what it did.

## How it works

```text
 workflow                      engine                    harness (per harness and placement)
 ────────                      ──────                    ─────────────────────────────────
 agent.run(implement) ───────► turn 1 ─────────────────► pane: agent prompt … --wait
 agent.compact({ prompt }) ──► compact, after turn 1 ──► claude: "/compact {prompt}"
                                                          codex pane: "{prompt}", then "/compact"
                                                          codex headless: app-server inject + compact
                                                          pi headless: rpc compact, customInstructions
                                                          cursor: refused, nothing sent
 ◄── answered(summary) ◄────── confirmed by the harness's record or screen
 agent.run(review fixes) ────► turn 2, same session, same pane
```

- **`prompt` is a focus for the harness, not an instruction to the agent.** The harness's own
  compaction writes the summary; awf never asks the agent to write one. Each harness takes the
  focus its own way (below), measured live on 2026-10-01.
- **An answer means the harness compacted.** It carries the summary where the harness exposes it:
  claude writes it to its transcript, pi returns it. Codex encrypts its summary, so a codex answer
  is the empty string. Anything else settles as `failed`, `timed-out` or `cancelled`, and the
  agent keeps its context, as the contract already says.
- **A pane agent keeps its pane between operations.** The next operation, turn or compaction,
  waits for the pane to settle, then prompts the same agent. Its answered turn is left to finish,
  as a headless one is, instead of the pane being closed.
- **In a workflow's test** a compaction is met on its own, never from the agent's script list:
  it answers `""` unless `compactions` scripts it, and `run.compactionsOf(key)` lists each one
  with its focus.

## Scope

In scope:

- `AgentRef.compact` in the engine, idempotent by id, queued after earlier operations.
- Native compaction with a focus: headless claude, codex and pi; claude and codex in panes.
- Pane continuation: a pane agent takes a second and later operation in the same pane.
- Scripting compactions in `agentswf/testing`.
- A live eval on every harness and placement, and the operator's ticket workflow's tests.

Out of scope:

- Compaction for cursor. It has no native compaction headless (measured), and is not a pane
  harness.
- Verified pane release and a concurrent identity observer: still
  [`herdr-pane-settlement`](todo/herdr-pane-settlement.md)'s. Continuation here never releases a
  pane between operations, so it needs neither.
- Compaction the harness does on its own when its context fills. awf neither triggers nor reports
  it.

## Context and evidence

Measured 2026-10-01 against claude 2.1.286, codex-cli 0.159.3, pi 0.87.1, cursor-agent
2026.09.28, Herdr 0.9.1, on the cheapest models. Recorded in
[`findings/native-compaction.md`](../findings/native-compaction.md).

- Fact: `claude -p --resume {id}` with `/compact {focus}` on stdin compacts: the transcript gains a
  `compact_boundary` row (`trigger: manual`), the focus as `command-args`, and a user row with
  `isCompactSummary: true` holding the summary. `num_turns` is 0 and `total_cost_usd` is the
  compaction's.
- Fact: in a claude pane, `herdr agent prompt {name} "/compact {focus}" --wait` returns once
  compaction ends (13 s on haiku), with the same transcript rows. Asked afterwards, the agent knew
  what the focus kept and not what it dropped.
- Fact: codex `exec` sends `/compact …` to the model as text. Its app-server compacts:
  `thread/compact/start` on a resumed thread, `turn/completed` about 4 s later. It takes no focus,
  and `-c compact_prompt=…` has no effect on an OpenAI login, whose compaction is remote: the
  rollout keeps every user message verbatim and replaces the rest with an encrypted `compaction`
  item. A user message injected with `thread/inject_items` before compacting reaches the
  compactor and stays in context.
- Fact: in a codex pane, `/compact {text}` sends the text to the model; a bare `/compact` compacts,
  and the screen shows `• Context compacted`. The focus sent as a message just before it worked:
  the agent then kept what the focus kept and lost what it dropped.
- Fact: pi `--print` sends `/compact` to the model as text. `pi --mode rpc` takes
  `{"type":"compact","customInstructions":…}` and answers with the summary. It keeps the last
  `keepRecentTokens` (20k) unsummarized, and refuses with "Nothing to compact (session too small)"
  when nothing falls before them.
- Fact: cursor `-p --resume` sends `/compress` and `/compact` to the model as text.
- Fact: codex's app-server and pi's rpc mode both exit when stdin closes, before compacting; the
  process runner closes stdin after writing it.
- Fact: `herdr agent prompt --wait` "does not track turns: if the agent is already working, that
  active turn's completion may match" (its help). E8 waited for the pane to settle before each
  push, and a prompt pushed into a busy pane was queued, not lost, in every harness.

## Code map

- `packages/contract/src/workflow/agents.ts` — `CompactSpec`, `AgentRef.compact`: the shape stays;
  the docs change.
- `packages/harness/src/spec.ts` — each harness's compaction, beside its other flags.
- `packages/harness/src/command.ts` — a process that holds stdin open until a line answers.
- `packages/harness/src/adapters/direct-process.ts`, `adapters/herdr.ts` — compaction per
  placement; pane continuation.
- `packages/harness/src/session-core.ts` — a finishing turn stopped without ending the session.
- `packages/engine/src/workflow-runner.ts` — `LogicalAgent.compact`.
- `packages/engine/src/workflow-testing/` — scripted compactions.

## Proposed design

[ADR 0007](../adr/0007-compaction-is-the-harness-own.md) records the decision: the focus goes to
the harness, the summary comes from the harness, and a harness without one fails the call.

Alternatives rejected:

- Compaction as a prompt the agent answers with `wf result`, the design until now. It is a turn
  that makes the agent write a summary into a context it does not then replace: nothing shrinks.
- Refusing at `agents.open` an agent whose harness cannot compact. An agent that never compacts
  would be refused too, unless the open spec declared it, which is a published type change for a
  harness, cursor, that no workflow here compacts.
- Codex's `compact_prompt` for the focus: an OpenAI login ignores it (measured).

## Tasks at a glance

- [x] 1. Design: ADR 0007, the contract docs, the design doc
- [x] 2. A pane agent takes more than one operation ([ADR 0008](../adr/0008-a-pane-agent-continues-in-its-pane.md))
- [x] 3. `AgentRef.compact` in the engine, and scripted compactions in tests
- [ ] 4. Native compaction for each harness and placement
- [ ] 5. Live eval on every harness, findings, the ticket workflow

## Implementation notes

- Task 2: the pane backend is `finishesAnswered`, with `stopFinishing` stopping only the host's
  wait. A release of an answered turn that has already ended returns its outcome instead of
  cancelling: cancelling a pane closes it. Each prompt after the first, nudges included, waits on
  `herdr agent wait` first; a nudge's wait returns at once, since its turn has ended.
- Task 3: a compaction is an operation of its own on the agent's queue, with its own usage record
  and no result slot. The harness confirms it by setting `summary` on the outcome; `completed`
  without one settles `failed`. One past its deadline is released as answered, so it is left to
  finish: stopping it would close a pane. In tests, `Scripts` serves both lists, worded by noun.

## Human review

- [ ] Every task is complete and story-level verification passes.
- [ ] Set the story status to `awaiting-human-review` and present the outcome.
- [ ] Record the human's explicit approval or requested changes here.
