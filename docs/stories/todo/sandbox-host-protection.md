---
title: Keep a sandboxed agent's writes from running on the host
type: story
status: todo
priority: P2
discovered_in: "story 004, human review, 2026-09-26"
depends_on: ["004"]
---

# Keep a sandboxed agent's writes from running on the host

Close what story 004's protected paths cannot, starting with docker's read-only mounts, which a case
variant of a name gets past on macOS.

Why it matters: [[004-sandboxed-agents]] gives an agent a writable worktree and keeps read-only
what the host's git and tools run from it: hooks, config, `.git` pointers, `.claude/settings.json`
and the like (`protectedPaths` in `packages/sandbox/src/git.ts`). Under docker on macOS that does
not hold, and some of what the host runs no list of paths can cover. Today the promise is that a
sandbox confines the agent while it runs; what it wrote in a writable path is the operator's to
review before running host tools there.

Notes:

- **docker's read-only file mounts do not hold on macOS.** A writable repository is one mount, and
  each protected path inside it a read-only mount over it. Linux in the box matches a mount by the
  exact name; the Mac's disk ignores case. So `/repo/.git/CONFIG` meets no read-only mount, falls
  through to the writable one, and macOS opens the real `config`. Verified on 2026-09-26: in a box,
  `.git/config` was refused and `echo planted >> .git/CONFIG` wrote the host's file. A directory
  mount (`.git/HOOKS/…`) likely falls the same way, untested. A folder mounted read-only whole is
  not affected, nor is srt, which denied every case variant, nor docker on a case-sensitive disk.
  The guard sees an unchanged path and moves nothing.
  - Options: hash each protected file at open and restore or report a change (best effort, and
    it cannot tell the operator's own edit); or never mount the real gitdir writable on a
    case-insensitive host, giving the box a copy and bringing back only commits.
- **Hooks run what the worktree holds.** A protected `pre-commit` that runs
  `node_modules/.bin/biome` (this repository's), husky's scripts, `lefthook.yml`,
  `.pre-commit-config.yaml` with `repo: local`. Protecting the hook does not protect what it runs.
  At least: say so where the operator will see it, or have `close` report a writable repository
  with live hooks.
- **A repository made during a run is not guarded,** under srt too: `git init --separate-git-dir`
  with a `core.fsmonitor` planted in its config ran on the host's next `git status` in that
  directory (a shell prompt runs one on `cd`). The nested scan runs only at open. Host-run config
  below a writable root, such as `packages/foo/.claude/settings.json`, is unguarded under both.
  - Option: re-scan the writable roots at each reap and at close, and report or quarantine what
    is new.
- **docker's guard lives only as long as the engine.** After a crash or a kill, a planted file
  stays; `sweepExpired` removes containers, never files. Option: write the guard's baseline into
  the sandbox's directory at open, and check it at the next engine start.
- **The providers differ.** srt refuses `mkdir .claude` where none exists, as it blocks creating
  the ancestors of a denied path, and refuses `git init` in the worktree through its own
  `**/.git/config` deny; docker allows both. Whatever the fix, one rule for both.
- **Smaller:** a writable gitdir's `objects/info/alternates` lets host git read objects from any
  path it names; an agent can hide changes from `git status` with `skip-worktree` or `.gitignore`;
  a FIFO left in a gitdir can hang the next open, which reads it.
