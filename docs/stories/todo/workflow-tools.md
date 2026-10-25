---
title: Tools an agent calls, handled by the workflow's code
type: story
status: todo
priority: P2
epic: authoring
discovered_in: "workflow-signals, 2026-10-24: an agent ending the loop it runs in"
depends_on: ["034"]
---

# Tools an agent calls, handled by the workflow's code

A workflow gives an agent named, typed tools, and each call runs a handler in the workflow's code,
whose return value is the tool's result.

Why it matters: an agent reaches the workflow's code today only by finishing a turn with a result.
Mid-turn, it can message other participants, but it can't tell its own workflow anything. The
datadog-watcher's investigator has to close a case by writing `verdict.json` for the tick to
notice. A generic `wf signal {name} {json}` was considered and left out of [[034-event-driven-runs|story 034]]: a
tool is the same reach with a name, a description and a schema the agent sees, a result it gets
back, and a handler that decides what the call means. Holding the tool is the permission, so no
grant is needed.

```ts
const investigator = await workflow.agents.open({
  key: "investigator",
  tools: {
    close_case: {
      description: "Close this case when the engineer says it's done, or that it's noise.",
      input: Type.Object({ status: Type.Union([Type.Literal("closed"), Type.Literal("noise")]), why: Type.String() }),
      handler: async ({ status, why }, call) => {
        await workflow.emit("dd.closed", { case: workflow.key, status, why, by: "thread" }, { id: call.id.toLowerCase() });
        return "Closed. Reply in one line, then end your turn.";
      },
    },
  },
});
```

Notes:
- **A handler emits to its own run.** `workflow.emit(name, data, { id })` with no target appends to
  the run's own mailbox (story 034's); 034 leaves this form to this story, its only user. The id is
  the tool call's, so a call handled twice lands once; an event whose `key(e)` isn't `workflow.key`
  is an error. A tool call's id becomes an event id, so it must fit 034's id grammar (lowercase
  `[a-z0-9][a-z0-9._@-]*`); the handler derives one.
- **How the agent calls it.** Either an MCP server awf runs for the agent, so the harness shows
  the tools natively with their schemas (claude, codex and cursor take MCP; pi to check), or
  `wf tool {name} '{json}'` over the agent's wire, taught by its prompt, which works everywhere.
  Possibly MCP where the harness has it and `wf tool` as the fallback.
- **A handler runs during the agent's turn,** while the agent waits for the result. It must be
  short and bounded, and it can't give the same agent a turn, since that agent refuses other work
  while its turn runs. Emitting an event to its own run is how to start work after the turn.
- **Recorded** like a message: the call, its input, the result, and how long the handler took.
- **Permissions.** `docs/design/permissions.md` plans `use` for tools and MCP servers an agent is
  handed; tools from the workflow are a kind of those, and the grammar for `CapabilityRef` waits
  on two adapters.
- **Testing:** a scripted agent calls a tool, and the test sees the handler's effect and result.
