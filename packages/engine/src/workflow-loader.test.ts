import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as workflowSurface from "@agentswf/contract/workflow";
import * as typebox from "typebox";
import * as typeboxValue from "typebox/value";
import { loadWorkflowFile } from "./workflow-loader";

const folders: string[] = [];

afterAll(async () => {
  await Promise.all(folders.map((folder) => rm(folder, { recursive: true, force: true })));
});

test("a workflow in a folder with no node_modules gets the engine's author surface", async () => {
  const folder = await mkdtemp(join(tmpdir(), "awf-surface-"));
  folders.push(folder);
  const file = join(folder, "x.ts");
  await writeFile(
    file,
    `import { defineExecutableWorkflow } from "agentswf/workflow";
import TypeDefault, { Type } from "typebox";
import { Value } from "typebox/value";

globalThis.surfaceProbe = { defineExecutableWorkflow, Type, TypeDefault, Value };

export default defineExecutableWorkflow({
  definition: {
    meta: { name: "outside", description: "A workflow outside the repository." },
    run: async () => Value.Check(Type.String(), "ok"),
  },
  prepare: () => ({}),
});
`,
  );

  const loaded = await loadWorkflowFile("x.ts", folder);

  expect(loaded.executable.definition.meta.name).toBe("outside");
  const surface = (globalThis as { surfaceProbe?: Record<string, unknown> }).surfaceProbe;
  expect(surface?.defineExecutableWorkflow).toBe(workflowSurface.defineExecutableWorkflow);
  expect(surface?.Type).toBe(typebox.Type);
  expect(surface?.TypeDefault).toBe(typebox.default);
  expect(surface?.Value).toBe(typeboxValue.Value);
});
