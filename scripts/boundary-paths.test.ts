import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Glob } from "bun";
import {
  allowsComputedWorkflowImport,
  escapedPathImport,
  escapedRelativeImport,
  WORKSPACE_MANIFEST_GLOBS,
} from "./boundary-paths";

describe("boundary path resolution", () => {
  test("distinguishes internal relative imports from cross-package escapes", () => {
    const packageDirectory = "/repo/packages/cli-agent";
    const source = join(packageDirectory, "src/cli.ts");

    expect(escapedRelativeImport(packageDirectory, source, "./client")).toBeNull();
    expect(escapedRelativeImport(packageDirectory, source, "../../engine/src/run-dir")).toBe(
      "/repo/packages/engine/src/run-dir",
    );
  });

  test("detects absolute and file-URL package escapes", () => {
    const source = "/repo/packages/cli-agent/src/cli.ts";
    expect(escapedPathImport("/repo/packages/cli-agent", source, "/repo/packages/engine/src/index.ts"))
      .toBe("/repo/packages/engine/src/index.ts");
    expect(escapedPathImport("/repo/packages/cli-agent", source, "file:///repo/packages/engine/src/index.ts"))
      .toBe("/repo/packages/engine/src/index.ts");
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
    expect(allowsComputedWorkflowImport("packages/engine/src/operator-cli.ts")).toBe(false);
    expect(allowsComputedWorkflowImport("examples/review-loop.ts")).toBe(false);
  });
});
