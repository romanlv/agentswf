---
name: awf-run
description: Run an awf workflow from this session, either handing the session over to it as one of its agents or waiting on it as a command. Use when the user types /awf-run with a workflow file, or asks to run an awf workflow here.
---

# Run an awf workflow from this session

The user gave a workflow file and maybe arguments for it. Hand this session over to it, as below,
unless they asked to wait on it or to keep working; then run it as a command (the last section).

## Handing the session over

Run, in the shell:

```sh
awf run --here {workflow file} -- {arguments}
```

Leave out `-- {arguments}` when they gave none. Then:

- **It prints a line starting `awf-here-`:** end your turn at once by replying with only that line,
  exactly as printed, and nothing else. The workflow finds this session by it.
- **It refuses:** tell the user what it printed, word for word, and stop. Do not retry another way.

From then on, each of the workflow's steps arrives as a prompt. Do each one as it asks, and return
its answer the way it says, with the `wf result` command it names. A message starting `[awf]` says
the workflow has ended; nothing in it needs doing.

## Waiting on it as a command

Run `awf run {workflow file} -- {arguments}`, without `--here`. The workflow may fork this session
into agents of its own, but never prompts it. A run takes minutes, so wait on it the way your
harness lets a long command run:

- **claude:** with the Bash tool's `run_in_background`, which tells you when it ends; its foreground
  limit is 10 minutes.
- **codex:** in a background terminal, which you poll until it exits.
- **pi:** in the foreground, with no `timeout`.
- **cursor:** in the background, with `is_background`, which tells you when it ends.

When it ends, its output closes with the workflow's result: give the user that, as printed.

## Watching it

Its first line names the run: `awf: {workflow}/{id} started · watch: awf logs {workflow}/{id} --wait 90`.
Name your own run by that reference, never by "the latest": another run may start beside it.

- To see what it is doing, run the `watch:` command in the foreground. It shows what the run has
  done so far, or, while there is nothing yet, waits up to 90 seconds for its first event.
- Every answer ends with what to run next. Run exactly the `next:` command to get only what is new,
  and stop at `run ended`.
- Under claude, `run_in_background` already tells you when the run ends: check in when you need
  to, rather than polling in a loop.
- `awf runs {workflow}/{id}` shows the run in depth: its stages, each agent's state and its last
  activity. `--agent {key}` on `awf logs` follows one agent; `awf logs {run} @{handle} --full` prints
  one event's text.
