---
title: Run a review variant where it cannot see the answer
summary: Give a reviewer only the frozen code and the MR request from a fixture, with no git history, GitLab, past transcripts or earlier review notes in reach.
type: story
status: todo
discovered_in: "autoresearch planning, 2026-09-23"
depends_on: ["005", "004"]
---

# Run a review variant where it cannot see the answer

Why it matters: a score means something only if the reviewer can't look up the answers. An agent
opened without a sandbox can read everything the operator can
([`design/permissions.md`](../../design/permissions.md)), so every leak below is open for it.
[Story 004](../004-sandboxed-agents.md) closes several for an
agent in a sandbox, such as a reader, `sandbox: {}`; each is marked below.

The leaks, and how to close each:

- **Git history.** Later commits, MR refs and branch names can contain the fix. Restore the fixture
  ([story 005](../005-review-fixtures.md)) as a fresh repository holding only `head` and its
  ancestors: real history up to the moment review started, and nothing after. It has no remote,
  no other branches and no reflog, and lives in a temp folder outside `~/dev`. SWE-bench agents
  found future fixes in exactly the history this leaves out.
- **The answer key, and anything naming the MR.** The reviewer gets only `request.md` and the
  frozen code. `fixture.json` names the MR, which can be looked up, and `key/` holds the answers;
  both stay out of the sandbox, and so does the scorer's code.
- **GitLab access.** Tokens in the environment, and `glab` config on disk. **Closed in a sandbox:**
  its environment variables are only what the provider sets, and the operator's home is
  unreadable.
- **Answers on disk.** Notes an earlier review tool kept about the same MR, and old worktrees, some
  of which hold the fixed code. **Closed in a sandbox**, for anything outside its reach: the
  operator's home and the temp directories are unreadable.
- **Harness state.** `~/.claude/projects` and `~/.codex/sessions` may hold a past review of the same
  MR. Memory, the user's `CLAUDE.md` and `AGENTS.md`, and review skills can leak too; one we used
  told the agent to read resolved discussions. **Done by story 004 for agents in a sandbox:** each
  gets a fresh harness home holding its credential and first-run answers, nothing else of the
  operator's, and the operator's harness state is unreadable. A repository's own `AGENTS.md` in the
  working directory is still read, and a fixture repository could carry one.
- **Network.** Allow only the model APIs. **Closed in a sandbox with no `network`**, model-side web
  search included.

How we'll know it worked:

- After each run, scan the transcript for anything touching paths outside the fixture, or naming
  `glab` or `gitlab`. A flagged run is recorded as contaminated. It is never quietly scored.
- A score that looks too good gets its transcript read before it counts.
- Record timeouts and resource limits with every run; they change scores on their own.

Notes:

- **Each replay variant, and each judge, runs in its own sandbox.** In
  [story 004](../004-sandboxed-agents.md), agents in one sandbox trust each other and can read
  each other's homes. Sharing a box across variants makes their scores dependent.

- Start with headless agents only. A sandboxed pane can follow.
- Training data can't be isolated. The only protection there is testing on MRs newer than the
  model's training data.
- Evidence: [`autoresearch-practices`](../../research/autoresearch-practices.md).
