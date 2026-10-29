import { expect, test } from "bun:test";
import {
  defineExecutableWorkflow,
  defineWorkflow,
  isEventWorkflow,
  WORKFLOW_KIND,
} from "./executable";

test("a workflow without prepare takes no arguments: null, and argv refused", () => {
  const workflow = defineWorkflow({
    meta: { name: "plain", description: "No arguments." },
    run: async () => null,
  });
  expect(workflow.prepare({ argv: [], cwd: "." })).toBeNull();
  expect(() => workflow.prepare({ argv: ["x"], cwd: "." })).toThrow("takes no arguments, not x");
  expect(isEventWorkflow(workflow)).toBe(false);
});

test("defineExecutableWorkflow flattens beta.2's nested definition into a workflow", () => {
  const workflow = defineExecutableWorkflow<{ n: number }, number>({
    definition: {
      meta: { name: "old", description: "Nested." },
      run: async (_, { n }) => n,
    },
    prepare: ({ argv }) => ({ n: argv.length }),
    present: (value) => `${value}`,
  });
  expect(workflow.kind).toBe(WORKFLOW_KIND);
  expect(workflow.meta.name).toBe("old");
  expect(workflow.prepare({ argv: ["a", "b"], cwd: "." })).toEqual({ n: 2 });
  expect(workflow.present?.(2, { kind: "completed", value: 2, stages: [] })).toBe("2");
  expect("definition" in workflow).toBe(false);
});
