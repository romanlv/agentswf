import { expect, test } from "bun:test";
import { defineExecutableWorkflow } from "./executable";

test("a workflow without prepare takes no arguments: null, and argv refused", () => {
  const workflow = defineExecutableWorkflow({
    definition: { meta: { name: "plain", description: "No arguments." }, run: async () => null },
  });
  expect(workflow.prepare({ argv: [], cwd: "." })).toBeNull();
  expect(() => workflow.prepare({ argv: ["x"], cwd: "." })).toThrow("takes no arguments, not x");
});
