---
title: Keep the evidence of a pane that didn't answer
type: story
status: todo
priority: P0
epic: observability
discovered_in: "implement-ticket rerun; story 001, task 7"
depends_on: []
---

# Keep the evidence of a pane that didn't answer

A turn that ends without an answer, or an agent that fails to start, leaves in the run record what
the pane showed, so a person can tell a real `blocked` from a misread one.

Why it matters: a turn settled `blocked`, `unanswered` or timed out keeps no screen, and closing
the run closes the pane unless the workflow said `keepPane: "on-failure"` (story 026). In the
implement-ticket rerun a worker that was mid-tool-call was settled `blocked`, likely a
misclassification, and nothing was left to check it against. A settlement bug can't be found or
fixed without this.

Notes:

- **Non-answered outcomes.** Save `agent read --source detection` in the call dir with every
  non-answered outcome, and name it in the run's result.
- **Start failures.** In story 001's first live run every `agent.start` failed and the run record
  kept no native diagnostic, so the Herdr rejection was lost with the workspace. Keep a redacted
  `agent.start` diagnostic in the engine-owned run record, without raw command arguments or unsafe
  provider output.
- The record shape and redaction boundary are a durable-evidence decision: the screen's home is
  the operation's folder, `ops/{key}.{n}/` ([[041-run-record-layout|041]]).
- Split from [[herdr-pane-settlement]], whose measurement work this doesn't wait on: the screen is
  evidence, not settlement authority.

## Proposed shape

Drafted 2026-11-04, for review; nothing is built.

**One file per operation: `ops/{key}.{n}/screen.txt`.** It holds the pane's visible screen when
the operation settled without an answer, as plain text with ANSI stripped, mode `0600`, capped at
64 KiB (the last lines kept). The op folder is the operation's evidence, so the screen sits in it
directly, and a later piece (a headless agent's `stderr.txt`) beside it. It was built in
`calls/{operationId}/` first, and [[041-run-record-layout|041]] moved it.

**When.** On every outcome but `answered` and `cancelled`: `unanswered`, `blocked`, `timed-out`
and `failed`, for turns and compactions alike, and for the nudges of an operation, since they
settle with it. A cancel is the operator stopping the run, and a read then only delays the close.
A start failure is an outcome of the operation that launched the agent (the pane starts inside its
first turn), so it is the same case and needs no record of its own.

**What is read.** `pane read {pane} --source visible`, not `agent read --source detection`:
- The visible screen is the whole pane. Detection is Herdr's own region for state.
- A pane read works when Herdr no longer knows the agent, as after a failed `agent start`.
- `visible` is never refused while the agent works ([[herdr-working-scrollback]]).

It is read before the pane closes, so `keepPane` doesn't change.

**Who writes it.** The harness reads the screen, since it holds the pane: `HarnessTurn` gains
`screen?()`, a harness-package seam, not the contract's. The engine asks for it only once it knows
the operation ended without an answer (only it knows whether a result was accepted), before it
releases the turn, so the screen is the one the agent stopped on, not one after Escape. It waits at
most 5 s and never fails the operation over it. A start that fails closes its pane inside the
turn, so Herdr's host reads the screen before closing it and answers with that one. A headless agent has no screen and writes none; its stderr
tail is a later, separate choice.

**Where a person finds it.** The path follows from the `operationId` that every `usage` row in
`out.json` and every `turn` line already carries, so no record gains a field:
- `site/reference/data.md` lists the file under `ops/{key}.{n}/`.
- `awf logs` prints `screen: {path}` on a non-answered turn's line.
- `awf run`'s closing block doesn't, for now: a run doesn't record which operation ended it, so
  naming one would be a guess.

This changes the story's note "name it in the run's result": the convention is the smaller surface,
and a field can still be added later, where removing one cannot. The run-record design agrees: `out.json`
is a view with nothing only in it, and a diagnostic file is not part of what it promises.

**Redaction.** The screen is stored as shown. It shows nothing the agent's own session files,
which the run already points at, don't hold in full. The run folder is readable by the operator
alone. It is never printed to a terminal, only its path. The start diagnostic stays the outcome's
`reason`, already Herdr's error, stripped of escapes and cut to 400 characters (M2).

## Built

On branch `screen-evidence`, 2026-11-04:
- [x] `HarnessTurn.screen()`, Herdr's run host reading `pane read --source visible`, a failed start's
      screen read before its pane closes; the fake harness scripts one with `screen`.
- [x] The engine keeps it for turns, message operations and compactions, not for answered or
      cancelled ones: `ops/{key}.{n}/screen.txt` (041 moved it from `calls/{operationId}/`).
- [x] `awf logs` names it, and `--json` as `screen`; `site/reference/data.md` lists it.
- [x] Live, codex in its pane, a turn timed out mid-`sleep`: `screen.txt` (0600) shows it
      working, read before the interrupt, and `awf logs` names it.

Keeps no screen, by choice or for now:
- A turn that answered and was then stopped, or whose release then failed (`cleanup-unresolved`):
  it answered, and the read would come after the release anyway.
- A supervisor that threw, and a compaction that started only after its deadline.
- A compaction its scope stopped is read after the scope's Escape.

## To measure

- **M1.** A sandboxed TUI agent whose pane is a login shell has its launch line typed in
  (`typeInto`), so a failed start's screen shows that line. Confirm the line carries no credential.
  If it can, a typed start keeps no screen.
- **M2.** Confirm that Herdr's `agent start` errors never echo the command they ran.
