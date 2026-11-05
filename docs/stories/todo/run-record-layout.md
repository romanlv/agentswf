---
title: A run's records, designed as a whole
type: story
status: todo
priority: P1
epic: launch
discovered_in: "038, documenting site/reference/data.md, 2026-11-01"
depends_on: []
---

# A run's records, designed as a whole

A run's folder (`.awf/runs/{workflow}/{id}/`) gets the layout it should have before agents.wf leaves
evaluation: one home per fact, chosen by who writes it and who relies on it, with the run's own
record a closed set of lines whose reading, `readRun`, is published in `contract`. The proposal is
[[run-record|docs/design/run-record.md]]; nothing changes until it is reviewed.

Why it matters: record formats are what others build on (`awf logs`, `awf runs`, 040's client, an
agent reading a run, a dashboard, the optimizer foundation §7 names), and the layout grew a story at
a time. Measured on 2026-11-04 against the code:

1. **A named step's answer has three stores**, each with its own keys and rule for a second call: a
   stage's value in `stages/`, a race's winner as a `took` line and a timer as a `timer` line in
   `mailbox.jsonl`.
2. **The mailbox is not only an inbox**, and not only for runs with events: every run that uses a
   timer, `sleep`, race or wait writes one, holding the run's own `wait`, `took`, `timer`, `turn` and
   `launch-failed` lines beside the events from outside, and its own `timer:due`, `at:due` and
   `agent:ended` events. `data.md`'s "with events only" is out of date.
3. **Continue reads the log** that stories 028 and 039 say it never reads: a run with events resumes
   its agents' sessions from `turns.jsonl`.
4. **Sessions are recorded four ways:** turn lines, `operation-started` lines, `session-known` lines
   and each stage record's `sessions`.
5. **Decisions are overwritten each attempt** (`decisions/{n}.json`, numbered from 1, written without
   a rename), and nothing reads them; `replaced/` and `calls/` are read by nothing but tests.
6. **`output.json` is the only home of the run's return value**, its sandboxes, skills and panes,
   though no code reads the file; it also repeats the attempt file's stages and accounting.
7. **Records and scratch share the folder:** `agents/`, `staging/`, `forks/` and `skills/`.

The proposal, in one line each: `run.json` identity; `run.jsonl` what the run settled, one writer,
fenced by attempt; `in.jsonl` what came in, under the lock; `attempts/` claims and endings, a
failed launch included; `log.jsonl` the story, never read to act; `ops/{op}/` one folder per turn,
compaction or decision, with its measured spend, named `{agent}.{n}` or `{decision}.{n}`; `out.json`
and `report.md` views; `work/` scratch.

Short names were settled on 2026-11-04: `ops/`, `op.json`, `answers.jsonl`, `live.jsonl`,
`screen.txt`, `in.jsonl`, `out.json`, and op ids from the agent's or decision's key and a count, in
place of a UUID. That makes agent and decision keys names, as events and stages are, and one
namespace between them: accepted the same day, though a key like `Reviewer` or `fix tests` is then
refused where it opens today.

Notes:

- **Before 039's next beta**: it builds on what 039's tasks 1–9 shipped, not on task 10 or the
  story closing. 039's `earlier: { stages, mailbox }` (task 6) is unpublished, and the beta that ships
  tasks 1–9 publishes it. This design replaces `mailbox` with `events` and `run`; settle it first, or change it
  through a deprecation. 039's line 723 should commit to the event *names*, not the mailbox's record
  kinds.
- **Homes for other todos**: [[workflow-state]]'s record format (`state` on a wait or stage line),
  [[non-answered-evidence]] (`ops/{op}/screen.txt`, built today in `calls/{operationId}/`), [[interrupted-accounting-read]]
  (`spend.json` settled by the next attempt), [[crash-leftovers-reaper]] (the attempt file).
- **Amends ADR 0011**'s "Persistence" paragraph; needs an ADR of its own when accepted.
- After acceptance: `site/reference/data.md`, `runs-and-stages.md`'s "State on disk", and
  `records.ts` follow.
