---
title: Run logs and telemetry
type: story
status: todo
priority: P1
epic: observability
discovered_in: "implement-ticket flow.ts live runs, AIRS-1515, 2026-10-02"
depends_on: []
---

# Run logs and telemetry

See and follow what each agent of a run is doing, and record a run's events, time and cost as OTel,
so logs, per-stage cost and live limits read one stream.

Why it matters: during the first live implement-ticket run, the only view was the progress block
and the workflow's own log lines.

- To see what headless codex was doing in review round 3, the run had to be found under
  `~/.awf/runs`, its call dir read for the prompt, and codex's own
  `~/.codex/sessions/…/rollout-…jsonl` found by grepping for the session id from the process list.
- To see why the worker stopped, its `~/.claude/projects/…/{session}.jsonl` had to be read the same
  way.
- The run dir holds `calls/{id}/{call,attempts,result}.json`, the prompt and the hand-back,
  and nothing of what happened in between.
- After the run, the cost was one line per agent key, so the worker's ~$14.81 had no breakdown.

## What to build

1. **`awf logs`**, like `docker compose logs`:
   - `awf logs [run] [--agent review:codex] [-f]` interleaves the workflow's log lines, turn
     start and end (agent, label, stage, duration, outcome), and each agent's activity, read from
     its native session: messages, tool calls, background tasks.
   - One prefixed line per event; `-f` follows a running run.
   - A run defaults to the latest; `--agent` narrows to one.
2. **The run dir links each agent's native session** (`agents/{key}.jsonl` →
   `~/.claude/projects/…`, `~/.codex/sessions/…`), so a plain `tail -f` works and the
   evidence is in one place.
3. **OTel as the record.** Emit the run's own events as OTel, following the GenAI semantic conventions:
   - spans for the run, stages (story 018), turns and nudges;
   - attributes for agent, harness, model, placement and outcome.

   Read each harness's OTel export (Claude Code monitoring, Codex OTel config) for agent activity
   and live usage, where today awf parses session files at run end. Then these all read one stream:
   - `awf logs`;
   - per-stage time and cost, and the progress view's cost per stage;
   - a cost limit that needs usage during a turn (`turn-liveness-and-limits`);
   - an external backend if the operator points one at it.

## Open questions

- Is OTel the record or an export? Today the run record and usage are awf's own formats
  (`contract`), and accounting reads session files. Moving accounting onto OTel data changes a
  record format.
- Do the harness OTel exports carry enough: per-turn usage, tool calls, background tasks? If not,
  session files stay as the fallback, as now. Measure before deciding.
- Where do spans go with no collector configured: a file in the run dir (OTLP JSON), read by
  `awf logs`?
- foundation.md §10: a telemetry package is extracted at "two producers and two consumers". This
  story may be what fires it.

## Related

- `operator-run-observation`: a status command and progress stream; logs are the detail behind them.
- [story 018](../018-workflow-stages.md): stages as spans; per-stage cost.
- `turn-liveness-and-limits`: live usage for cost limits; activity for no-progress limits.
- Story 002: cost and time accounting.
- `docs/reading.md:24-29`: the GenAI conventions and the harness OTel exports, with the note "we
  should standardise on OTel".
