---
id: "017"
title: Run pi in a Herdr pane, as claude and codex run
summary: "A pi agent may take placement pane: it starts, takes turns, compacts with a focus and is read for usage in a Herdr pane, which pi needs no startup answers for."
type: story
status: draft
discovered_in: "story 016, the operator's review, 2026-10-01"
depends_on: []
---

# Run pi in a Herdr pane, as claude and codex run

## Outcome

`agents.open({ key, runtime: { alias: "pi" } })` opens pi in a Herdr pane, the default placement,
instead of being refused. The operator can watch it work as they watch claude and codex. It
continues across operations in its pane (ADR 0008), compacts with the workflow's focus (ADR 0007),
and, once story 016 lands, forks into a pane or headless.

Nothing in pi stood in the way. awf's pane adapter knows only the startup screens of claude and
codex, the harnesses the review workflows used, and `PLACEMENT_HARNESSES.pane` lists just those
two. E1 and E8 drove pi in panes.

## How it works

```text
 engine                     Herdr adapter                       pi in a pane
 ──────                     ─────────────                       ────────────
 open "pi", pane ─────────► herdr agent start --kind pi ───────► ready at once, no startup block;
                            -- --model {model}                  Herdr names its session by path
 turn ────────────────────► agent prompt … --wait ─────────────► answers through `wf result`
 compact({ prompt }) ─────► "/compact {focus}" ────────────────► "[compaction] Compacted from N tokens";
                            confirmed by the session file        a compaction entry in its file
```

- **Start.** Measured 2026-10-01 on pi 0.87.1 and Herdr 0.9.1. `herdr agent start --kind pi`
  came up ready with no trust or update screen, and Herdr reported the session as its file path.
  That is the ref pi's usage reader already takes (story 002).
- **Compaction.** pi's TUI takes `/compact {instructions}`. The screen showed `Compacted from 30,993
  tokens`, and the session file gained a compaction entry. Herdr's prompt wait answered
  `agent_prompt_stalled` on the slash command, as the findings' operational traps say it does on
  pi. A screen line can be an old compaction's, so the confirmation is a new compaction entry in
  the session file, as headless pi confirms by its rpc answer.
- **The focus** goes to pi's history summary, as headless (C6). A turn split at the cut is
  summarized without it. In the probe the whole recent turn was split, so the summary kept the fact
  the focus dropped, which is pi's behaviour, not the pane's.

## Scope

In scope:

- pi in `PLACEMENT_HARNESSES.pane`, with its interactive launch and skills arguments.
- `compactPane` for pi, confirmed by its session file.
- Pane conformance tests, and pi panes in `tests/harnesses.eval.ts`, `examples/compaction` and the
  quick check.
- pi panes in sandboxes, if the srt and docker pane evals pass for it as they do for claude and
  codex. If they do not, pi panes are refused in a sandbox, and that is recorded.

Out of scope:

- Cursor in panes: [`cursor-pane-agent`](todo/cursor-pane-agent.md).
- pi's split-turn summary ignoring the focus (C6): pi's own.

## Context and evidence

- Fact: the probe's output is in
  [`experiments/_archive/f-fork-cache/results/console.md`](../../experiments/_archive/f-fork-cache/results/console.md).
- Fact: `PLACEMENT_HARNESSES.pane` is `["claude", "codex"]` (`packages/harness/src/spec.ts`). Its
  comment names startup screens as the reason. `herdr-startup.ts` holds claude's and codex's
  blocks only.
- Fact: on the operator's pi, extensions load in a pane as they do headless. `plannotator` logs
  a `custom` entry before every turn, which C6 found can misplace a compaction's cut. A sandboxed
  pi runs `--no-extensions`.
- Assumption: a pi update may add a startup screen. The pane eval would show it as a start that
  never becomes ready.

## Code map

- `packages/harness/src/spec.ts`: `PLACEMENT_HARNESSES.pane` gains pi. pi gets `compactPane`, with
  a confirmation read from its file rather than the screen. That may need `compactPane` to take a
  reader, since today it only reads the screen.
- `packages/harness/src/adapters/herdr.ts` and `herdr-startup.ts`: check that nothing assumes
  claude or codex beyond the startup blocks.
- `packages/harness/src/refusals.ts`: the refusal "a pane runs claude and codex" changes.
- `packages/engine/src/workflow-testing/`: the scripted host refuses what the real ones refuse,
  so pi panes stop being refused there too.
- `packages/harness/src/usage/pi.ts`: already reads a pane's path ref. Checked; no change expected.
- Docs: `status.md`'s "pi in a pane" refusal; story 015's harness list.

## Proposed design

The smallest change: pi joins the pane list, and its pane compaction is confirmed from its session
file. No published type changes, since placement is already per agent.

## Tasks at a glance

- [ ] 1. pi runs in a pane: start, turns, continuation, usage
- [ ] 2. pi compacts in a pane with a focus
- [ ] 3. Live: the harness and compaction evals with pi panes, and sandboxed panes

## Task execution rule

Process one task at a time; each is planned, implemented, reviewed by two subagents, resolved and
verified before the next.

## Task details

### 1. pi runs in a pane

Work: the pane list, the refusals, the scripted host, conformance tests.

Done when: the pane adapter's tests run a pi agent through two operations, with its path as its
session. `tests/harnesses.eval.ts` passes a pi pane with a follow-up.

### 2. pi compacts in a pane

Work: `compactPane` for pi, confirmed by a new compaction entry in its session file.

Done when: adapter tests cover a compaction confirmed by the file, one the file never shows, and
an old screen line that must not count. `examples/compaction` passes on a pi pane.

### 3. Live

Done when:

- the compaction and harness evals pass with pi panes;
- the srt and docker pane evals run pi, or pi panes are refused in a sandbox with the reason
  recorded;
- `docs/testing.md` and `status.md` are updated.

## Verification

- [ ] `bun test`, `bunx tsc --noEmit`, `bun run check`
- [ ] `tests/harnesses.eval.ts`, `tests/compaction.eval.ts`, the pane sandbox evals, on pi's
  subscription model.

## Readiness

- [x] Outcome and boundaries are concrete.
- [x] Relevant implementation, callers, and tests are mapped.
- [x] Evidence supports the design (one live probe).
- [x] No published interface changes.
- [x] Tasks are ordered and verifiable.
- [x] No open questions.

## Implementation notes

## Human review

- [ ] Every task is complete and story-level verification passes.
- [ ] Record the human's explicit approval or requested changes here.
