---
title: Sandboxes
description: Limiting what an agent can write and reach with srt or docker, sharing a sandbox or keeping one private, and sandboxing a whole run from the command line.
---

# Sandboxes

An agent outside a sandbox can do what you can: write anywhere you can, reach any host, read your
cloud credentials and past transcripts. A sandbox narrows that to what the workflow names. Use one
when an agent's input could steer it somewhere you don't want, such as a repository you didn't
write or an issue anyone can file, or when an agent must not see what another one wrote.

## A shared sandbox and a private one

<<< @/../examples/site/guide/sandboxes.ts#shared

The coder and the tester run in one sandbox. Both can write the working directory, which is
everything they need to fix and run the tests, and reach npm's registry besides their model.
Nothing else is writable, and nothing else under your home directory is visible.

<<< @/../examples/site/guide/sandboxes.ts#private

The reviewer gets a sandbox of its own, given inline. `{}` is the strictest one: it reads the
working directory, writes nothing, and reaches only its model.

The whole workflow, and the test that checks what each agent was given, are in
[`examples/site/guide/sandboxes.ts`](https://github.com/romanlv/agentswf/blob/main/examples/site/guide/sandboxes.ts)
and the `.test.ts` beside it.

## What a spec says

| Field | What the agents inside get |
| --- | --- |
| `read` | host paths they can read, at the same path inside, beyond the working directory |
| `write` | host paths they can write; `"."` is the working directory |
| `network` | domains they can reach beyond their harness's model API: `registry.npmjs.org`, or `*.npmjs.org` for its subdomains |
| `sockets` | host unix sockets they can connect to, such as a browser or a database you run; srt only |
| `webSearch` | `true` keeps the harness's web search, which is off inside otherwise |
| `srt` or `docker` | which provider holds it; omit both for the default |

`wf.sandboxes.open` also takes a `key`, which names it in the record, and a `cwd`, which defaults
to the workflow's working directory. An inline spec takes neither. Relative paths are from the
sandbox's `cwd`, and `~` is your home.

## srt or docker

**srt** is Anthropic's
[sandbox-runtime](https://github.com/anthropic-experimental/sandbox-runtime). Agents run on your
machine with your toolchain: the same `bun`, `node` and compilers you use, minus your home
directory and whatever the spec doesn't name. Each agent is wrapped on its own.

**docker** runs the agents in one container per sandbox, as your user, from awf's image or the one
you name with `docker: { image }`. Paths you name are mounted at the same path, and traffic leaves
only through a proxy that allows the spec's domains.

```ts
await wf.sandboxes.open({ key: "build", write: ["."], docker: {} });
await wf.sandboxes.open({ key: "lint", write: ["."], srt: {} });
```

A spec that names neither runs under srt when it's installed, and docker otherwise. Naming one pins
it: if it isn't installed, the sandbox doesn't open, and the error says so. What each needs on your machine is in
[Install](/guide/install#sandboxes).

Panes work under both. An srt agent's pane opens in the run's Herdr as usual. A docker sandbox runs
its own Herdr inside the container: the run shows it in a tab of its workspace, and prints the
command that shows it, which is all you get with `--no-watch`.

## Shared or private

A sandbox from `wf.sandboxes.open` is shared by every agent you pass it to. An inline spec is always
a private sandbox, recorded as `agent:{key}`. A fork runs in its parent's sandbox.

**Agents in one sandbox can read each other's files**, their harness homes included. Under docker
they share a container and a user, so one can read another's environment, login token included.
Under srt they meet only in the writable paths. Agents in different sandboxes see none of each
other's.

So put agents whose work must be independent in separate sandboxes: a reviewer and what it
reviews, or two attempts at the same task you want to compare.

## Inside a sandbox

- **A home of its own.** Each sandboxed agent starts with a fresh harness home: its login, and
  nothing else of yours. Your harness settings, skills, memory and past transcripts aren't there.
  The repository's own `AGENTS.md` is still read, and the skills the workflow names are copied in.
- **No permission prompts.** The sandbox holds the agent, so the harness's prompts are turned off.
- **No web search** unless `webSearch: true`. claude's and codex's search runs on the model
  provider's servers, past any `network` rule, so it could carry what the agent read out of the
  sandbox. claude's `WebFetch` goes with it. cursor keeps its web tools either way, and pi has none.
- **git works.** An agent in a writable worktree can commit, but can't change its hooks or config,
  which your git runs later.
- **Logins.** claude and cursor need a token in your environment to run in a sandbox; codex and pi
  need nothing more. [Install](/guide/install#each-harness) has the table.

## Sandbox a whole run: `awf run --sandbox`

You can put every agent of a run in one sandbox without touching the workflow:

```sh
awf run --sandbox box.json review.ts
```

`box.json` is an inline spec, such as `{"read": ["/data/request.md"], "srt": {}}`, with relative
paths from `--cwd`. Every agent runs in it, at the run's working directory. A workflow that opens a
sandbox of its own, or gives an agent one, is refused:

```text
every agent in this run runs in the sandbox awf run --sandbox gave it; a workflow cannot open its own
```

This is how you hold workflows you're comparing to the same reach, without trusting each one to ask
for it.

## Catches

- **It refuses, never loosens.** A spec a provider can't hold, a provider that isn't installed, a
  path it won't expose: the agent doesn't open, and the error names why. Nothing runs with less
  confinement than you asked for.
- **Some paths are never allowed.** Your home directory itself or anything holding it, `~/.ssh`,
  `~/.aws`, `~/.gnupg`, `~/.docker`, `~/.kube`, your harnesses' own state, and awf's run and machine
  directories. Name a project under `~` instead.
- **An agent's working directory must be inside its sandbox's reach.** A box can't gain paths once
  open, so an agent whose `cwd` lies outside it is refused.
- **docker needs awf's image.** The first docker sandbox stops if it isn't built, and its error
  gives the `docker build` command to run once.
- **The workflow isn't sandboxed.** A sandbox holds agents. Your workflow code runs on the host with
  your authority; see [Limits](/guide/limits).
- **A sandboxed agent still uses your login.** It runs on your subscription like any other agent.

The record of a run, `output.json`, lists every sandbox once: its provider, the spec with paths
resolved, every domain reachable in the end, and each agent it held.

## See also

- [Sandboxes in the workflow API](/reference/workflow-api#sandboxes)
- [Install: sandboxes](/guide/install#sandboxes)
- [Harnesses](/guide/harnesses), for panes and each harness's login
- [`examples/sandboxes`](https://github.com/romanlv/agentswf/tree/main/examples/sandboxes): a team of
  agents in one docker container, then a reader alone under srt, each reporting what its commands
  could do
