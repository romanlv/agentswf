---
title: Close a test's hosts when it fails
type: story
status: todo
priority: P3
epic: codebase
discovered_in: "cleanup audit, 2026-10-29"
depends_on: []
---

# Close a test's hosts when it fails

A test that opens a Herdr host closes it in teardown, so a failing assertion does not leave its
receipt watch and timers running.

Why it matters: in `harness/src/adapters/herdr.test.ts` each test calls `host.close()` inline, and
its `afterAll` only restores the environment. A test that fails mid-way leaves its host's receipt
watch polling until the 60 s operation deadline, holding the process that long. The orphaned
`bun test` of this file that spun for 3.5 days began from a failing race test.

Notes: about 27 hosts and adapters are made across the file; a helper that records each and an
`afterEach` that closes them covers all. `agent-launcher.ts`'s `bun build` also runs with no
timeout or signal, a smaller case of the same.
