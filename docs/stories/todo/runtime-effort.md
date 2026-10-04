---
title: Make an agent's reasoning effort part of its runtime
type: story
status: todo
discovered_in: "story 008, match first"
priority: P0
epic: agent-config
depends_on: []
---

# Make an agent's reasoning effort part of its runtime

awf has no effort setting, so every agent runs at whatever the operator's environment and harness
config say, unrecorded and outside a variant's or judge's version.

Why it matters: effort changes an agent's time, cost and answers as much as its model does, and
awf neither sets nor records it. In story 008 every judge ran at an effort nobody chose: headless
claude inherited `CLAUDE_EFFORT=medium` from the Claude Code session that launched `awf-lab`, codex
read `model_reasoning_effort = "medium"` from the operator's `~/.codex/config.toml`, and pi reads
`defaultThinkingLevel` from `~/.pi/agent/settings.json`. Change any of them and a judge's labels and
timings change under the same version, which is exactly what a version is meant to rule out.

Notes:

- `ExecutionConfig` is `RuntimeTarget & PlacementChoice`: harness, model, placement, `metered`.
  An `effort` field is a published type change; decide its values (claude: low to max; codex:
  `model_reasoning_effort`; pi: its thinking levels) and whether a harness without it rejects or
  ignores it.
- Each harness spec in `packages/harness/src/spec.ts` would pass it (`claude --effort`, codex
  `-c model_reasoning_effort=`, pi's flag), and `output.json` would record it per agent.
- A sandboxed agent gets a fresh harness home, so it loses the operator's config setting too: today
  its effort is the harness default, silently different from the same agent on the host.
- **Change it during a session too** (the operator, 2026-10-04, folded in from
  `setting-effort-level`): every harness should set its effort at the start and during a session,
  as a person can in the harness itself (claude's `/effort`, codex's `/model`). So effort is also a
  per-turn choice, `agent.run({ effort })`, over the agent's own, recorded on each operation. Which
  harnesses can change it mid-session, headless and in a pane, is to be measured per harness.
- **Why it's first now.** The first live loop (data repository,
  `reports/2026-10-01-first-live-loop.md`) hit it twice: contained codex ran at its own default,
  `low`, and wrote near-empty reviews; and its proposer, the step that should think hardest, could
  not be given high effort ([[loop-next]]).
- A stopgap, not this story: a contained `awf-lab` trial copies the host's codex
  `model_reasoning_effort` into its codex config (`packages/lab/src/review/lab/execute.ts`), so a
  contained codex trial runs at the host's effort. Nothing else does, and nothing records it.
