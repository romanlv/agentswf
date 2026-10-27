---
name: awf-coordinator
description: Answer for an awf run's coordinator from this session, reading what its agents report and ask with awf inbox and answering with awf reply. Use when the user asks this session to watch, coordinate or answer awf runs.
---

# Answer for an awf run's coordinator

A workflow's agents report to, and ask, a participant outside the run called a coordinator. This
session answers for it, in the folder where the runs start. You speak as a peer of the agents,
with what the route's purpose lets the coordinator decide; never as the operator. Decide what you
can from the purpose and what the agents say; ask the user when a question needs them.

## The loop

Read everything first, then from where you left off:

```sh
awf inbox --all --json --wait 100
awf inbox --all --json --wait 100 --after {cursor}
```

`--wait 100` keeps under the shell tool's 120 s limit. Each line is one JSON item; keep the last
one's `cursor` and pass it next time. Without `--all`, `awf inbox {workflow}/{id}` reads one run.
Nothing new after the wait prints nothing: run it again.

What to do with each item, by `kind`:

- `route`, `state` `opened`: an agent you may hear from, with the route's `purpose`. That purpose
  says what the coordinator is for; `direction` `both` or `from-participant` means you may also
  message the agent first.
- `message` with `asks: true`: a question waiting for you. Answer it (below). `until`, when given,
  is when it closes unanswered.
- `message` without `asks`: a report. Act on it if it needs acting on; no answer is expected.
- `answered`, `expired`: a question is settled, by someone else or by its limit. Nothing to do.
- `ended`: that run's attempt ended. Stop watching the run once its last attempt has ended and
  none of its questions are open.

To see only what still waits: `awf inbox --all --open --json`.

## Answering

```sh
awf reply {ref} {from} --to {id} --json <<'END'
Keep two incidents, and link them.
END
```

`{ref}`, `{from}` and `{id}` are the item's `ref`, `from` and `id`, exactly as printed. Always pass
`--to`: it keeps a late answer off a newer question. To message an agent first, use
`awf send {ref} {agent} --json` the same way. When the workflow connects more than one
coordinator, add `--as {key}`, the item's `participant`.

The result is one JSON line. `delivered` means the agent will see it. `expired` means the question
closed or someone answered first: drop it. `ended` means the run is over. Any other `code` comes
with an `error` saying what to do instead. Never retry a `delivered` answer.

Stop when the user tells you to, or when every run you were asked to watch has ended.

`awf inbox -h` and `awf reply -h` give every option; `awf -h` lists the other commands.
