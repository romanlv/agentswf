import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Glob } from "bun";
import {
  allowsComputedWorkflowImport,
  escapedPathImport,
  WORKSPACE_MANIFEST_GLOBS,
} from "./boundary-paths";

describe("boundary path resolution", () => {
  test("distinguishes internal imports from relative, absolute and file-URL escapes", () => {
    const packageDirectory = "/repo/packages/wf";
    const source = join(packageDirectory, "src/cli.ts");
    const escaped = "/repo/packages/engine/src/run-dir";

    expect(escapedPathImport(packageDirectory, source, "./client")).toBeNull();
    expect(escapedPathImport(packageDirectory, source, "@agentswf/contract")).toBeNull();
    expect(escapedPathImport(packageDirectory, source, "../../engine/src/run-dir")).toBe(escaped);
    expect(escapedPathImport(packageDirectory, source, escaped)).toBe(escaped);
    expect(escapedPathImport(packageDirectory, source, `file://${escaped}`)).toBe(escaped);
  });

  test("the dependency scan includes the top-level examples package", async () => {
    const manifests: string[] = [];
    for (const pattern of WORKSPACE_MANIFEST_GLOBS) {
      for await (const manifest of new Glob(pattern).scan({ cwd: `${import.meta.dir}/..` })) {
        manifests.push(manifest);
      }
    }
    expect(manifests).toContain("examples/package.json");
  });

  test("only the audited operator loader may import a user-selected workflow", () => {
    expect(allowsComputedWorkflowImport("packages/engine/src/workflow-loader.ts")).toBe(true);
    expect(allowsComputedWorkflowImport("packages/lab/src/review/lab/load.ts")).toBe(true);
    expect(allowsComputedWorkflowImport("packages/lab/src/review/lab/cli.ts")).toBe(false);
    expect(allowsComputedWorkflowImport("packages/engine/src/operator-cli.ts")).toBe(false);
    expect(allowsComputedWorkflowImport("examples/minimum-review/review-loop.ts")).toBe(false);
  });
});
