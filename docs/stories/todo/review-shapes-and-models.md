---
title: Try review shapes and models against AIR's own review
summary: Screen and then confirm review workflows of different shapes (lenses, verify, planning, staged) and models per stage, against an agent with AIR's air-code-review skill.
type: story
status: todo
discovered_in: "story 013, the AIR review screen, 2026-10-01"
depends_on: ["013"]
---

# Try review shapes and models against AIR's own review

Why it matters: the first screen (data repository, `reports/2026-10-01-air-review-screen.md`)
found shape mattered more than instructions. Three codex agents with one lens each reached 0.41
weighted recall against one agent's 0.20, with the same model and skill. The user wants shapes
and models explored as a matter of course.

Notes:

- Baseline: `air-skill`, an agent following the repository's `air-code-review`, which every
  case's checkout holds. Not the bare agent.
- Shapes to try: lens sets and counts, a planning pass that chooses what to read, a verifier
  (the first one dropped good findings), staged wide-then-deep, per-file fan-out.
- Models per stage: a cheap wide pass (codex luna, pi) with a strong confirm; claude only with
  the user's say on spend.
- Method: screen on 3–8 tuning cases, 1 trial; confirm the leaders at story 011's looks; the loop
  (story 013) for refinements of a leader.
- Every shape so far misses UI layering and authorization on error paths (air-2105, air-2102).
- Cost is a real axis: lenses cost 2.8×; "same recall, cheaper" waits on
  [`comparison-efficiency`](comparison-efficiency.md).
