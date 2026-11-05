# 0014 — A run settles its facts as lines in `run.jsonl`

**Decided:** 2026-11-04, in [[041-run-record-layout|story 041]]; the layout is
[[run-record]].
**Amends:** [[0011-a-run-continues-from-its-stages|ADR 0011]]'s "Persistence", which kept one
record per stage in `stages/`, replaced whole.

## What was decided

- **One home per fact, chosen by its writer and its reader.** `run.json` is what the run is;
  `attempts/` its claims and endings; `run.jsonl` what it settled; `in.jsonl` what came in; the log
  what happened; `out.json` and `report.md` views.
- **What the run settled is one append-only file, `run.jsonl`,** written by the attempt that holds
  the run alone: stage ends of every outcome, races, timers, what waits took and acknowledged, saved
  state, started and ended turns, sessions. Nine kinds of line, a closed set.
- **A claim fences the file.** Each attempt appends `claimed` before it reads; a later line from an
  earlier attempt is ignored by every reader.
- **The format is published in `contract`:** the line types and `readRun`, the reading a dashboard,
  an agent or `awf runs` needs. A reader refuses a kind it doesn't know. What the engine does with
  the lines (reuse, what a wait takes) is its own policy, in a pure engine module.
- **`format` versions the record as a whole:** `run.json`, `run.jsonl`, `in.jsonl` and the attempt
  files. A change to any is a new `format`, and a reader refuses one it doesn't know.
- **Each type in `records.ts` names its tier:** public and stable, public for reading, diagnostic or
  private.

## Why

The facts a continue, a wait or `wake` acts on were spread over `stages/`, `replaced/`, the mailbox
and the log, and the engine resumed sessions from the log, which is written best effort. A stage's
failure was kept only if it was the latest. One file the run alone appends to, fenced by a claim,
needs no lock, keeps every stage's history, and gives an outside reader one place and one reading.

## Not decided

- A child call's record: `wf.call` adds a scope to every name-keyed line with a new `format`, when
  it is built.
- Whether `returns` and the first-wait rule stay (the design's "Open").
