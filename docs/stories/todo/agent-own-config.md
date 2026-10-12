---
title: An agent runs on the setup the workflow gives it, not the operator's
type: story
status: todo
priority: P2
epic: agent-config
discovered_in: "story 029, task 1, 2026-10-12"
depends_on: []
---

# An agent runs on the setup the workflow gives it, not the operator's

Let the operator choose, per run or per agent, whether an agent outside a sandbox uses the
operator's own claude (or codex, pi, cursor) setup, or a clean one holding only what awf gives it.
The clean one should be the default.

Why it matters: an agent outside a sandbox today starts with everything in the operator's own
setup folder (`~/.claude`, `~/.codex` and the like): their login, settings, memory, instructions,
skills, plugins and past conversations. So what it does depends on whose machine it runs on, and it
can see and reach things it was never given. One example, found in story 029: every claude on a
machine that shares `~/.claude` can list the operator's other claude sessions and send them
messages ([[messaging#Claude's own messaging]]). A claude with a folder of its own sees none of
them.

Notes:

- Sandboxed agents already get a folder of their own ([[permissions#A fresh harness home]]); this
  is the same thing outside a sandbox, as an option.
- The cost is the login. Claude keeps the operator's login in the macOS keychain, so a clean claude
  needs a long-lived token (`claude setup-token`), as a sandboxed one does. codex and pi copy a
  login file.
- Decide: the option's name and where it is set (workflow, agent, operator settings —
  [[operator-settings]]); which parts of the operator's setup a workflow may ask for back (a skill,
  `AGENTS.md`); whether the default changes at once or after a release with a warning.
- Check per harness what "shared" exposes: claude's session messaging; codex's, pi's and cursor's
  equivalents, if any.
