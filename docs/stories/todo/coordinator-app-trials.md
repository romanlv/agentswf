---
title: An app and a host drive a run as its coordinator
type: story
status: todo
priority: P2
epic: observability
discovered_in: "story 032, closed 2026-11-06 with M2 and M3 not run"
depends_on: []
---

# An app and a host drive a run as its coordinator

A chat app outside this repository and one existing agent host each drive real runs as their
coordinator through `awf inbox`, `awf reply` and `awf send`, and what they needed from awf is
recorded.

Why it matters: the holder's surface is published, and only `awf run`'s terminal and a claude
session have held it. An app is what it was designed for (story 032, Intent 3).

Notes:

- **M3:** a sample app on the Vercel Chat SDK reads `awf inbox --all` from a saved cursor, keeps
  one thread per subject, answers with `--to`, and survives an app restart and a laptop sleep.
- **M2:** Hermes or OpenClaw runs `awf inbox` and `awf reply` through its own extension point. Does
  it fit how the host binds a thread to a session, or does it need glue awf should have provided?
- Any glue awf should provide is a change the user approves first: the surface is published.
- Story 032's To measure and Implementation notes hold the design and what the claude session found.
