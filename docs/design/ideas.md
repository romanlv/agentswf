# Ideas

Raw notes on where awf could go. Not scope and not decisions: [`foundation.md`](../foundation.md)
§7 gives each one a home, and §10 says what has to happen before it is built. An idea that became
a story or a todo leaves this page.

## Agents

- **Fork by summary.** Fork a session through a compaction, leaving the original intact: for
  extra agents, extra work, or a side quest that may or may not be used. Today's fork copies the
  session whole (ADR 0009).
- **Harness hooks as events.** A harness's own hooks feed the workflow, so the code reacts to what
  an agent does while it keeps working; part of the event-driven design.
- teleport to a specific session from workflow, to be able to explore or drive it manually

## Subscriptions

- Switch an agent to another account or token when a plan runs out, instead of waiting for the
  reset. `awf allowance` reads what is left (story 022).

## Evaluation and self-improvement

- **Evals / autoresearch engine.** Given enough data, a sandbox and some freedom, iterate on the
  variables to create better, faster and cheaper workflows. Autoresearch lives in this repository
  ([ADR 0002](../adr/0002-autoresearch-lives-here.md)).
- **Self-improving.** Figure out how it works in the Hermes agent.
- **Self-fixing.** Run workflows with another agent watching, making changes and improvements.
- **awf powered by awf.**
- **Workflow stats.** Running and testing workflows as everyday work: an idea to improve one is
  tried against a baseline, every run recorded and compared, and the case becomes a future test
  case for the eval. An optimizer, GEPA style.

## Collaboration strategies

Different ways to share information and decide: a trial with one judge and a prosecutor, three
judges in a quick trial, a company meeting. Abstractions from real life as inspiration for how
agents collaborate.

## Building blocks

Instead of predefined components, documented logical blocks tied to the stable core API, which
evolve on their own: templates installed and modified locally, like shadcn components. Related to
collaboration strategies.

## Recipes

Common use cases and how to build them:

- An agent that watches a workflow and fixes it.
- **Review and fix**, kept as a skill (`/reviewfix`, `/reviewfix-fork`): review and fix the
  current branch, configurable by harness and model, lenses, a time and cost budget; sweep
  existing code and features; file further bugs as todos.
- Integrations with other systems: patterns or boilerplates, most likely not a component.

## Memory

Self-documenting and self-cleaning; maybe some kind of skills for now.

## Events and state

- **State storage connectors.** State lives in files in a fixed format; connectors could store it
  anywhere ([[workflow-state]]).
- **A workflow as a state machine or graph.**
- From LangGraph and Mastra, read against the event-driven style comparison
  ([`workflow-styles.md`](../research/workflow-styles.md), 2026-10-24):
  - **Reducers per event.** LangGraph declares how each update folds into state
    (`comments: append`, `green: last`). A workflow could declare it once per event name, instead
    of folding events by hand in every loop.
  - **The run as a picture.** LangGraph's current node answers "where is it now". awf could draw a
    run's stages and waits, and mark where it is, for debugging and `awf runs`.
  - **Typed waits in both directions.** Mastra's `suspendSchema` says what a wait shows, and its
    `resumeSchema` what it accepts. A wait's label and its event schema are the same pair.
- **Observing agents talking to each other.** Agent-to-agent messages are not events the workflow
  code sees. A route could opt in to being observed (`messages.allow({ between, observe: true })`),
  giving the code a copy (`reviewer:sent`) while the message still goes straight to the other
  agent. A copy only: code in the path is a router, which a participant that goes to the code
  already is. Useful for limiting a debate to N rounds, reacting to "pass" before the turn ends,
  collaboration strategies that enforce who speaks when, and an audit trail. Nothing needs it yet
  (2026-10-25).
- **A workflow router.** One interface that routes signals and events to the right workflow, like
  OpenClaw.
- **A scheduler.** A system service that watches running workflows, wakes those due, and shares
  out tokens and budget. `awf tick` wakes what is due today; [[workflow-schedules]] is the next
  step.
- **Ready for loops.** First-class support for loop graphs.

## Markdown linting and schema

A separate package or tool: define a schema for Markdown files (required sections and/or
frontmatter) and a linter that validates whether a file qualifies. Workflows could build agents or
prompts on it — review lenses, for example.

- A follow-up could be an Obsidian plugin that validates doc edits against the schema and gives
  feedback.
- The schema can define how a Markdown file serializes to JSON, so it becomes input for code and
  stays editable by hand.

## Browser use

A self-developing workflow: one agent builds a CLI for an app, and it is available to other
agents; when it fails, a developer agent picks it up, investigates and improves it.

## Debugging and observability

Seeing each agent's trace and thinking, as observability products show who called whom and where
the time went. Story 030 drafts the OTel export.

## Use cases

- **A plan becomes a workflow.** Research and investigation end in a todo plan, which can become a
  workflow while staying a Markdown file: linted and dissected into JSON that feeds the workflow. A
  good template for the work or the ticket is golden, worth figuring out and sharing.
- **Chat to workflow.** Describe a workflow in Markdown, an agent clarifies it with you and
  codifies it; when the doc changes, the diff is applied back to the code.

## Writing

What to write online: lessons learned, use cases of awf, experiments, guides and concepts, some
from the stories built, some from the vision.

- A review loop with awf.
- Finding an efficient workflow for a task, such as code review.
- Why: repeatable, reliable workflows that are also cheap and fast; working with agents at scale;
  trying agent organization patterns without losing your sanity orchestrating them; testing
  harnesses and skills; knowing which tools work for your domain.
