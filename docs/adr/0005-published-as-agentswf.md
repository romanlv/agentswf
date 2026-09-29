# 0005 — Published as agents.wf, the package `agentswf`

**Decided:** 2026-09-27. **Amended:** 2026-09-28, see below. **Replaces:** `foundation.md`'s naming note, which left the package scope
`@wf/*` a placeholder with npm availability unchecked, and the README's "Nothing here is
published".

## What was decided

The project is **agents.wf**, at that domain. It is published to npm as one unscoped package,
`agentswf`, which runs on Bun only and ships its TypeScript as source.

- A workflow imports the author surface as `agentswf/workflow`. That name is the published one
  of today's `@wf/contract/workflow`, and changing it later breaks every workflow written against
  it.
- The operator's command stays `awf` (`awf run`, `~/.awf/runs`), and an agent's stays `wf`.
- The workspace packages keep their `@wf/*` names. They are private and go into `agentswf`; no
  user sees them, and renaming them would only churn every open branch.
- The first release, 0.0.1, is for the operator's own machines. Nothing else is promised yet: the
  author surface is still open to change before 1.0.

## Why

`awf` could not be the name. GitHub's Agent Workflow Firewall ships an `awf` command and does
what the docker provider does, a box behind a proxy with a domain allowlist; npm's `awf` is an
unrelated Alfred tool; and the `@wf` scope is not ours. A personal scope would tie every
workflow's import to one account.

The command keeps `awf` anyway: it is typed often, it clashes only on a machine with both tools,
and a command is cheap to rename. The import line is not, which is why it takes the package's
name.

Bun only, because the engine is Bun throughout (`Bun.spawn`, `Bun.serve`, `Bun.listen` on unix
sockets, and a `bun build` of `wf` at run time), and a Node port would buy nothing its users need.

## Not decided

- An npm organisation. `agentswf` publishes from an account; moving it under one later changes
  no name.
- How `agentswf` is assembled from the workspace: bundled, or source with its internal imports
  resolved. Settled when 0.0.1 is packed and installed into an empty directory.

## Amended, 2026-09-28

Three things above no longer hold ([[009-publish-agentswf|story 009]]):

- **The workspace packages are `@agentswf/*`,** each named for its directory, instead of private
  `@wf/*`. The operator wanted one set of names, and `@agentswf` was free on npm and GitHub. Two
  packages were renamed with it: `cli-agent` is `@agentswf/wf`, in `packages/wf`, and
  `autoresearch` is `@agentswf/lab`, in `packages/lab`.
- **Every package publishes at the launch,** not one package that holds the rest. The
  organisation is `@agentswf`, which settles the first question under "Not decided".
- **Nothing goes to npm before the launch,** 0.0.1 included. 0.0.1 is a git tag, installed from a
  clone. An npm package is public the moment it is published, and the repository is still
  private.

The repository is `agentswf/awf`, named for the command.
