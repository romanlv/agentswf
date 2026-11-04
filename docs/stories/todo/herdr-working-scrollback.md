---
title: Read a working pane without its scrollback
type: story
status: todo
priority: P2
epic: long-runs
discovered_in: "concurrent-agents live suite, 2026-11-03"
depends_on: []
---

# Read a working pane without its scrollback

Every read of a pane awf makes while its agent may be working asks for what Herdr can give then:
the visible screen, or the harness's own record, never `--source recent-unwrapped`.

Why it matters: Herdr 0.9.1 refuses a scrollback read of a working agent with `agent_not_idle`
("its alternate-screen history can only be captured by scrolling while idle … use --source
visible"). Two live failures in the concurrent-agents suite, both also on main, come from it:

- **fork, codex compaction.** The compaction's evidence read came while codex was still working
  past it, and the operation failed `the pane could not be read`. The concurrent-agents branch
  now accepts a compaction its record showed with no screen; a harness with no record (cursor,
  pi) still fails this way.
- **calling-session.** `tests/calling-session.eval.ts` reads the working claude for its cue text
  with `recent-unwrapped`, is refused, never presses Escape, and waits out its eight minutes:
  `no run record within eight minutes`. The eval's probe, not the engine, fails.

Still to check: `herdr-caller.ts` finds the calling session by reading each pane's scrollback for
its code, and reads the caller's turn the same way after `agent prompt`. A caller seen working
would be refused there too. `adapters/herdr.ts` reads the screen for login and for compaction's
"before" the same way.

Notes: the fix per site is `--source visible` where the cue is on screen, a retry once Herdr shows
the agent idle where the history is needed, or the record where the harness has one. Whether
Herdr's refusal depends on load (the read worked in earlier runs) is not measured.
