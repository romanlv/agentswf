---
id: "017"
title: Run pi in a Herdr pane, as claude and codex run
summary: "A pi agent may take placement pane: it starts, takes turns, compacts with a focus and is read for usage in a Herdr pane, which pi needs no startup answers for."
type: story
status: awaiting-human-review
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
 compact({ prompt }) ─────► "/compact {focus}", then the ───────► chat cleared, one "Compacted from N
                            screen read until it shows the       tokens" line redrawn; a compaction
                            compaction or a refusal              entry in its session file
```

- **Start.** Measured 2026-10-01 on pi 0.87.1 and Herdr 0.9.1. `herdr agent start --kind pi`
  came up ready with no trust or update screen, and Herdr reported the session as its file path.
  That is the ref pi's usage reader already takes (story 002).
- **Compaction.** pi's TUI takes `/compact {instructions}`.
  - **What pi shows:** it clears its chat and redraws one `Compacted from N tokens` line, and the
    session file gains a compaction entry. pi refuses a second compaction straight after one, so
    N never repeats. A refusal prints `Error: Compaction failed: …` or `… cancelled` instead.
  - **What awf reads:** the compaction counts when that line differs from the one on screen
    before. The summary comes from the session file.
  - **Waiting for it:** Herdr's prompt wait answers `agent_prompt_stalled` on the slash command,
    and Herdr reports pi idle while it compacts. So the host reads the screen every 500 ms until
    the compaction or a refusal shows, within the deadline. It sends Escape if the wait ends
    without either.
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

- `packages/harness/src/spec.ts`: `PLACEMENT_HARNESSES.pane` gains pi. pi gets `compactPane`. Its
  `compacted` is given the screen from before the prompts, and its new `ended` says when the
  screen shows the compaction over. pi gets `readCompactSummary`.
- `packages/harness/src/adapters/herdr.ts` and `herdr-startup.ts`: check that nothing assumes
  claude or codex beyond the startup blocks.
- `packages/harness/src/refusals.ts`: the refusal "a pane runs claude and codex" changes.
- `packages/engine/src/workflow-testing/`: the scripted host refuses what the real ones refuse,
  so pi panes stop being refused there too.
- `packages/harness/src/usage/pi.ts`: already reads a pane's path ref. Checked; no change expected.
- Docs: `status.md`'s "pi in a pane" refusal; story 015's harness list.

## Proposed design

The smallest change:
- pi joins the pane list.
- Its pane compaction is confirmed from the screen, read until it shows an end.
- Its summary is read from its session file.

No published type changes, since placement is already per agent.

## Tasks at a glance

- [x] 1. pi runs in a pane: start, turns, continuation, usage
- [x] 2. pi compacts in a pane with a focus
- [x] 3. Live: the harness and compaction evals with pi panes, and sandboxed panes

## Task execution rule

Process one task at a time; each is planned, implemented, reviewed by two subagents, resolved and
verified before the next.

## Task details

### 1. pi runs in a pane

Work: the pane list, the refusals, the scripted host, conformance tests.

Done when: the pane adapter's tests run a pi agent through two operations, with its path as its
session. `tests/harnesses.eval.ts` passes a pi pane with a follow-up.

### 2. pi compacts in a pane

Work: `compactPane` for pi, confirmed from its screen (see the implementation notes for why not its
file).

Done when:
- Adapter tests cover:
  - a compaction that shows only on a later read;
  - a second compaction redrawn over the first;
  - an earlier compaction's line that must not count;
  - a cancelled compaction;
  - one that never shows, which is interrupted;
  - a focus over several lines;
  - the summary read from a test's own pi home.
- `examples/compaction` passes on a pi pane.

### 3. Live

Done when:

- the compaction and harness evals pass with pi panes;
- the srt and docker pane evals run pi, or pi panes are refused in a sandbox with the reason
  recorded;
- `docs/testing.md` and `status.md` are updated.

## Verification

- [x] `bun test`, `bunx tsc --noEmit`, `bun run check`
- [x] `tests/harnesses.eval.ts`, `tests/compaction.eval.ts`, the pane sandbox evals, on pi's
  subscription model.

## Readiness

- [x] Outcome and boundaries are concrete.
- [x] Relevant implementation, callers, and tests are mapped.
- [x] Evidence supports the design (one live probe).
- [x] No published interface changes.
- [x] Tasks are ordered and verifiable.
- [x] No open questions.

## Implementation notes

- **pi needs no startup answers in a pane**, and Herdr names its session by path. The contract
  test starts pi with no startup block. The scripted test host refused pi in a pane before; its
  refusal test now uses cursor.
- **Deviation: the screen confirms pi's compaction, not its session file.** A sandboxed pane's
  session file lives in the agent's own home, which the pane host is not told. Claude's summary has
  the same gap; a sandboxed pane's summary comes back `""`. The screen works in every placement.
- **Counting `Compacted from` lines was wrong.** The first rule counted them before and after. The
  correctness review read pi's source: a compaction clears the chat (`interactive-mode.js`) and a
  full render clears the scrollback. So a second compaction in one pane leaves the count at one,
  and the wait would have run to the deadline. A live probe showed it: `31,282` then `31,415`, one
  line each time. The rule is now:
  - the `Compacted from N tokens` line differs from the one before;
  - a refusal adds a line, or becomes the last event on the screen.
- **The first live run reported a real compaction as failed.** The screen was read before pi
  finished: Herdr reports pi idle while it compacts, and the next prompt arrived 7 ms after the
  compaction entry. Hence `ended` and the poll.
- **The summary was `""` on a stalled prompt**, which returns no agent record. It now falls back to
  the session the agent's turns named.
- **The screen before the prompts is read only for a harness with `ended`**, so claude and codex
  compactions make the same Herdr calls as before.
- **The sandbox probe never gave its pane reviewer the Herdr check**, since pi had no pane. Its
  commands now include it.
- **Live, 2026-10-01:**
  - `harnesses`: 4/4, ~$0.07.
  - `compaction`: all seven runtimes in 60 s, ~$0.52 at list prices, $0.18 charged; then
    `pi-pane` alone, after the review's changes, ~$0.21.
  - `sandbox-panes-srt`: 3m 07s, ~$0.37.
  - `sandbox-panes-docker`: 3m 20s, ~$0.41.

  All passed, with each sandbox's three agents in panes.

## Review record

- **Architecture and scope.** Blocking: the line count, and a summary that might be an earlier
  compaction's. The count is replaced as above. The summary is read only once the screen shows the
  new compaction, which pi renders from the entry it has just written. Should-fixes:
  - the sandboxed summary gap: recorded above, shared with claude;
  - the extra read for claude and codex: removed;
  - the story record: written.

  Its question whether sandboxed pi reports through Herdr without its extension is answered by the
  srt and docker evals: pi ran, answered and was read in both.
- **Correctness and proof.** It read pi's source and found the redraw. It also found:
  - `Error: Compaction cancelled` was never matched: now matched;
  - a compaction left running past its wait: now interrupted with Escape;
  - a focus with newlines: now flattened;
  - tests that read the operator's `~/.pi`: now given a home of their own.

## Human review

- [ ] Every task is complete and story-level verification passes.
- [ ] Record the human's explicit approval or requested changes here.
