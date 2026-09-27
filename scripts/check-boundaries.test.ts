import { afterAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { boundaryProblems } from "./check-boundaries";

const root = mkdtempSync(join(tmpdir(), "wf-boundaries-"));
afterAll(() => rm(root, { recursive: true, force: true }));

async function write(files: Record<string, string>): Promise<void> {
  for (const [path, contents] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), contents);
  }
}

const manifest = (name: string, ...dependencies: string[]) =>
  JSON.stringify({
    name,
    dependencies: Object.fromEntries(dependencies.map((dependency) => [dependency, "*"])),
  });

test("sandbox providers stay behind the seam and the composition root", async () => {
  await write({
    "packages/harness/package.json": manifest("@wf/harness", "@wf/sandbox"),
    "packages/harness/src/adapter.ts": 'import "@wf/sandbox";\nimport "@wf/sandbox/srt";\n',
    "packages/engine/package.json": manifest("@wf/engine", "@wf/sandbox"),
    "packages/engine/src/runner.ts": 'import "@wf/sandbox/docker";\n',
    "packages/engine/src/operator-runtime.ts": 'import "@wf/sandbox/srt";\n',
    "packages/engine/src/runner.test.ts": 'import "@wf/sandbox/testing";\n',
    "packages/sandbox/package.json": manifest("@wf/sandbox", "@wf/harness"),
    "packages/sandbox/src/seam.ts": 'import "@wf/harness";\n',
    "packages/sandbox/src/srt/index.ts": 'import "../seam";\nimport "../docker/index";\n',
    "packages/sandbox/src/docker/index.ts": 'import "@wf/sandbox/srt";\n',
    "packages/sandbox/src/testing/index.ts": 'import "../seam";\nimport "../srt/index";\n',
    "packages/sandbox/src/resolve.ts": 'import "./seam";\nimport "./docker";\n',
    "packages/sandbox/src/lima/provider.ts": 'import "../docker";\n',
    "packages/sandbox/src/srt/srt.test.ts": 'import "../testing";\nimport "../docker";\n',
    "packages/harness/src/adapter.test.ts":
      'import "@wf/sandbox/testing";\nimport "@wf/sandbox/srt";\n',
    "packages/engine/src/testing-in-production.ts": 'import "@wf/sandbox/testing";\n',
  });
  const found = (await boundaryProblems(root)).filter((problem) => !problem.includes("stale"));
  expect(found).toEqual([
    "packages/engine/src/runner.ts: imports @wf/sandbox/docker — only operator-runtime.ts imports a sandbox provider",
    "packages/engine/src/testing-in-production.ts: imports @wf/sandbox/testing — only operator-runtime.ts imports a sandbox provider",
    "packages/harness/src/adapter.test.ts: imports @wf/sandbox/srt — harness knows the sandbox seam, never a provider",
    "packages/harness/src/adapter.ts: imports @wf/sandbox/srt — harness knows the sandbox seam, never a provider",
    "packages/sandbox/src/docker/index.ts: imports @wf/sandbox/srt — a provider imports the seam by path, not a sibling",
    "packages/sandbox/src/docker/index.ts: imports @wf/sandbox/srt, which packages/sandbox may not depend on",
    "packages/sandbox/src/lima/provider.ts: path import ../docker reaches what packages/sandbox/src/lima may not",
    "packages/sandbox/src/resolve.ts: path import ./docker reaches what packages/sandbox/src may not",
    "packages/sandbox/src/seam.ts: imports @wf/harness — the sandbox package imports contract only",
    "packages/sandbox/src/srt/index.ts: path import ../docker/index reaches what packages/sandbox/src/srt may not",
    "packages/sandbox/src/srt/srt.test.ts: path import ../docker reaches what packages/sandbox/src/srt may not",
    "packages/sandbox/src/testing/index.ts: path import ../srt/index reaches what packages/sandbox/src/testing may not",
  ]);
});
