---
title: Stop unsandboxed agents inheriting the operator's session environment
summary: A headless agent outside a sandbox gets awf's whole environment, including a Claude Code session's CLAUDE_* variables, which is suspected in two judging timeouts that recorded no usage.
type: story
status: todo
discovered_in: "story 008, match first"
depends_on: []
---

# Stop unsandboxed agents inheriting the operator's session environment

Why it matters: `childEnvironment` in `packages/harness/src/command.ts` passes an unsandboxed
agent all of `process.env` but `WF_RUN` and `WF_CALL`. Run from inside Claude Code, as story 008's
trial was, every headless claude judge got `CLAUDECODE`, `CLAUDE_CODE_SESSION_ID`,
`CLAUDE_CODE_CHILD_SESSION`, the session's messaging socket and token, and `CLAUDE_EFFORT`. The
findings already record that `CLAUDE_*` passed into Herdr panes turns off transcript saving, so
those agents record no usage; two of the trial's four sonnet timeouts recorded no tokens at all.
Whether the environment caused them is unverified.

Notes:

- A sandboxed agent already gets exactly the provider's environment (story 004); this is the host
  path only.
- Likely fix: drop `CLAUDE*` (and the session variables of the other harnesses) from an agent's
  inherited environment, or pass an allowlist. Check what `claude -p` needs from the environment
  first: `PATH`, `HOME`, its credential.
- Test: run one headless claude agent from inside a Claude Code session, and see whether its
  transcript and usage are recorded with and without the variables.
