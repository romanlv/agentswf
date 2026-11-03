---
title: Hosting events
description: "What keeps a waiting run going: awf tick on a schedule for timers and crashes, and a webhook, a CI job or another workflow calling awf emit for events."
---

# Hosting events

A run of a workflow with [events](/guide/events) parks while it waits: its process exits, and
nothing of awf stays running. That is what lets a run wait a day for a reply without holding a
process. It also means something outside awf has to come back and wake it. There are two
wakers:

- **`awf emit`**, sent by whatever learns about the event: a webhook handler, a CI job, a git hook,
  or another workflow. An event wakes its run at once.
- **`awf tick`**, run on a schedule. It continues the runs whose timer is due, and the ones that
  crashed or failed.

Set up both. Without the first, no events arrive. Without the second, no timer ever fires on a
parked run.

## A run that needs both

This workflow starts when a deploy finishes, waits an hour for the service to settle, then has an
agent check it. A rollback during that hour ends the run without a check:

<<< @/../examples/site/guide/hosting-events.ts#workflow

The sample is checked and tested:
[`examples/site/guide/hosting-events.ts`](https://github.com/romanlv/agentswf/blob/main/examples/site/guide/hosting-events.ts)
and its test.

The deploy pipeline starts the run with an event:

```sh
awf emit --target ~/ops/post-deploy.ts --id api-v42 deploy.done '{"service":"api","version":"v42"}' --event-id api-v42
```

```text
accepted post-deploy/api-v42: started
```

The run reaches the race and parks, and `awf runs` shows it waiting:

```text
post-deploy/api-v42  parked       11-01 16:14  0s        api v42 settling · until 11-01 17:14
```

Then one of two things wakes it:

- a rollback, sent the same way (`awf emit … --id api-v42 deploy.rolled-back '{"version":"v42"}'`),
  which continues it at once;
- the first `awf tick` after the hour, which continues it with the timer due, so the checker runs.

## `awf tick` on a schedule

```text
<!--@include: @/../packages/engine/src/help/tick.txt-->
```

awf adds a project to `~/.awf/projects` the first time a run with events starts in it, so one
scheduled `awf tick --all` covers every project on the machine. Each time it runs, for every run
of a workflow with events, `awf tick`:

- **continues a parked run** whose wait has something to take: a timer that is due, or an event
  that arrived while an earlier wake couldn't start the run;
- **continues a crashed or failed run**, unless it is `stuck`: three failures in a row, the first
  included, counting crashes, failed attempts and processes that never started, whoever woke it;
- **starts a run that has no attempt yet**, which happens when the event that made it couldn't
  start its process;
- **leaves the rest**: a running run, one you stopped or cancelled, and one that returned. Runs of
  workflows without events aren't looked at.

It prints a line for each run it woke, and nothing when it woke none:

```text
continued post-deploy/api-v42: timer
continued post-deploy/web-v17: crashed
```

Every wake takes the run's lock, so a tick that comes while an event is waking the same run
continues it once, not twice. Overlapping ticks are harmless, and the schedule is only how late a
timer may be: with a tick every five minutes, the checker above starts up to five minutes after
the hour.

### cron

On Linux, one line in `crontab -e` ticks every five minutes:

```sh
*/5 * * * * PATH="$HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin" awf tick --all >> "$HOME/.awf/tick.log" 2>&1
```

`awf` runs on Bun, so `PATH` must hold Bun's `bin` directory, which cron's short default `PATH`
doesn't.

### launchd

On macOS, a launch agent does the same. Save this as
`~/Library/LaunchAgents/wf.agents.tick.plist`, with `/Users/you` replaced by your home directory
(launchd doesn't expand `~` or `$HOME`):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>wf.agents.tick</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Users/you/.bun/bin/awf</string>
    <string>tick</string>
    <string>--all</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/Users/you/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>StartInterval</key>
  <integer>300</integer>
  <key>StandardOutPath</key>
  <string>/Users/you/.awf/tick.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/you/.awf/tick.log</string>
</dict>
</plist>
```

```sh
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/wf.agents.tick.plist   # load it
launchctl bootout gui/$(id -u)/wf.agents.tick                                     # remove it
```

## Sending events with `awf emit`

```text
<!--@include: @/../packages/engine/src/help/emit.txt-->
```

`awf emit` works on the machine that holds the project: it finds the run through the workflow
file, in the nearest directory above it holding `.awf/`. So the sender runs there too, whatever it
is:

- **A webhook handler** on that machine turns a request into `awf emit`, with the event's data as
  its JSON and the source's delivery id as `--event-id`.
- **A CI job** on a runner on that machine runs `awf emit` as a step, as the deploy above does. A
  hosted runner can't reach the project; it calls a webhook on the machine instead.
- **Another workflow** sends with `wf.emit(target, id, name, data, { eventId })`, checked by `tsc`
  against the target's events. Run on a schedule beside `awf tick`, such a workflow polls a system
  and sends each change it sees:
  [`examples/event-sketches/mr-tick.ts`](https://github.com/romanlv/agentswf/blob/main/examples/event-sketches/mr-tick.ts)
  sketches one for merge requests.

Give each occurrence an `--event-id`, such as the delivery id or a commit, so a sender that retries
is safe: the same id again is `duplicate`, not a second event, and it still wakes the run if the
first try couldn't. The exit code tells a handler what to answer:

| Exit | What happened | A handler |
| --- | --- | --- |
| 0 | `accepted`, `duplicate` or `refused` (the run returned, or the event can't start one) | answers success |
| 1 | the run's process didn't start, and the event is kept for the next event or `awf tick`; or the target file couldn't be loaded | answers a server error, so the source retries: with the same `--event-id` a retry is a `duplicate` that wakes the run |
| 2 | the event or the command is wrong: a usage error; a target that declares no events, sits directly in your home directory, or whose `prepare` refuses a run with no arguments; an event name, data or id the target doesn't take | answers a client error |

## TUI agents

A run woken by cron, launchd or a webhook has no terminal, and it doesn't need one. Its TUI agents
open as they always do, in the Herdr session named `awf`, which awf starts headless when it isn't
running. So the sample's codex agent keeps its default placement, a TUI in a Herdr pane, and you can watch a woken run's agents
from any terminal:

```sh
HERDR_DISABLE_SOUND=1 herdr session attach awf
```

The one requirement is that `herdr` is on the run's `PATH`, as the harnesses are (see the catches
below). [Harnesses](/guide/harnesses#where-panes-go) covers panes and placement.

## Catches

- **A woken run doesn't get your shell's environment.** Its process gets the `PATH` recorded when
  the run was made, a few plain variables such as `HOME` and `LANG`, and the project's `.env`. A
  token exported in your shell never reaches a run cron wakes; put it in the project's `.env`.
- **The `PATH` that sticks is the first sender's.** A run made by an event records the sender's
  `PATH`, and every attempt after uses it to find `claude` or `codex`. A webhook or CI job with a
  short `PATH` makes runs that can't find their harnesses or `herdr`: give it a `PATH` that holds
  them.
- **A failing run gets two more tries, then stops.** After a crash or a failure, the next tick or
  event continues it; the third failure in a row leaves it `stuck`, and nothing wakes it again.
  `awf logs` says why it failed; once it's fixed, `awf runs {run}` says what to run next.
- **A stopped or cancelled run stays that way.** Neither a tick nor an event continues it; you do,
  as [Runs](/guide/runs) shows.
- **A workflow that polls on a schedule is a plain run.** Nothing keeps two of its runs from
  overlapping, so give it a schedule longer than it takes.

## See also

- [Events](/guide/events): the workflows these commands wake, their mailbox, timers and waits.
- [Durability](/guide/durability): what a continue reuses and redoes.
- [Following runs](/guide/following-runs): `awf runs` and `awf logs`.
- [Workflow API: Events](/reference/workflow-api#events): `wf.emit`, `awf tick` and parking, in full.
