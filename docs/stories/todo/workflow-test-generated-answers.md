---
title: Test a workflow against every answer its schemas allow
type: story
status: todo
priority: P3
discovered_in: "story 012, prototype, 2026-09-30"
depends_on: ["012"]
---

# Test a workflow against every answer its schemas allow

Property-based workflow tests, with the turn's schema as the generator; seeded random answers, typed
by the schema, that honour every keyword the engine checks.

Why it matters: a scripted answer tests the case its author thought of. Story 012's prototype ran
`catalogue-review` 100 times, in 0.47 s, against seeded random answers its schemas accepted, and
checked properties that must hold for every one: every lens's findings come back exactly once,
each lens's worst two go to a verifier, and a finding whose rule a verifier rejected comes back
general. The property's first version failed at seed 13, and the same seed reproduced it every
time. The fault was in the property, not the workflow: a finding whose verifier went silent is
also "not checked", and the property had counted it as left out by the limit.

Notes:

- `generate(SCHEMA, random)`, typed by the schema as `answering` is. It must honour every
  keyword in the engine's schema subset (`pattern`, `minLength`, `minimum`, `minItems`, formats).
  Otherwise it produces values the engine refuses, which story 012 reports as test bugs. The
  prototype's generator (`arbitrary`) ignored them.
- Decide whether it ships as `agentswf/testing` API or as a recipe over an existing library
  (fast-check with a JSON Schema arbitrary). The first is a published surface that has to track
  the schema subset.
- A seed in the failure message, so a failing run can be rerun alone.
