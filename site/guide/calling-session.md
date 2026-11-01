---
title: Calling session
description: "A workflow that uses the coding session it was started from: handing the session over with awf run --here, forking it with forkCaller, and writing a skill so a session knows to run your workflow."
---

# Calling session

You are deep in a coding session: the agent knows the change, the dead ends, why things are the
way they are. A workflow started from that session can use what it knows in two ways:

- **Hand the session over.** `awf run --here` makes the session one of the run's
  [agents](/guide/how-it-works#the-words): each step arrives in it as a prompt, and when the run
  ends the session is yours again.
- **Fork it.** `wf.agents.forkCaller` opens a new agent on a copy of the session, which knows
  everything it knew. The session itself waits on `awf run` as an ordinary command, and its own
  context isn't spent on the work.

Here the session that made a change says what it changed, a fresh agent tests it, and the session
fixes what fails:

<<< @/../examples/site/guide/calling-session.ts#caller

In a claude, codex, pi or cursor session running in a [Herdr](/guide/install) pane, the agent
runs:

```sh
awf run --here test-my-change.ts
```

The run starts in a new Herdr tab, and `awf` prints a line for the agent to end its turn with:

```text
awf: test-my-change.ts is starting in Herdr tab {tab}. Once this turn ends it takes this session over: each of its steps arrives here as a prompt, and a last message hands the session back.

End your turn now by replying with only this line, exactly:
awf-here-1f3a9c2e
```

That line is how the run finds the session. From the next turn on, `author.run` prompts it as it
would any agent, and the session answers with `wfa result`, as every agent does.

## Handing the session over: `caller`

`wf.agents.caller({ key })` gives the calling session as an agent under the key you name, or
`null` when the run wasn't started with `--here`. On `null`, stop and say how to start the
workflow, as above, or open an agent of your own instead.

It is an agent like the others, with the differences that follow from it being your session:

- **Its harness, model, directory and skills are yours.** `caller` takes only a key: no runtime,
  no `instructions`. `set` rejects, `compact` ends `failed` and leaves the session as it was, and
  `execution.model` is `""`.
- **A failed or timed-out turn doesn't close it,** as it would an opened agent; the next `run`
  still works. Interrupting a turn yourself, as you would any agent at the keyboard, settles it
  `cancelled`.
- **One key.** Asking again with the same key gives the same agent; another key rejects.
  `wf.agents.attach("author")` returns it too, once `caller` has, which is handy where code has
  only the key.
- **It gets one last message.** When the run ends, the session is told how and where the run's
  record is, starting `[awf]`, and nothing in it needs an answer. `wf.agents.stop("author")`
  hands it back early, while the rest of the run goes on.

The run itself is an ordinary run: it has an id, its record is in `.awf/runs`, and you
[follow it](/guide/following-runs) with `awf runs` and `awf logs`. `--here` takes `awf run`'s
other options, and `--continue` too; `awf run -h` lists them.

## Forking the session: `forkCaller`

<<< @/../examples/site/guide/calling-session-fork.ts#fork

`defineWorkflow<null, string>` says it takes no arguments and returns a string. Saved as
`describe-change.ts`, the agent runs `awf run describe-change.ts`, without `--here`, as a long
command, and reads the description from its output. The fork is a new agent of the run with a copy of the session up to
the command that started it:

- **It runs on the model the session last ran,** at the harness's default effort unless you name
  one, in the session's directory, with awf's launch flags and your skills, not your harness
  settings or MCP servers.
- **It takes the options a [fork](/guide/agents#compact-switch-fork) takes,** `placement`,
  `effort`, `instructions`, `labels`, `layout` and `keepPane`, but no `tools`.
- **`null`** means there is no session to fork, and the run's output says why: `awf run` wasn't
  started from an agent's shell, the session's files weren't written in the last 10 minutes, or
  the session is in its first turn and has nothing to copy.

`forkCaller` works from claude, codex and pi sessions. With `--here` it works too: then the copy is
taken after the run's own turns in the session.

## A skill that runs your workflow

To have a coding session run your workflow when it fits, write it a skill: a folder with a
`SKILL.md`, where your harness reads skills. The session finds it by its description, so the
description says when to use it, and the body says exactly what to type and what to do with the
answer:

```md
---
name: test-my-change
description: Have a fresh agent write and run tests for the change this session just made, then fix what fails. Use when the user asks to test this change, or before saying a change is done.
---

# Test my change

Run, in the shell, from the repository root:

    awf run --here workflows/test-my-change.ts

- **It prints a line starting `awf-here-`:** end your turn at once by replying with only that
  line, exactly as printed. The workflow finds this session by it.
- **It refuses:** tell the user what it printed, word for word, and stop. Don't retry another way.

From then on each of the workflow's steps arrives as a prompt. Do each one as it asks, and answer
it the way it says. A message starting `[awf]` says the workflow has ended; nothing in it needs
doing.
```

A skill for a workflow that forks the session instead runs `awf run` without `--here`, as a
command, and says:

- **How to wait.** A run takes minutes, longer than many harnesses let a shell command run in the
  foreground. Say how your harness runs a long command: in the background, or in the foreground
  with no timeout.
- **How to follow it.** The run's first line on standard error names it,
  `awf: {workflow}/{id} started · watch: awf logs {workflow}/{id}`. Name the run by that
  reference, run the `watch:` command, then each answer's `next:`, until `run ended`.
  [Following runs](/guide/following-runs#following-a-run-from-another-agent) has the steps.
- **What to do with the result.** It is the command's standard output: what the workflow's
  `present` makes of it, or `--json` for the whole record.

Keep the skill in step with the workflow: when its arguments change, change the command in the
skill.

## Catches

- **`--here` needs a Herdr pane.** In a plain terminal it refuses and starts nothing; run the
  workflow with `awf run` instead. It also refuses a workflow with [events](/guide/events), which
  runs detached in its project.
- **The session must end its turn with the line.** The run looks for it for two minutes. Not
  found, the run doesn't start, and its tab says why.
- **One run drives a session at a time.** A second `--here` from a session a run is driving is
  refused.
- **Under codex's default sandbox,** the session can't reach Herdr's socket, which `--here` and a
  pane agent need. `awf` says so, with what to change: start codex with
  `-c sandbox_workspace_write.network_access=true`, or approve running `awf` outside its sandbox.
- **A fork's run is inside the session's sandbox.** Without `--here`, `awf run` is the session's
  child, so the run and its agents are in whatever sandbox the session is, and pane agents need it
  to let them reach Herdr's socket. A `--here` run starts in its own Herdr tab, outside it.
- **No pane goes beside the calling session.** Its pane is yours: a
  [`layout`](/guide/harnesses#where-panes-go) `beside` it falls back to a tab of its own.
  `{ workspace: "origin" }` puts a tab in the workspace you typed `awf run` in.
- **A headless fork of a claude session is metered.** The fork runs on the session's harness, so
  `placement: "headless"` on claude needs `metered: true`; in a pane it runs on your subscription.
  [Harnesses](/guide/harnesses#subscription-and-metered) says why.
- **A killed run says nothing.** A run that ends, fails or stops tells the session; one whose
  process is killed doesn't, and the session sits waiting for a prompt. Type to it as usual.
- **A test has no session.** Script one with `testWorkflow`'s
  [`caller`](/reference/testing-api#caller) option.

## Next

- [The workflow API: The calling session](/reference/workflow-api#the-calling-session) and
  [forking it](/reference/workflow-api#forking-the-session-that-started-the-run).
- [awf](/reference/awf): `awf run` and `--here`.
- [Following runs](/guide/following-runs): watching a run from another agent.
