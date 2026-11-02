---
title: Plan, implement, review
description: "A ticket from plan to approved change, each step a stage: a planner writes the ticket doc, a reviewer on another model gates it, an implementer builds it, and the reviewer gates that too."
---

# Plan, implement, review

**The problem:** take a ticket to a reviewed change, with a plan checked before any code is
written, and pick up where it stopped when a step fails, without redoing the steps that worked.

**The workflow:**
[`examples/feature-delivery`](https://github.com/romanlv/agentswf/tree/main/examples/feature-delivery).
Five [stages](/guide/runs), one after the other:

| Stage | Who | What |
| --- | --- | --- |
| `ticket-doc` | planner, claude | writes an implementation-ready ticket doc, with a skill that says what one holds |
| `doc-review` | reviewer, codex | gates the doc; asks the planner for each revision by message |
| `implementation` | implementer, codex | builds the change from the doc, and records decisions in it |
| `implementation-review` | reviewer | gates the change the same way |
| `additional-review` | one per `--reviewer` | more reviewers at once; the implementer fixes what they ask, and the reviewer checks again |

It needs claude and codex logged in, and Herdr, since the planner and the
implementer run in panes; [Install](/guide/install) has both. From a clone of the repository,
after `bun install`, with `--cwd` at the repository the ticket is for:

```sh
bun awf run --cwd ../my-app --run-root ~/awf-runs examples/feature-delivery/workflow.ts -- ABC-1
bun awf run --cwd ../my-app --run-root ~/awf-runs examples/feature-delivery/workflow.ts --id ABC-1 --continue
```

`--revisions {n}` bounds each review's revisions, 3 by default, and `--reviewer {name}={runtime}`,
given once per reviewer, adds an additional reviewer: `--reviewer security=claude`. The
workflow's `id: (args) => args.ticket` names the run after the ticket, so the continue finds it
with `--id ABC-1`.

<!-- TODO(operator): record a run -->
**Cost and time:** not recorded yet. They come from a recorded run of the example, priced at list
prices; [Cost](/guide/cost) has where an estimate comes from.

## The workflow

<<< @/../examples/feature-delivery/workflow.ts#workflow

`planner`, `reviewer` and `team.implementer()` come from `team.ts`; each is a small wrapper from
`session.ts` whose `ask` returns the typed answer or stops the run, and whose `stop` names the
agent in the reason. `md` and `list`, from `prompt.ts`, write a prompt inline.

The review loop it runs at each gate:

<<< @/../examples/feature-delivery/reviews.ts#loop

The rest is in the folder: `cli.ts` reads the arguments and `schema.ts` holds the answers'
schemas. Its
[test](https://github.com/romanlv/agentswf/blob/main/examples/feature-delivery/workflow.test.ts)
covers a full run, each kind of stop, and continues.

## Why it's shaped this way

- **Each step is a stage, and its value is what the next steps need.** A stage records its value
  when it succeeds, and `--continue` reuses it, so a stop in `implementation-review` keeps the
  plan and the build. The continue opens fresh agents, so every prompt says everything its agent
  needs: the ticket, the doc's path, what the author said it did. Nothing depends on an agent
  remembering an earlier attempt. [Durability](/guide/durability) has how a continue works.
- **The plan is reviewed before code exists.** A wrong plan caught in `doc-review` costs one
  planner revision; caught after implementation, it costs the build. The implementer isn't even
  opened until the plan is approved.
- **The ticket doc is the record.** The planner writes it, the implementer keeps it current with
  each decision, and both reviews read it. An author whose answer names a different doc stops the
  run, so the record can't drift to another file.
- **The reviewer is on another model.** `team.ts` refuses a planner and reviewer on the same
  model, so the gate doesn't share the author's blind spots.
- **The reviewer owns the revisions.** It messages the author each change it needs and reviews the
  revision it gets back, up to `--revisions` of them: the [review loop](/patterns/review-loop),
  inside a stage, so its route ends with the stage. The reviewer runs headless because a codex
  in a pane can't wait for a reply.
- **After approval, the author reports the work once more.** Code can't read the revisions that
  happened in messages, so the stage's value comes from one more author turn, after review.
- **Every way of not finishing stops the run with a reason.** No answer, an inconclusive review,
  or changes still asked for when the revisions run out each end the attempt `stopped`, naming
  who stopped it and why, ready for a person and a continue. A stop exits 3:
  [Runs](/guide/runs) has the exit codes.

## Catches

- **The prompt names only the ticket.** The planner needs a way to read it: a file in the
  repository, or a tracker its tools reach.
- **Keep the run's records outside the repository.** The planner's skill is copied into the
  run's records, and claude takes no skill from inside its working directory, so `--run-root`
  points elsewhere. Give the same `--run-root` to the continue, so it finds the run.
- **A continue redoes the whole stage that stopped,** a review loop included, from its first
  round.
- **The bound is on revisions, not time.** Give the run a deadline with `--timeout` when it
  shouldn't run longer than you'd wait: [Timeouts](/guide/timeouts).

## See also

- [Stages](/reference/workflow-api#stages) and [Messaging](/reference/workflow-api#messaging) in
  the workflow API.
- [Runs](/guide/runs) and [Durability](/guide/durability) in the guide.
