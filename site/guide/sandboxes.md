---
title: Sandboxes
description: Limiting what an agent can write and reach with srt or docker, sharing a sandbox or keeping one private, and sandboxing a whole run from the command line.
---

# Sandboxes

An agent outside a sandbox can do what you can: write anywhere you can, reach any host, read your
cloud credentials and past transcripts. A sandbox narrows that to what the workflow names. awf holds it with one of two providers: srt,
Anthropic's sandbox-runtime on your own machine, or docker, a container. Use one
when an agent's input could steer it somewhere you don't want, such as a repository you didn't
write or an issue anyone can file, or when an agent must not see what another one wrote.

## A shared sandbox and a private one

<<< @/../examples/site/guide/sandboxes.ts#shared

The coder and the tester run in one sandbox, under srt. Both can write the working directory,
which is everything they need to fix and run the tests, and reach npm's registry besides their
model. Nothing else is writable, and nothing else under your home directory is visible.

<<< @/../examples/site/guide/sandboxes.ts#private

The reviewer gets a sandbox of its own, given inline. `{ srt: {} }` is the strictest one: it
reads the working directory, writes nothing, and reaches only its model.

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
| `srt` or `docker` | which provider holds it: required, exactly one |

`wf.sandboxes.open` also needs a `key`, which names it in the run's record, and takes a `cwd`, which
defaults to the workflow's working directory. An inline spec takes neither. Relative paths are from the
sandbox's `cwd`, and `~` is your home.

## srt or docker

**srt** is Anthropic's
[sandbox-runtime](https://github.com/anthropic-experimental/sandbox-runtime). Agents run on your
machine with your toolchain: the same `bun`, `node` and compilers you use, minus your home
directory and whatever the spec doesn't name. Each agent is wrapped on its own. It runs on macOS
only for now; on Linux, use docker.

**docker** runs the agents in one container per sandbox, as your user, from awf's image or the one
you name with `docker: { image }`. Paths you name are mounted at the same path, and traffic leaves
only through a proxy that allows the spec's domains.

<<< @/../examples/site/guide/sandboxes.ts#providers

Every spec names its provider; there is no default. The two give the agents a different machine,
your toolchain or an image, so what works under one can fail under the other, and the workflow
says which it was written for. A provider that isn't installed, or can't be set up, fails the
sandbox with the reason; awf never moves it to the other. What each needs on your machine is in
[Install](/guide/install#sandboxes).

TUI agents work under both. An srt agent's pane opens in the run's Herdr as usual. A docker sandbox runs
its own Herdr inside the container. The run adds a tab to its workspace showing that Herdr's panes,
and prints the command that opens them; `awf run --no-watch` leaves the tab out, and the command
still works. Either way, a sandboxed agent can't take `pane`, which places a pane in the run's
Herdr; the agent is refused if it names one, under `awf run --sandbox` too. `--workspace` and
`--keep-panes` don't reach it.

## Shared or private

A sandbox from `wf.sandboxes.open` is shared by every agent you pass it to. An inline spec is always
a private sandbox, recorded as `agent:{key}`. A fork runs in its parent's sandbox.

**Agents in one sandbox can read each other's files**, including the private folder awf gives
each agent for its harness's settings and copied login, such as codex's. Under docker they also
share a container and a user, so one can read another's environment variables, a login token
included. Agents in different sandboxes see none of each other's.

So put agents whose work must be independent in separate sandboxes: a reviewer and what it
reviews, or two attempts at the same task you want to compare.

## Inside a sandbox

- **A fresh settings folder.** Each sandboxed agent's harness starts from a folder of its own
  holding its login and nothing else of yours. Your harness settings, skills, memory and past transcripts aren't there.
  The repository's own `AGENTS.md` is still read, and the skills the workflow names are copied in.
- **No permission prompts.** The sandbox holds the agent, so the harness's prompts are turned off.
- **No web search** unless `webSearch: true`. claude's and codex's search runs on the model
  provider's servers, past any `network` rule, so it could carry what the agent read out of the
  sandbox. claude's `WebFetch` goes with it. cursor keeps its web tools either way, and pi has none.
- **git works.** An agent in a writable worktree can commit, but can't change its hooks or config,
  which your git runs later.
- **Logins** work differently inside a sandbox for some harnesses; [Install](/guide/install#each-harness)
  says what each needs.

## Sandbox a whole run: `awf run --sandbox`

You can put every agent of a run in one sandbox without touching the workflow:

```sh
awf run --sandbox box.json review.ts
```

`box.json` is an inline spec, such as `{"read": ["/data/request.md"], "srt": {}}`, naming its
provider like any other, with relative paths from `--cwd`. Every agent runs in it, at the run's working directory. A workflow that opens a
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
- **An agent's working directory must be inside its sandbox's reach.** What a sandbox can see is
  fixed when it opens, so an agent whose `cwd` lies outside it is refused.
- **docker needs awf's image built once.** The first docker sandbox stops without it, and the error
  gives the `docker build` command
  ([Troubleshooting](/guide/troubleshooting#docker-the-sandbox-image-image-is-not-built)).
- **The workflow isn't sandboxed.** A sandbox holds agents. Your workflow code runs on the host with
  your authority ([Security](/guide/security#a-workflow-is-trusted-code)).
- **A sandboxed agent still uses your login.** It runs on your subscription like any other agent.

The record of a run, `out.json`, lists every sandbox once: its provider, the spec with paths
resolved, every domain reachable in the end, and each agent it held.

## See also

- [Sandboxes in the workflow API](/reference/workflow-api#sandboxes)
- [Install: sandboxes](/guide/install#sandboxes)
- [Harnesses](/guide/harnesses), for TUI and headless agents
- [`examples/sandboxes`](https://github.com/romanlv/agentswf/tree/main/examples/sandboxes): a team of
  agents in one docker container, then a reader alone under srt, each reporting what its commands
  could do
