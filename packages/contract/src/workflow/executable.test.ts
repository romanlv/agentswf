import { expect, test } from "bun:test";
import { defineWorkflow, isEventWorkflow } from "./executable";

test("a workflow without prepare takes no arguments: null, and argv refused", () => {
  const workflow = defineWorkflow({
    meta: { name: "plain", description: "No arguments." },
    run: async () => null,
  });
  expect(workflow.prepare({ argv: [], cwd: "." })).toBeNull();
  expect(() => workflow.prepare({ argv: ["x"], cwd: "." })).toThrow("takes no arguments, not x");
  expect(isEventWorkflow(workflow)).toBe(false);
});
