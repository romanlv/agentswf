---
title: Harnesses
description: Picking each agent's harness, model and effort, which logins awf runs on and when an agent is metered, and where its pane goes.
---

# Harnesses

A harness is the coding agent CLI an agent runs in: claude (Claude Code), codex, pi or cursor. Each
agent's `runtime` says which harness, which model, how hard it thinks, and whether it runs in a
[TUI or headless](/guide/how-it-works#the-words). One workflow can mix them, so a planner can
think hard in its TUI on your Claude plan while a cheap model lists files with nothing to watch.

<<< @/../examples/site/guide/harnesses.ts#workflow

The planner opens in its TUI, the default, at claude's `high` effort, and its pane stays open if its
turn doesn't end `answered`. The lister runs codex headless. What each harness needs installed and
logged in is on [Install](/guide/install#each-harness).

## Harness and model

`runtime` takes an alias, an alias with changes, or the target spelled out:

<<< @/../examples/site/guide/harnesses.ts#runtimes

- **The aliases** are `claude`, which is claude's `sonnet`, and `codex`, which is codex's
  `gpt-5.6-sol`. Neither names an effort, so the harness uses its default.
- **`{ alias, … }`** adds a `placement`, `metered` or `effort` to an alias. A `harness` or `model`
  you add must match the alias's, or the open rejects.
- **Spelled out**, `model` goes to the harness as it is, in its own words: claude's `sonnet` or
  `claude-opus-5-5`, codex's `gpt-6-luna`, pi's `{provider}/{model}`, a cursor model id. awf
  doesn't check the name; the harness does.
- **An agent keeps its runtime.** Opening the same `key` again with a different harness, model,
  effort or placement rejects.

**Which model to start with.** Start with an alias: `"claude"` and `"codex"` are capable
general-purpose models, and the workflow reads the same whoever runs it. Spell a model out where a
step needs something else: a small, fast one such as codex's `gpt-6-luna` for a narrow question, as
the [quick start](/guide/quick-start) does, or a stronger one such as `claude-opus-5-5` for the
hardest step. Model names are the harness's own, so its CLI, not awf, says which your login can use.

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
model doesn't take: codex's levels cover all its models, and a model given one it lacks fails its
turn. To change model or effort mid-session, see `set` in
[Agents](/guide/agents#compact-switch-fork); a cursor TUI agent can't switch.

## Subscription and metered

awf runs agents on your subscription logins: your Claude plan, your ChatGPT plan, your Cursor
account, whatever pi is signed in to. Three rules keep them there.

**claude and codex must be logged in with a subscription.** When a run opens its first agent on
one, awf reads `claude auth status` or `codex login status`, and anything but a subscription login
refuses the agent:

```text
Claude subscription authentication is required (claude.ai login or `claude setup-token`); `claude auth status` reads as metered
Codex subscription authentication is required (ChatGPT login); `codex login status` reads as metered
```

**API keys in your environment refuse the run.** `awf run` won't start while your environment holds
a variable that would move an agent to per-token billing:

```text
awf: runtime: subscription runtime refused metered credential environment: ANTHROPIC_API_KEY; the run did not start, and nothing of it is kept
```

They are claude's and codex's API keys and base URLs, such as `ANTHROPIC_API_KEY` and
`OPENAI_API_KEY`; [Configuration](/reference/configuration#refused) lists them all. Unset them in
the shell you run `awf` from. awf also withholds `OPENROUTER_API_KEY` from every agent, without
refusing the run.

**Headless claude needs `metered: true`.** `claude -p` is billed per token even on a subscription
login, so awf refuses a headless claude agent unless its runtime gives that consent:

<<< @/../examples/site/guide/harnesses.ts#unmetered

To stay on your plan, run claude in its TUI, the default. codex, pi and cursor need no such flag,
headless or not.

### What the record says

`output.json` marks each agent's turns `subscription`, `metered` or `unknown`:

| Harness | `subscription` | `metered` | `unknown` |
| --- | --- | --- | --- |
| claude | every TUI agent | every headless agent | |
| codex | every agent on OpenAI's models | | a provider other than OpenAI |
| pi | the model's provider signed in with `/login` | the provider set up with an API key | neither could be told |
| cursor | | | always: nothing cursor reports tells plan usage from on-demand usage |

The login checks above are why a claude TUI agent or a codex agent awf opens is never metered; a session
you hand the run with `awf run --here` is read as it is logged in. The run's closing line gives one
word for its agents, leaving the unknown ones out: `subscription`, `metered`, `mixed`, or `unknown`
when none was known, then `billing known {n}/{m}` when some weren't.

`metered` is what the login says about how tokens are billed, not a bill. What a run's tokens would
cost, and what is left of each plan, are on [Cost](/guide/cost).

## Where panes go

Each TUI agent gets a tab of its own, named by its key, in the run's Herdr workspace, and the pane
closes once the agent is done. The workflow says which agents share a tab with `pane`, and which
one you should look at with `front`, which brings its tab forward when it opens in your own
workspace (`--workspace origin`), and nowhere else:

<<< @/../examples/site/guide/harnesses.ts#layout

<div class="pane-layout" role="img" aria-label="The review tab: lead on the left; security on the right, above style">
  <div class="lead">lead</div>
  <div>security</div>
  <div>style</div>
</div>

Where the tabs open and whether panes stay are yours, as you start the run:

```sh
awf run review.ts --workspace origin --keep-panes on-failure
```

`--workspace` is `run`, the run's own workspace and the default; `origin`, the one you typed
`awf run` in; or any other word, the workspace with that label, found or made. `--keep-panes` is
`never`, the default, `on-failure`, when the agent's last turn wasn't answered, or `always`. A kept
pane is left with its harness running, released from the run: what you type into it is yours, and
awf never closes it. The run keeps both for every attempt, so a run that parks and wakes later
places and keeps its panes as it was started to. A run an event starts, with `awf emit`, takes the
defaults: the flags are yours to give when you start a run. A continue may repeat them, or a
default where the run had none, but not change them.

A `pane` that can't be used, such as `beside` an agent with no pane, never fails the agent: it gets
a tab of its own, and the run's closing lines say why. `pane` on a headless or
[sandboxed](/guide/sandboxes) agent rejects the open. Every option and rule is in
[Where panes go](/reference/workflow-api#where-panes-go).

awf starts Herdr headless, in a session named `awf`, and says where to look as the first TUI agent
opens:

```sh
HERDR_DISABLE_SOUND=1 herdr session attach awf
```

## Catches

- **A cursor agent changes your cursor settings.** `cursor-agent --model` saves the model, and its
  parameters, as your default in `~/.cursor/cli-config.json`, headless too. A bare cursor model id
  then runs at whichever variant was chosen last.
- **pi's login is per provider**, so awf can't check it up front: [Install](/guide/install#each-harness).
- **Nudges differ by harness**: a claude TUI agent can say it is still on long work with
  `wfa waiting`. See [Nudges](/guide/timeouts#nudges).

## Next

- [Opening one](/reference/workflow-api#opening-one) in the reference: every `runtime` field.
- [Agents](/guide/agents): turns, outcomes, and switching model or effort.
- [Sandboxes](/guide/sandboxes): what an agent can write and reach.
- [The effort measurements](https://github.com/romanlv/agentswf/blob/main/docs/findings/agent-effort.md),
  on GitHub.
