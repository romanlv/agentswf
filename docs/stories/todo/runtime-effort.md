---
title: Make an agent's reasoning effort part of its runtime
summary: awf has no effort setting, so every agent runs at whatever the operator's environment and harness config say, unrecorded and outside a variant's or judge's version.
type: story
status: todo
discovered_in: "story 008, match first"
depends_on: []
---

# Make an agent's reasoning effort part of its runtime

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
