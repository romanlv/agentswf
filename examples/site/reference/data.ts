import { typed } from "agentswf/typebox";
import { defineWorkflow } from "agentswf/workflow";
import Type from "typebox";

export const START = typed(
  Type.Object({ a: Type.Integer(), b: Type.Integer() }, { additionalProperties: false }),
);
export const GO = typed(Type.Object({ add: Type.Integer() }, { additionalProperties: false }));
export const ANSWER = typed(
  Type.Object({ answer: Type.Integer() }, { additionalProperties: false }),
);
export const NUMBER = typed(Type.Union([Type.Integer(), Type.Null()]));

// #region tour
export default defineWorkflow({
  meta: { name: "tour", description: "A stage, a park, a wake, a stage." },
  file: import.meta.path,
  events: { "tour.start": START, "tour.go": GO },
  starts: ["tour.start"],
  async run(wf) {
    if (wf.started?.name !== "tour.start") return wf.stop("send tour.start");
    const { a, b } = wf.started.data;
    const solver = await wf.agents.open({ key: "solver", runtime: "codex" });
    const first = await wf.stage("first", { result: NUMBER }, async () => {
      const { outcome } = await solver.run({
        prompt: `What is ${a} multiplied by ${b}?`,
        schema: ANSWER,
      });
      return outcome.answered ? outcome.value.answer : null;
    });
    const next = await wf.race(
      "wait",
      { go: wf.signal("tour.go"), wake: wf.timer("wake", "20s") },
      { label: "waiting for go or 20s" },
    );
    const add = next.go ? next.go.data.add : 9;
    const second = await wf.stage("second", { result: NUMBER }, async () => {
      const { outcome } = await solver.run({
        prompt: `Add ${add} to the number you gave in your last answer.`,
        schema: ANSWER,
      });
      return outcome.answered ? outcome.value.answer : null;
    });
    return { first, second };
  },
});
// #endregion tour
