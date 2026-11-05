---
title: Programs
description: "Drive a workflow's runs from your own Bun program, typed from the workflow: emit its events from a webhook, relay what its runs post, start a run with args and wait for it."
---

# Programs

A webhook handler, a chat bot or a release script reaches a workflow's runs through
`agentswf/client`, in its own process: no `awf` command per call, no JSON to build, and `tsc`
checks every call against the workflow you import.

```ts
import { client } from "agentswf/client";
import review from "./pr-review";

const runs = client();
await runs.emit(review, "pr-7", "pr.pushed", { sha: "abc123", branch: "fix-login" });
```

`tsc` refuses an event name the workflow doesn't declare, data its schema refuses, and args its
`prepare` doesn't return.

## Where the program runs

The program is a client of the run's files on this machine. A run it starts or wakes runs as every
[event run](/guide/hosting-events) does: in a process of its own, in the workflow's project, after
the program has moved on or exited. So the program runs where you would type `awf`:

- On the machine and as the user whose runs these are, with the same `HOME`, and a `PATH` that
  holds what [Install](/guide/install) lists for your harnesses. Not in a serverless function.
- With Bun. The client is Bun-only, as awf is.
- In a project whose `agentswf` is installed: that is the engine every run of the project runs on,
  and the client refuses a project at another version than its own, or with none installed.

The workflow gives `file: import.meta.path`, by which the client finds its project, and is its
file's default export, as `awf` loads it. A workflow without `file` doesn't compile as an
argument; one its file doesn't export as its default throws a `ClientError` with code `file`.

## A webhook

The workflow reviews a pull request at each push, posts each review to a thread, and returns when
the pull request closes:

<<< @/../examples/site/guide/programs/pr-review.ts#workflow

The handler takes the client as a parameter, so its test can pass a fake:

<<< @/../examples/site/guide/programs/handlers.driver.ts#webhook

The first push starts the PR's run; each later one wakes it. `emit` returns what became of the
event, as `awf emit --json` prints it: `accepted`, `duplicate` or `refused`, and what was done to
the run: `started`, `nudged`, `continued`, or `none` with why. `ok` says whether the run has the
event and needs no one: it is false for a `refused` event, and for a run not woken because its launch
failed (`launch-failed`) or the operator's turn has come (`stuck`, `stopped`, `cancelled`). When
the run takes the event is the workflow's: an event its wait doesn't take yet, `nothing-due`, is
`ok`. A launch that failed is a result, not a throw: the event is kept, and the next event, the
same event resent, or `awf tick` tries again.

`eventId` names the occurrence, so a resent delivery is a `duplicate` and never reviewed twice.
An event id is lowercase letters, digits, `.`, `_`, `@` and `-`, and never starts `awf.`; a
foreign id that doesn't fit is hashed:

<<< @/../examples/site/guide/programs/handlers.driver.ts#ids

`source` names the integration that sent the event; the event a wait returns carries it.

Answer the webhook first. An emit that starts or continues a run waits until its attempt has
started, a Bun start and a workflow load, which can take seconds:

<<< @/../examples/site/guide/programs/handlers.driver.ts#serve

What comes of the emit after the answer can only be logged: a launch that failed is retried by
the next event or by [`awf tick`](/guide/hosting-events), which needs a schedule, but a refused
event is lost, as GitHub won't send it again. Verifying that a request came from GitHub is the
program's job, with the webhook's secret; awf trusts whatever the program sends.

## Relaying what runs say

<<< @/../examples/site/guide/programs/handlers.driver.ts#relay

`inbox` lists what the workflow's runs posted and asked, oldest first, as `awf inbox --workflow --json`
does. Each item carries a cursor; pass the last one to the next read, and each item is relayed
once, or again if a post in its batch throws.
Keep the cursor where a restart finds it, or a restarted program relays everything again.
`onThreadReply` sends a person's answer back as the thread's `thread:reply`, which the workflow
declares. A reply goes to a run that is there and never starts one: to an id with no run, `emit`
throws `no-run`.

## Starting a run and waiting for it

`start` takes the args `prepare` would return, and makes sure the run exists and has been
launched:

<<< @/../examples/site/guide/programs/handlers.driver.ts#script

`ok` is true when it `started` the run or found it `exists`; false when its launch failed,
`launch-failed`, with the attempt's `error`, or it is `stuck`. The run records its args, and every
attempt runs with them; `prepare` never runs for it. `start`
of an id already there with the same args is `exists`; with other args, or of a run an event or
`awf run` began, it throws `other-args`. Without `id`, the workflow's `id(args)` names the run, or
a new id does; a workflow with `starts` and no `id(args)` is named by its senders, so `start`
without `id` throws `no-id`.

A `Run` is read from the run's files whenever asked. `status()` says its state and whether it is
`final`: nothing will continue it on its own. `wait()` resolves at the run's next rest, when it
ends, parks or crashes, or at once if it isn't running; `wait({ final: true })` at the first rest
that is final. Bound a final
wait with a `signal`: an event run that failed is continued only by its next event or
`awf tick`, and with neither, the wait waits on. `get(workflow, id)` reaches a run another
program started.

A plain run that failed is `final`. [`awf run {file} --id {id} --continue`](/guide/runs)
continues it, from anywhere: a workflow that gives `file` keeps its runs in its project.

## Testing a program

`agentswf/testing`'s `fakeClient()` is a `Client` that keeps the calls it is given, runs the real
client's checks that need no files, and answers as the real one's rules do (a resent event id is a `duplicate`, a
run whose launch failed is kept), or as the test scripts:

<<< @/../examples/site/guide/programs/handlers.test.ts#test

## Catches

- **A run's questions to a person are answered from a shell.** A run started from code has no
  terminal: what its agents ask shows in `inbox()` and `awf inbox`, and a person answers with
  [`awf reply`](/guide/people). Until then the run waits, as long as the question's timeout allows.
- **A redeployed workflow needs the program restarted.** The program checks events against the
  workflow it imported; the run's attempt loads the file as it is now, and may refuse data the old
  schema took.
- **No stop yet.** awf has no command that stops a run, and the client none either.
- **One engine per project.** Update the project's `agentswf` and the program's together; see
  [Install](/guide/install#updating).

## See also

- [Hosting events](/guide/hosting-events): the same runs, woken by `awf emit` and `awf tick`.
- [Events](/guide/events): declaring a workflow's events, `starts` and `file`.
- [Testing API](/reference/testing-api#fakeclient): `fakeClient`'s script and its calls.
