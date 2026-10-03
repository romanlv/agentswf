# 0009 — A fork is a new agent on a copy of its parent's session

**Decided:** 2026-10-03, in [[016-fork|story 016]], proposed there 2026-10-01.
**Replaces:** `foundation.md` §7's and §10's "no fork in any interface until E7's cost split is
settled", and ADR 0001's removal of `HarnessSpec.interactiveResume`, which comes back with an
implementation.

## What was decided

- **`agent.fork({ key })` opens a new agent on a copy of this agent's session.** The copy is taken
  in this agent's queue, after its earlier operations, by the harness's own fork with no model
  call ([`fork-cache.md`](../findings/fork-cache.md), F7). So the point is fixed when the fork is
  asked for. The new agent starts knowing what its parent knew then, and from then on neither sees
  the other's turns. It is an ordinary agent: it runs, compacts and forks like any other, and is
  stopped on its own.
- **A fork has its parent's harness, model, working directory, sandbox and skills.** The cache is
  per model and the session belongs to the harness; the rest is what the session's context
  describes. It may differ in `placement` (with `metered`), `instructions`, which go with its first
  turn, and `labels`.
  - A fork of a sandboxed agent shares its parent's sandbox, as forks on the host share the
    machine, even when the sandbox is private.
  - A fork uses its parent's copy of its skills, not a fresh one: its context is its parent's,
    skills included. This is the one exception to ADR 0004's copy per agent. Where it needs a home
    of its own, a sandbox's or codex's, the same skills come with it, copied into that home, since
    one home's files are not another's (story 016, task 5).
- **awf forks the way that keeps the parent's cache, where the harness allows one.**
  - Claude forks natively and hits in every placement.
  - pi keeps its parent's session id, the key its provider caches by, in a session directory of the
    fork's own.
  - Codex hits only with an ephemeral fork, which outlives no process, so its fork is persisted and
    pays its parent's context once (F4, F5).
- **Fork is refused where it cannot work:**
  - a harness with no fork (cursor);
  - an agent before its own first turn, a fork that has not run included, since its instructions
    are not in its session yet.

  A fork's key is taken when `fork` is called. One already open is the same fork only with the same
  parent and spec; anything else is a conflict, as `agents.open` treats one.
- **A fork answers through its own channel.** A session reported for a fork is not counted as its
  parent's, even if the fork reached the parent's socket with a command from its copied context.
- **A fork is not an operation record.** It calls no model. Rows the fork's session copied from its
  parent stay the parent's, which the run-end read already gives them (F8).

## Why

The use that asks for it: one agent understands a ticket, then several start from that
understanding (reviewers, a tester) instead of each rebuilding it from a brief. A fork gives them
the context the harness wrote rather than a summary the workflow wrote, and the provider caches it.

E7's objection was cost: forks wrote the prefix again, and in panes they never hit. Measured again
with today's harnesses, that holds only where the provider routes its cache by session: codex, and
pi until it keeps its parent's id. Claude now resends a recorded system prompt, so a fork's prefix is
its parent's byte for byte: 48k tokens read and 167 written headless, the same from a pane, and the
same when a pane parent forks a headless child.

A capability flag was rejected in ADR 0001 because a boolean cannot say whether a fork is cheap. Nor
is one added here: every harness that forks does, and what each costs is a finding, not a type.

## Not decided

- An ephemeral codex fork, which hits, needs a codex agent that lives on one app-server process
  across its turns: [`codex-app-server-agent`](../stories/todo/codex-app-server-agent.md).
- Forking at an earlier point than now, as codex's `lastTurnId` and claude's message uuids would
  allow.
- A fork in a different sandbox, or with other skills. Its session's working directory is the
  parent's.
