import { typed } from "agentswf/typebox";
import { defineWorkflow } from "agentswf/workflow";
import Type from "typebox";

const Go = typed(Type.Object({ now: Type.Boolean() }));

export default defineWorkflow({
  meta: { name: "case-fixture-events", description: "A workflow with events." },
  events: { go: Go },
  async run() {
    return null;
  },
});
