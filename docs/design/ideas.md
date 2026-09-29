# Ideas

Raw notes on where awf could go. Not scope and not decisions: [`foundation.md`](../foundation.md)
§7 gives each one a home, and §10 says what has to happen before it is built.

## Agents

- **Advanced forking.** Fork a session by creating a summary (compact) without destroying the
  original session. Useful when additional agents or additional work are needed, or for side
  quests that may or may not be used. (§7: no fork in any interface until E7's cost split is
  settled.)
- **Team of agents.** Agents talk to each other, with some checks enforced by the model. The main
  thing: running agents can send messages to each other and wait for responses.
  (§7, [`messaging.md`](messaging.md).)
- **Unified skills and tools.** Agents may be given additional skills or tools, and there should be
  one way to invoke them. Something like `skill:name` is less error-prone than the claude and codex
  versions, which are not the same. (§7: model request-vs-granted first.)
- **Context usage.** Detect when an agent is in the dumb zone: what percentage of its context is
  used so far. (§7: `harness`, beside liveness and usage.)
- Custom skills per agent: a path or a public skill, applied to this agent only, with or without the operator's — drafted as [story 007](../stories/007-agent-skills.md).

## Workflows

- [x] Call workflows from other workflows.
- [ ] Checkpoints: input from the user stops everything until approval is given. (§7: an
  admission barrier, not a signal.)
- [x] Monorepo structure with multiple packages.
- [ ] Modular structure.
- [ ] Observability.
- [x] Cost and timing — [story 002](../stories/002-cost-and-time-accounting.md).
- [ ] Messaging as its own package? (§7 argues it cannot be one package.)
- [x] [Jev](https://typesafe.ai/blog/introducing-system-one-models-and-jev), a model that classifies quickly and cheaply, as a step in a workflow — measured, and drafted as [story 006](../stories/006-typed-decisions.md).

## Evaluation and self-improvement

- **Evals / autoresearch engine.** Given enough data, a sandbox and some freedom, iterate on the
  variables to create better, faster and cheaper workflows. Autoresearch lives in this repository
  ([ADR 0002](../adr/0002-autoresearch-lives-here.md)).
- **Self-improving.** Figure out how it works in the Hermes agent.
- **Self-fixing.** Run workflows with another agent watching, making changes and improvements.
- **awf powered by awf?** That can be quite cool.

## Messaging

Still not sure whether messaging can be its own tool. In theory, ad-hoc workflows can be
implemented with messaging/signalling plus some prompts. Or maybe it is just one of the commands in the toolchain and can be integrated.
## Collaboration strategies
there could be different decisions to try out, like how information is shared, who decides
e.g. it can be a like a trial with one judge, and prosecurtor, 3 judges in quick trial, company meeting etc... 
those abstractions from real life can become inspiration for collaboration strategies

## Building blocks 
Maybe instead of pre-defined components, there should be logical blocks, that are documented and distributed as a complex code, and it's tied to the core api that is stable, but those logical concepts are evolving, they are like templates, like shadcn components, can be installed and modified locally 

and this related to collaboration strategies as well

## Sandboxing

Built for agents: a workflow opens sandboxes and puts agents in them (story 004). Running the
whole workflow in one is still an idea. ([`permissions.md`](permissions.md) has the design.)
%% this is done %%
## Memory

Self-documenting and self-cleaning; maybe some kind of skills for now.

## Events driven 
agent session itself can generate events that other elements of the workflow can react to, so the agent keeps focusing on the task, but other parts of the workflow can be notified, to do other things. 
Ideally it should be a context (meaning triggered) but not sure if it's possible or how to do it

## Resumable workflows 
if workflow died on specific step, it should be able to resume it from that step, without repeating from the start

## Ready for loops 
First class support to integrate with the loops (loop graphs). See where it stands

## Markdown linting and schema

A separate package or tool: define a schema for Markdown files (required sections and/or
frontmatter) and a linter that validates whether a file qualifies. Workflows could build agents or
prompts on it — review lenses, for example.

## Browser use 

self healing or self development workflow, when another agent can create cli to use specific app, and it it's just available for other agents, if it fails, then special developer can pick it up, investigate and self improve  


## Ask question, human approval 
especially for headless agents, there should be a way to ask questions 
terminal based for now, but maybe later hooked to other tools (slack, telegram etc...)

## Debugging and observability 

Being able to see the agents tracing and inspecting thinking trace of each agent 
This actually connects well with observability products, that show who called who and where time was spent in this workflow 
 
