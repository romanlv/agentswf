# M1 — does a headless session resume after hours, and what does it cost?

Run 2026-10-23 for task 3 of [story 032](../../docs/stories/032-run-coordinator.md); the verdict is
in [`docs/findings/resume-after-hours.md`](../../docs/findings/resume-after-hours.md).

`run.ts start` gives each headless session (claude `claude-sonnet-5-5`, codex `gpt-6-luna`) a small
investigation over `work/logs` (a checkout-api log whose 5xx begin at 09:12, two minutes after a
deploy that cut the DB pool from 50 to 10) ending in a question for a coordinator, then resumes it
once at once, the warm baseline. `run.ts resume`, run 2 h 05 m later, resumes each with the
coordinator's answer and asks for the time, the deploy and the change without reading any file
again. `results/` holds each session's three turns: text, usage and timing.

```sh
bun run.ts start && sleep 7500 && bun run.ts resume
```
