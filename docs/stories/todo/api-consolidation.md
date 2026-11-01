---
title: One way to do each thing in the author API
type: story
status: todo
priority: P1
epic: author-api
discovered_in: "a review of the workflow API while running the Datadog watcher, 2026-10-26"
depends_on: ["034"]
---

# One way to do each thing in the author API

awf is a framework for building workflows: what an author must learn is its cost. Investigate
where the author API offers two ways to do one thing, or carries options that belong to the
operator, and propose one surface for each. This story is the investigation and the proposal;
nothing changes before the design is reviewed.

Candidates, worst first, from [`workflow-api.md`](../../workflow-api.md)'s "At a glance":

1. **Two kinds of workflow**, `defineExecutableWorkflow` and `defineEventWorkflow`. Already
   [[034-event-driven-runs|story 034]] task 11; listed so the rest is weighed with it.
2. **Two ways to give an agent a turn.** `agent.run()` is awaited and returns the outcome;
   `agent.start()` is not, and its end comes as `agent:ended` at `receive`. An event workflow's
   agent has both. One turn API: `start()` returns a turn that is either awaited or heard at a
   wait.
3. **Three ways to talk.** `messages.allow` routes between agents; `participants.connect({ key })`
   is a coordinator agents report to; `participants.connect({ key, to: "code" })` is a participant
   whose replies go to the code. One `connect` returns different things by `to`, and what wakes a
   run isn't in its definition (034's Q19). One routing model with a destination may cover all
   three.
4. **The calling session is five calls**: `agents.caller`, `agents.forkCaller`, `agent.fork`,
   `agents.attach` (not in the overview), and `agents.open`. `forkCaller(x)` is
   `caller()?.fork(x)`.
5. **Pane placement in the author API.** `layout` and `keepPane` sit on `open`, `fork` and
   `forkCaller`. Where a pane goes is the operator's choice; a flag or config may hold it.
6. **Model and effort are set in three places**: `open`'s runtime, `agent.set`, and
   `fork({ effort })`.
7. **`testWorkflow`**: two signatures, and an options bag of about twenty fields, several for one
   feature each (`awaitReply`, `compactions`, `participants`, `decisions`, `allowance`).
8. **Smaller**: "label" means four things (`receive`, `agent.run`, `parallel`, participants);
   `wf.decisions` (Jev), a niche provider, sits on the core context; `wf.usage()` and
   `wf.allowance()` are two reads of accounting.
9. **Testing's `reply` means not replying.** `reply.silent()`, `reply.fail()` and the like end a
   scripted turn without an answer, while `event.reply(...)` answers; `message.silent()` and
   `message.fail()` repeat them. One namespace for how a scripted turn ends (`ending.*`, type
   `Ending`) and no duplicates.
10. **`wfa` and `awf` name one state two ways**: `peer-stopped` and `stopped` for the same refusal,
    `awaiting` and `awaiting-reply` for an agent waiting on a reply. `wfa peers` reports an outside
    participant as `state: "outside"`, which is a kind of peer, not a state.
11. **`awf send` is two commands.** Without `--event-id` it messages an agent over a route; with
    it, it is a reply on a participant routed to the code, prints as `awf emit` does, and has its
    own exit codes, which the usage's closing exit-code line then contradicts.
12. **`--continue` beside `--id`.** `awf run --id X` starts a run and `--id X --continue` goes on
    with it; one `--id` meaning "start or go on" would drop the flag, as an event run already does
    on emit. Weigh against an accidental continue of a run meant to be new.
13. **An event workflow differs from a plain one beyond `receive`**: stage reuse (task 11), where
    its runs live (in its project, found from anywhere, while a plain run lives under `--cwd`),
    and a route's `timeoutMs`, which only bounds a question to a participant. Each should follow
    from item 1's answer, not be a rule of its own.
14. **Stopping an agent is two calls**: `agents.stop(key)` and the ref's own; one, on the ref.
15. **Time has several shapes**: `--wait <seconds>`, `--timeout <duration>`, `timeoutMs` and
    `deadline` in the API, `until` as epoch ms or a `Date`. One duration form on the CLI and one
    in the API.
16. **Smaller still**: records say `version` in some places and `v` in others;
    `participants.get` returns agents too; `OutputRecord` has no `ref` while the other records
    do; `TestRun` has accessor pairs for one fact; `EventTestOptions.event.id` and
    `ScriptedEvent.id` are an event's id where the CLI says `--event-id`.

Settled, not a candidate: the run's id is `--id` on the CLI and `runId` in records, concise where
it is typed and explicit in data.

For each, the investigation answers: which workflows in `examples/` and the watcher use each form,
what the merged form would be, and what it would break. Published types are the expensive part
(AGENTS.md): any change to one stops for review.

## Open questions

None yet.
