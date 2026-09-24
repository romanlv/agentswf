---
title: Run a review variant where it cannot see the answer
summary: Materialise a fixture as a history-free repository and run its agents without GitLab, later commits, past transcripts or review ledgers in reach.
type: story
status: todo
discovered_in: "autoresearch planning, 2026-09-23"
depends_on: ["historical-review-fixtures"]
---

# Run a review variant where it cannot see the answer

Why it matters: a replayed review scores known-defect recall only if the agents cannot reach the
known defects. Today an agent inherits the operator's whole environment and filesystem
([`design/permissions.md`](../../design/permissions.md), "Where things stand"), so every leak below
is open.

The leaks, and what closes each:

- **Repository history** — `git log --all`, later commits, MR refs, branch names. Closed by data,
  not a sandbox: materialise the fixture as a fresh repository with exactly two commits, base and
  head, no remote and no reflog, in a temp directory outside `~/dev`.
- **GitLab credentials** — `GITLAB_TOKEN`, `glab` or `gh` config. The child environment becomes an
  allowlist (`childEnvironment` in `packages/harness/src/command.ts`); this is step 1 of the
  permissions build order. Config files on disk need step 2.
- **Answers on disk** — `braintrust/docs/reviews/*.md` ledgers, and `braintrust/worktrees/air-mr-*`,
  some of which hold the fixed code. Needs read-deny-by-default: the `srt` host provider, step 2 of
  the permissions build order.
- **Harness state** — `~/.claude/projects` and `~/.codex/sessions` may hold transcripts of a past
  review of the same MR; memory, the user's `CLAUDE.md`/`AGENTS.md`, and the `air-code-review` skill,
  whose instruction to read resolved discussions leaks the answer. Closed by a fresh harness home per
  eval run (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`) holding only the credential. Easy to miss.
- **Network** — GitLab and anything else. An `srt` domain allowlist of the model APIs.

Notes:

- Scope it to headless placement first. The sandbox seam in `permissions.md` is then an argv prefix
  on the direct-process adapter; a Herdr pane under `srt` can follow.
- Add a transcript audit as a tripwire: after each run, flag tool calls touching paths outside the
  fixture or naming `glab`/`gitlab`. Cheap, catches a cooperative agent wandering, and is the first
  evidence that the sandbox actually denies (permissions open question 1).
- **Commit metadata** — the head commit's message and author can carry the fix; SWE-bench agents
  found future fixes through `git log --all`, the reflog, remotes and tags (issue #465). The head
  commit gets a neutral message; the MR description at review start is handed over as the intent.
- **The answer key and the scorer** — fixtures and scorer code are outside every agent's reach,
  reviewer and proposer alike. METR saw o3 reward-hack in 30.4% of RE-Bench runs.
- Timeouts and resource limits are pinned and recorded per run: infrastructure alone moved
  Terminal-Bench 2.0 by 6 points.
- A flagged run is excluded from scoring and recorded as contaminated, never silently scored.
- An anomalously high score gets its transcripts read before it counts (METR's method).
- Evidence: [`autoresearch-practices`](../../research/autoresearch-practices.md).
- Model training data cannot be isolated; the temporal holdout in
  [`historical-review-fixtures`](historical-review-fixtures.md) is the only control.
