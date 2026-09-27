---
title: An agent can overwrite its own launcher
summary: A pane claude on Haiku wrote its answer over the `wf` launcher with `cat >`, and could then never report; the launcher should not be writable by the agent it serves.
type: story
status: todo
discovered_in: "story 007, the skills eval, 2026-09-26"
depends_on: []
---

# An agent can overwrite its own launcher

Why it matters: the launcher is the agent's only way to answer. In the `skills` eval, a claude pane
on `claude-haiku-4-5` ran `cat > /tmp/awf-…/wf << 'EOF'` with its answer as the heredoc, replacing
the launcher with text. Every later `wf result` failed with `result: command not found`, the nudge
could not recover it, and the turn settled unanswered. The skill itself had worked: the agent had
the right word.

Notes: the launcher is written `0o700` in the agent's own directory under `CONTROL_PLANE_ROOT`
(`packages/engine/src/agent-launcher.ts`, `writeLauncher`), owned by the same user the agent runs
as, so the agent can write it. Making it `0o500` stops a plain `cat >` but not a `chmod`; a sandbox
already denies writing it (story 004). Whether cheaper models do this often is not measured: one
occurrence in one run.
