---
title: No agent left unwatched waits on a safety-check prompt
type: story
status: todo
priority: P1
epic: agent-config
discovered_in: "factory review run 2619's settler, 2026-11-27, after 8ed1fe2f"
depends_on: []
---

# No agent left unwatched waits on a safety-check prompt

Any claude agent that nobody watches denies Claude Code's safety-check prompts at once, not only a
sandboxed one, so the turn goes on and isn't recorded as `blocked`.

Why it matters: 8ed1fe2f sets `permissions.denyInsteadOfPrompting` only for sandboxed agents
(`packages/harness/src/sandbox-needs.ts:81`), and it closed the self-expiring-prompts todo. On
2026-11-27, a factory settler without a sandbox, woken by `awf tick`, ran a zsh-only command
(`${(f)d}`). Claude Code couldn't parse it and prompted, nobody answered, and awf recorded the turn
as `blocked`. The run failed that step and retried.

Notes: decide what counts as unwatched: a run started by `awf tick` or a service, a headless
placement, or every run unless an operator attaches. A person resuming the session must not
inherit the setting, as 8ed1fe2f already ensures for the sandbox. Related: [[agent-permission-mode]],
[[attended-agent]], [[non-answered-evidence]].
