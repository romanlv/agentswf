---
title: Limits
description: What awf doesn't do by design, what isn't built yet, and what beta means for the workflows you write.
---

# Limits

awf runs workflows of coding agents on your machine. This page says where it stops: what it leaves
out on purpose, what isn't built yet, and what beta means for code you write against it.

## What awf doesn't do, by design

- **It runs on your machine, and nowhere else.** The engine, its agents and the sockets between
  them are local. There is no hosted service and no remote execution. awf needs Bun on macOS or
  Linux; it refuses to start a run on Windows, which lacks the Unix-domain sockets an agent answers
  over.
- **It drives agents; it doesn't supply them.** Every agent is a real coding agent CLI (claude,
  codex, pi or cursor) installed and logged in on your machine, and its turns run on that login.
- **There is no workflow registry.** `awf run` loads the local file you name, as trusted code
  that runs with your authority. There is no catalogue of workflows to install from.
- **A workflow is TypeScript, not configuration.** There is no YAML and no visual builder. Loops,
  branches and retries are plain code you write.
- **Cost is an estimate, not a bill.** awf reads tokens from each harness's own session files and
  prices them at dated list prices. What you pay is whatever your provider bills for the login the
  agents used.
- **There is no dashboard.** You follow a run in the terminal: `awf run`'s progress view,
  `awf runs` and `awf logs`.

## What isn't built yet

A few calls are in the types but throw when called: calling one workflow from another among
them. The workflow API lists them under [Not built yet](/reference/workflow-api#not-built-yet).
These have no API yet:

- **Reopening agents' sessions on a continue**, for most workflows. A continue reuses the stages
  that succeeded and redoes the rest with fresh agents. Only a workflow with events, one that
  waits for things to happen and wakes when they do, reopens its agents on their kept sessions.
- **Running the workflow itself in a sandbox.** Its code runs on the host with your authority.
- **Permission rules per harness.** You can't yet say which tools an agent may use. awf starts
  codex with its own sandbox off and no approvals, cursor with `--force`, which runs its tools
  without asking, and a sandboxed claude with its permission prompts off. A claude outside a
  sandbox keeps your own permission settings, with Bash allowed so it can answer. So an agent
  outside a sandbox can do what you can, and a sandbox is the boundary today.

And some rough edges:

- A headless claude that needs `metered: true` and lacks it is refused only when it opens, which
  may be after other agents in the run have already done work.
- A headless turn killed in the middle of a request can leave that request out of the run's usage.
- pi's billing (subscription or metered) is inferred from its login file, not read from a bill.

## What beta means

- **One release line.** Every release so far is a prerelease, `0.1.0-beta.{n}`. There is no stable
  version yet.
- **Interfaces change between versions.** The workflow API, the `awf` commands and their flags, and
  the run records can all change in any release. When a better API is found it replaces the old
  one in the next release, with no compatibility shim and no deprecation period.
- **Update awf and your workflows together.** awf runs a workflow against its own copy of
  `agentswf/workflow`; the `agentswf` in your project's `package.json` gives your editor its
  types. After you update awf, update that to the same version, then run the `check` and `test`
  scripts [`awf init`](/guide/quick-start) wrote into its `package.json`:

```sh
bun run check   # tsc --noEmit
bun run test    # awf test
```

A type error or a red test there is the change, found before any agent runs.

## Where it stands

The state of development is kept on GitHub, beside the code:

- [What runs today and the known gaps](https://github.com/romanlv/agentswf/blob/main/docs/status.md)
- [How awf is tested](https://github.com/romanlv/agentswf/blob/main/docs/testing.md), from free
  checks to live agents
- [What was measured](https://github.com/romanlv/agentswf/tree/main/docs/findings), and what each
  measurement settled

Every call a workflow can make today is in the [workflow API](/reference/workflow-api), with what
isn't built under [Not built yet](/reference/workflow-api#not-built-yet).
