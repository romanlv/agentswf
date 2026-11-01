import { defineWorkflow, isAnswered, type OutputSchema } from "@agentswf/contract/workflow";
import Type from "typebox";

// #region schemas
const Failed = Type.Object(
  { pr: Type.Number(), job: Type.String(), url: Type.String() },
  { additionalProperties: false },
);
// Typed, so an event's data is typed where the workflow takes it and where a sender sends it.
export const FAILED: OutputSchema<Type.Static<typeof Failed>> = Failed;
// #endregion schemas
const Closed = Type.Object(
  { pr: Type.Number(), merged: Type.Boolean() },
  { additionalProperties: false },
);
export const CLOSED: OutputSchema<Type.Static<typeof Closed>> = Closed;
export const FIX = Type.Object({ commit: Type.String() }, { additionalProperties: false });

// #region workflow
export default defineWorkflow({
  meta: { name: "ci-fix", description: "Fix a pull request's failing CI until it closes." },
  file: import.meta.path, // where senders find the workflow, and its runs live
  events: { "ci.failed": FAILED, "pr.closed": CLOSED }, // a schema per event
  starts: ["ci.failed"], // the events that may start a run
  async run(wf) {
    const fixer = await wf.agents.open({ key: "fixer", runtime: "claude" });
    for (;;) {
      const events = await wf.receive({ label: `waiting on CI for #${wf.runId}` });
      let latest: { id: string; job: string; url: string } | undefined;
      for (const e of events) {
        if (e.name === "pr.closed") return { pr: e.data.pr, merged: e.data.merged };
        // Several failures in one batch: only the latest needs a fix.
        if (e.name === "ci.failed") latest = { id: e.id, job: e.data.job, url: e.data.url };
      }
      if (!latest) continue;
      const { id, job, url } = latest;
      await wf.stage(`fix-${id}`, async () => {
        const { outcome } = await fixer.run<Type.Static<typeof FIX>>({
          prompt: `CI job ${job} failed on this pull request: ${url}. Fix it, commit and push.`,
          schema: FIX,
        });
        if (isAnswered(outcome)) wf.log("pushed a fix", { commit: outcome.value.commit });
        else wf.log("no fix", { reason: outcome.reason });
      });
    }
  },
});
// #endregion workflow

export const ciFixBySelect = defineWorkflow({
  meta: { name: "ci-fix-select", description: "The same loop, one event at a time." },
  file: import.meta.path,
  events: { "ci.failed": FAILED, "pr.closed": CLOSED },
  starts: ["ci.failed"],
  async run(wf) {
    const fixer = await wf.agents.open({ key: "fixer", runtime: "claude" });
    // #region select
    for await (const next of wf.select(
      { failed: wf.signal("ci.failed"), closed: wf.signal("pr.closed") },
      { label: `waiting on CI for #${wf.runId}` },
    )) {
      if (next.closed) return { pr: next.closed.data.pr, merged: next.closed.data.merged };
      if (next.failed) {
        const { job, url } = next.failed.data;
        await wf.stage(`fix-${next.failed.id}`, async () => {
          await fixer.run({ prompt: `CI job ${job} failed: ${url}. Fix it, commit and push.` });
        });
      }
    }
    // #endregion select
    return null;
  },
});
