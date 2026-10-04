---
id: "015"
title: Compact an agent with its harness's own compact command
summary: "agent.compact runs the harness's native compaction with the workflow's focus, so one agent can carry a long multi-stage task the way an operator does with /compact; a pane agent takes more than one operation to make that useful."
type: story
status: done
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

In a workflow (from the ticket workflow):

```ts
const worker = await workflow.agents.open({ key: "worker", runtime: "claude" });

const plan = await worker.run({ prompt: prompts.docReview(ticket), schema: DOC_REVIEW, timeoutMs });
await worker.compact({
  prompt: "Keep the ticket, the plan in its doc and the decisions; drop the doc review's back and forth.",
});

const built = await worker.run({ prompt: prompts.implement(ticket, plan.value), schema: IMPLEMENTED, timeoutMs });
await worker.compact({ prompt: "Keep what changed and why; drop the build logs." });
```

What each call does underneath:

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

- Compaction for cursor. Its compaction is `/summarize` (`/compress` is an alias), and it runs
  only in its interactive TUI: headless, both reach the model as text (measured). In a pane it
  summarized and went on, but awf does not run cursor in panes yet: that is
  [story 019](019-cursor-harness.md).
- Verified pane release and a concurrent identity observer: still
  [`herdr-pane-settlement`](todo/herdr-pane-settlement.md)'s. Continuation here never releases a
  pane between operations, so it needs neither.
- Compaction the harness does on its own when its context fills. awf neither triggers nor reports
  it.
- Forking a compacted agent, so several agents start from the same small base. Each harness that
  compacts can fork its session natively, compaction included (measured): claude
  `--resume {id} --fork-session`, codex `exec fork {id}`, pi `--fork {id}`. That is
  [story 016](016-fork.md), which measured what a fork costs against the prompt cache first.

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

- `packages/contract/src/workflow/agents.ts` — `CompactSpec`, `AgentRef.compact`: the shape stayed
  through the tasks; the review made `id` and `deadline` optional, as `run`'s are.
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
- [x] 4. Native compaction for each harness and placement
- [x] 5. Live eval on every harness, findings, the ticket workflow

## Implementation notes

- Task 2: the pane backend is `finishesAnswered`, with `stopFinishing` stopping only the host's
  wait. A release of an answered turn that has already ended returns its outcome instead of
  cancelling: cancelling a pane closes it. Each prompt after the first, nudges included, waits on
  `herdr agent wait` first; a nudge's wait returns at once, since its turn has ended.
- Task 3: a compaction is an operation of its own on the agent's queue, with its own usage record
  and no result slot. The harness confirms it by setting `summary` on the outcome; `completed`
  without one settles `failed`. One past its deadline is released as answered, so it is left to
  finish: stopping it would close a pane. In tests, `Scripts` serves both lists, worded by noun.
- Task 4: each harness's compaction is in `spec.ts` beside its other flags: `compactHeadless`
  (a plan, and how its stdout says it compacted) and `compactPane` (what is typed, and the screen
  that shows it ran). Headless claude uses `stream-json`, the one format that prints the boundary
  and the summary, so a sandboxed claude needs no file read. Codex's app-server and pi's rpc mode
  exit when stdin closes, so `runProcess` gained `holdStdinUntil`: stdin stays open until a line of
  stdout answers. A pane's summary is read from claude's transcript in the operator's home; a
  sandboxed pane's claude keeps its own home, which this host is not told, so its summary is `""`.

- Task 5: `examples/compaction` and `tests/compaction.eval.ts`. The live runs found four things,
  each fixed: codex-cli 0.159's folder trust screen is new, and a digit only moves its cursor, so
  the block is matched with its cursor on the option and answered with enter; a bare `/compact`
  is not echoed in codex's pane, so its check anchors on the focus message; on the operator's pi
  an extension's entry before a turn makes pi split the turn before the cut and summarize it
  without the focus, so the eval puts a short turn between the facts and the filler
  ([findings](../findings/native-compaction.md#c6--pi)); and haiku printed `wf result` rather than
  running it when told "do not write it anywhere", so the eval no longer says that.
  `quick-check` now asks pane agents its follow-up too, and `minimum-review`'s eval records a turn
  left finishing once it ends.

- Review (one subagent over the whole branch): four bugs, all fixed. A held child stopped after
  its answer read as failed, so a compaction's output now decides it and the runner drains a
  descendant's pipes; a pane turn left finishing never stopped spending, so past its grace the host
  sends Escape when the agent is still working; a compaction past its deadline lost its later
  usage, and one that started late could race the next turn for the session, so it is now waited
  for within the cleanup grace, else the agent is closed as for a turn. Two small ones, also fixed:
  claude's pane check now needs the whole `Compacted (ctrl+o…` line, and workflow tests refuse a
  compaction before the first turn, and on cursor, as real hosts do.

## Verification

Automated, 2026-10-01:

- [x] `bun test`: 1010 pass, 0 fail.
- [x] `bun run check`: Biome, `tsc`, boundaries.

Live, 2026-10-01:

- [x] `compaction`: all six runtimes in one run, 46 s, ~$0.32 at list prices, $0.15 charged. Every
  harness that compacts answered, its summary holding the codename where it shows one, and every
  agent recalled the codename and the colour; cursor refused and recalled the colour.
- [x] `harnesses`: 3 agents, the claude pane answering its follow-up, 17 s, ~$0.07.
- [x] `minimum-review`: both reviewers completed, the codex pane's turn left finishing, 25 s,
  ~$0.05.
- [x] `sandbox-panes-srt`: failed once, its claude tester refusing the probe's prompt as an
  injection on its first turn: haiku's judgement, not a pane's. It passed in story 017's runs and
  in the full `bun run eval` the same day.

## Human review

- [x] Every task is complete and story-level verification passes.
- [x] Set the story status to `awaiting-human-review` and present the outcome.
- [x] `deadline: { unixMilliseconds: Date.now() + 5 * MINUTE },` is ugly and should be refactored.
  Done: `compact({ prompt })` takes `run`'s defaults, a generated id and the workflow's deadline,
  with `timeoutMs` to bound it ([ADR 0007](../adr/0007-compaction-is-the-harness-own.md),
  amended). `examples/compaction` and `docs/workflow-api.md` use it.
- [x] Record the human's explicit approval or requested changes here.
  - 2026-10-01: `compact`'s `id` and millisecond deadline read badly, and the ticket workflow is
    hard to follow as a process. The first is fixed above; making workflows read as their process
    stays in [`readable-workflows`](todo/readable-workflows.md).
  - 2026-10-01: approved; the operator asked for the story to be cleaned up and marked done.
