# Resuming a headless session after hours, H1–H3

Whether an agent asked a question by message can be answered hours later in the same session, as
[story 032](../stories/032-run-coordinator.md)'s coordinator needs (its M1). Measured 2026-10-23 on
claude 2.1.309 (`claude-sonnet-5-5`, `claude -p --resume`) and codex-cli 0.164.0 (`gpt-6-luna`,
`codex exec resume`), headless, ChatGPT login for codex. Each session investigated a small log
(about 25k tokens of context once read), ended by asking a question, was resumed at once (warm),
and resumed again 2 h 05 m later with the answer, asked to recall what it had found without reading
a file again. The probe and what each session wrote are in
[`experiments/m1-resume/`](../../experiments/m1-resume/).

| | question | verdict |
|---|---|---|
| H1 | does the session resume after the prompt cache has expired? | **yes, both** |
| H2 | does it still remember the investigation? | **yes, both: the time the errors began, the deploy and what it changed, with no file read again** |
| H3 | what does the cold resume cost? | **claude rewrites its context to the cache, about 13× a warm resume and about as much as the investigation itself; codex showed no cold cost at 2 h** |

## H1–H2

Both resumed into the same session and answered from it: claude in one turn, codex with no command
run. Each named 09:12, deploy `8f3c` and the pool cut from 50 to 10, and went on to the next step
the answer implied.

## H3

Tokens of the resuming request: uncached input / cache read / cache write.

| | warm (at once) | cold (2.1 h) |
|---|---|---|
| claude | 2 / 36,671 / 779 | 2 / 12,896 / 24,731 |
| codex | 34,241 / 8,064 / 0 | 34,340 / 34,048 / 0 |

- claude's cache lasts an hour (its writes are `cacheWrite1h`), so after two the conversation is
  written to the cache again; only the system prompt and tools are read from it. Its own
  `total_cost_usd` rose by $0.0076 for the warm resume and by $0.1034 for the cold one, against
  $0.118 for the whole investigation. A day's wait costs the same as two hours: the cache is gone
  either way.
- codex's usage lines are the session's running totals, so the rows above are differences. At 2 h
  its whole input was read from the cache, more of it than on the warm resume: OpenAI keeps prompts
  cached longer than claude does. After a night it may well be cold; not measured.
- So a coordinator answering the next morning costs one more pass over the agent's context. For
  the story that is acceptable: no cheaper wake-up or summary at resume is needed.

Not measured: days rather than hours, which also decides when a reply after the run could reach
the agent that asked ([[stopped-run-recovery]]); and pi.
