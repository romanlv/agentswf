---
title: Harnesses
description: Picking each agent's harness, model and effort, which logins awf runs on and when an agent is metered, and where an agent runs, in a Herdr pane or headless.
---

# Harnesses

A harness is the coding agent CLI an agent runs in: claude (Claude Code), codex, pi or cursor. Each
agent's `runtime` says which harness, which model, how hard it thinks, and whether it runs in a pane
you can watch or headless. One workflow can mix them, so a planner can think hard in a pane on your
Claude plan while a cheap model lists files with nothing to watch.

<<< @/../examples/site/guide/harnesses.ts#workflow

The planner opens in a [Herdr](https://herdr.dev) pane, the default, at claude's `high` effort, and
its pane stays open if its turn doesn't end `answered`. The lister runs codex as a plain process per
turn. What each harness needs installed and logged in is on [Install](/guide/install#each-harness).

## Harness and model

`runtime` takes an alias, an alias with changes, or the target spelled out:

<<< @/../examples/site/guide/harnesses.ts#runtimes

- **The aliases** are `claude`, which is claude's `sonnet`, and `codex`, which is codex's
  `gpt-5.6-sol`. Neither names an effort, so the harness uses its default.
- **`{ alias, … }`** adds a `placement`, `metered` or `effort` to an alias. A `harness` or `model`
  you add must match the alias's, or the open rejects: write `{ alias: "claude", model: "sonnet" }`
  to say the agent needs that model whatever else the alias might come to mean.
- **Spelled out**, `model` is passed to the harness as it is, in the harness's own words: claude's
  `sonnet` or `claude-opus-5-5`, codex's `gpt-6-luna`, pi's `{provider}/{model}`, a cursor model id.
  awf doesn't check it; the harness does.
- **Every agent keeps its runtime.** Opening the same `key` again with a different harness, model,
  effort or placement rejects. A [fork](/reference/workflow-api#forking-new-agents-that-start-from-what-one-knows)
  takes its parent's harness and model.

A workflow's test gets the same two aliases, so a test fails on an alias a run wouldn't know.

## Effort

`effort` is how hard the model thinks, named in the harness's own words:

| Harness | Levels, lowest first |
| --- | --- |
| claude | `low`, `medium`, `high`, `xhigh`, `max` |
| codex | `low`, `medium`, `high`, `xhigh`, `max`, `ultra` |
| pi | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` |
| cursor | none: name the variant as the model, `gpt-5.6-luna-high` |

A level the harness doesn't list rejects the open before anything runs:

```text
claude has no effort "ultra"; its levels are low, medium, high, xhigh, max
```

Left out, awf passes none and the harness uses its own default. A listed level can still be one the
model doesn't take: codex's levels are the union over its models, and a model given one it lacks
fails its turn.

To change model or effort mid-session, keeping the context, an agent calls `set`; see
[Agents](/guide/agents) and [the reference](/reference/workflow-api#switching-model-or-effort-set).
claude, codex and pi switch in a pane and headless. A cursor pane can't.

## Subscription and metered

awf runs agents on your subscription logins: your Claude plan, your ChatGPT plan, your Cursor
plan, whatever pi is signed in to. That gives two rules.

**claude and codex must be logged in with a subscription.** When a run opens its first agent on
one, awf reads `claude auth status` or `codex login status`, and an API-key login is refused:

```text
Claude subscription authentication is required (claude.ai login or `claude setup-token`); `claude auth status` reads as metered
```

`awf run` also refuses to start while your environment holds a key that would move an agent to
per-token billing: `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`,
`OPENAI_API_KEY`, `OPENAI_BASE_URL` or `CODEX_API_KEY`.

```text
subscription runtime refused metered credential environment: ANTHROPIC_API_KEY
```

**Headless claude is metered.** `claude -p` is billed per token even on a subscription login, so
awf refuses a headless claude agent unless its runtime says `metered: true`, your consent:

<<< @/../examples/site/guide/harnesses.ts#unmetered

To stay on your plan, run claude in a pane, the default. codex, pi and cursor need no such flag,
headless or not.

The record says which each agent was. `output.json` marks every agent's operations `subscription`,
`metered` or `unknown`, and the run's closing summary gives the run's: one of those, or `mixed`. How
each is told:

| Harness | `subscription` | `metered` | `unknown` |
| --- | --- | --- | --- |
| claude | a pane on a claude.ai login or a `claude setup-token` token | every headless agent | the login couldn't be read |
| codex | a ChatGPT login | an API-key login | a provider other than OpenAI |
| pi | the model's provider signed in with `/login` | the provider set up with an API key | neither could be told |
| cursor | | | always: nothing cursor reports tells plan usage from on-demand usage |

`metered` is what the login says about how tokens are billed, not a bill. What a run's tokens would
cost, and what is left of each plan (`awf allowance`), are on [Cost](/guide/cost).

## Pane or headless

`placement` is `"pane"`, the default, or `"headless"`.

**A pane** is a terminal pane in Herdr where the harness runs as you would run it yourself, and
keeps its session from turn to turn. You can watch it and type into it. awf puts a run's panes in a
Herdr session named `awf`, which it starts headless if it isn't running, one workspace per run;
`AWF_HERDR_SESSION` names another. The run says where to look as its first pane opens:

```sh
HERDR_DISABLE_SOUND=1 herdr session attach awf
```

**Headless** runs the harness as a plain process for each turn, resuming the agent's session, with
nothing to watch and no Herdr needed. Use it where nobody will look: CI, a server, many small agents.

Both answer the same way, through `wfa result`, under the same deadlines and cleanup. Where they
differ:

- **Billing**: a headless claude is metered, above.
- **Check-ins**: only a claude pane can tell awf it is still on long work with `wfa waiting`.
- **A pane stuck on a question only a person can answer**, such as a permission prompt, ends its
  turn `blocked`, and the run's progress says where to attach and look.
- **`layout` and `keepPane`** are for pane agents only. Either on a headless agent rejects the open.

## Where panes go

Each pane agent gets a tab of its own, named by its key, in the run's workspace, and the pane closes
once the agent is done. `layout` puts it somewhere else as it opens, and `keepPane` keeps it:

<<< @/../examples/site/guide/harnesses.ts#layout

```
┌────────────┬────────────┐
│            │  security  │
│    lead    ├────────────┤
│            │   style    │
└────────────┴────────────┘
```

- **A new tab**: `{ session?, workspace?, tab? }`. `workspace` is `"run"`, the default, `"origin"`,
  the workspace you typed `awf run` in, or `{ name }`, found or made. `tab` defaults to the key.
- **Beside another agent**: `{ beside, side, share? }` splits that agent's pane, to the `"right"`
  or `"below"`. `share`, 0.2 to 0.8, is the new pane's part; 0.5 by default.
- **A fork doesn't inherit** its parent's `layout` or `keepPane`. Without its own it gets a tab.
- **`keepPane`** is `"never"`, the default, `"on-failure"` (kept when the agent's last turn ended
  other than `answered`) or `"always"`. A kept pane is left with its harness running and released
  from the run: what you type into it is yours, outside the run's records, and awf never closes it.
  The run's closing lines say where each kept pane is.

A layout that can't be used never fails the agent: `beside` an agent with no pane, a split that would
be too small, an `"origin"` awf can't find. The agent gets a tab of its own instead, and the run's
closing lines say which agent and why. A layout that is wrong in itself rejects the open: `beside`
its own key, a `share` outside 0.2 to 0.8, or `layout` on a headless or
[sandboxed](/guide/sandboxes) agent.

In `"origin"` and a named workspace, awf only adds tabs, labelled `{tab} · {run id}`, and splits
beside its own panes. It never closes your panes or the workspace.

## Catches

- **A cursor agent changes your cursor settings.** `cursor-agent --model` saves the model, and its
  parameters, as your default in `~/.cursor/cli-config.json`, headless too. A bare cursor model id
  then runs at whichever variant was chosen last.
- **Switching the model costs the cache.** The next turn reads the whole context at full price.
- **pi's login isn't checked up front.** It is per provider, so a missing one fails the first turn
  that needs it, with the command to run. See [Outcomes](/reference/workflow-api#outcomes) for
  stopping a run on it.
- **A failed or timed-out turn closes its agent.** Its pane goes too, unless `keepPane` keeps it.

## Next

- [Opening one](/reference/workflow-api#opening-one) and
  [Where panes go](/reference/workflow-api#where-panes-go-layout-and-keeppane) in the reference.
- [Install](/guide/install#each-harness): each harness's command, login and sandbox needs.
- [Sandboxes](/guide/sandboxes): what an agent can write and reach.
- The [pane layout design](https://github.com/romanlv/agentswf/blob/main/docs/design/pane-layout.md)
  and [the effort measurements](https://github.com/romanlv/agentswf/blob/main/docs/findings/agent-effort.md),
  on GitHub.
