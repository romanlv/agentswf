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
    "packages/harness/package.json": manifest("@agentswf/harness", "@agentswf/sandbox"),
    "packages/harness/src/adapter.ts":
      'import "@agentswf/sandbox";\nimport "@agentswf/sandbox/srt";\n',
    "packages/engine/package.json": manifest("@agentswf/engine", "@agentswf/sandbox"),
    "packages/engine/src/runner.ts": 'import "@agentswf/sandbox/docker";\n',
    "packages/engine/src/operator-runtime.ts":
      'import "@agentswf/sandbox/srt";\nimport "./decisions/openrouter";\nimport "./decisions/fake";\n',
    "packages/engine/src/runner.test.ts": 'import "@agentswf/sandbox/testing";\n',
    "packages/sandbox/package.json": manifest("@agentswf/sandbox", "@agentswf/harness"),
    "packages/sandbox/src/seam.ts": 'import "@agentswf/harness";\n',
    "packages/sandbox/src/srt/index.ts": 'import "../seam";\nimport "../docker/index";\n',
    "packages/sandbox/src/docker/index.ts": 'import "@agentswf/sandbox/srt";\n',
    "packages/sandbox/src/testing/index.ts": 'import "../seam";\nimport "../srt/index";\n',
    "packages/sandbox/src/resolve.ts": 'import "./seam";\nimport "./docker";\n',
    "packages/sandbox/src/lima/provider.ts": 'import "../docker";\n',
    "packages/sandbox/src/srt/srt.test.ts": 'import "../testing";\nimport "../docker";\n',
    "packages/harness/src/adapter.test.ts":
      'import "@agentswf/sandbox/testing";\nimport "@agentswf/sandbox/srt";\n',
    "packages/engine/src/testing-in-production.ts": 'import "@agentswf/sandbox/testing";\n',
    "packages/engine/src/decisions/directory.ts": 'import "./openrouter";\nimport "./fake";\n',
    "packages/engine/src/decisions/fake.test.ts": 'import "./fake";\nimport "./openrouter";\n',
    "packages/engine/src/decisions/openrouter.test.ts": 'import "./openrouter";\n',
  });
  const found = (await boundaryProblems(root)).filter((problem) => !problem.includes("stale"));
  expect(found).toEqual([
    "packages/engine/src/decisions/directory.ts: path import ./fake reaches what packages/engine/src may not",
    "packages/engine/src/decisions/directory.ts: path import ./openrouter reaches what packages/engine/src may not",
    "packages/engine/src/decisions/fake.test.ts: path import ./openrouter reaches what packages/engine/src may not",
    "packages/engine/src/operator-runtime.ts: path import ./decisions/fake reaches what packages/engine/src may not",
    "packages/engine/src/runner.ts: imports @agentswf/sandbox/docker — only operator-runtime.ts imports a sandbox provider",
    "packages/engine/src/testing-in-production.ts: imports @agentswf/sandbox/testing — only operator-runtime.ts imports a sandbox provider",
    "packages/harness/src/adapter.test.ts: imports @agentswf/sandbox/srt — harness knows the sandbox seam, never a provider",
    "packages/harness/src/adapter.ts: imports @agentswf/sandbox/srt — harness knows the sandbox seam, never a provider",
    "packages/sandbox/src/docker/index.ts: imports @agentswf/sandbox/srt — a provider imports the seam by path, not a sibling",
    "packages/sandbox/src/docker/index.ts: imports @agentswf/sandbox/srt, which packages/sandbox may not depend on",
    "packages/sandbox/src/lima/provider.ts: path import ../docker reaches what packages/sandbox/src/lima may not",
    "packages/sandbox/src/resolve.ts: path import ./docker reaches what packages/sandbox/src may not",
    "packages/sandbox/src/seam.ts: imports @agentswf/harness — the sandbox package imports contract only",
    "packages/sandbox/src/srt/index.ts: path import ../docker/index reaches what packages/sandbox/src/srt may not",
    "packages/sandbox/src/srt/srt.test.ts: path import ../docker reaches what packages/sandbox/src/srt may not",
    "packages/sandbox/src/testing/index.ts: path import ../srt/index reaches what packages/sandbox/src/testing may not",
  ]);
});

test("a workflow's test installs the fakes, never a provider, and imports no test runner", async () => {
  const at = mkdtempSync(join(tmpdir(), "wf-boundaries-"));
  try {
    for (const [path, contents] of Object.entries({
      "packages/engine/package.json": manifest("@agentswf/engine", "@agentswf/sandbox"),
      "packages/engine/src/workflow-runner.ts": "",
      "packages/engine/src/decisions/fake.ts": "",
      "packages/engine/src/workflow-testing/index.ts":
        'import "@agentswf/sandbox/testing/fake";\nimport "@agentswf/sandbox/testing";\nimport "../workflow-runner";\nimport "@agentswf/sandbox/srt";\nimport "bun:test";\nimport "../decisions/fake";\n',
      "packages/engine/src/workflow-testing/index.test.ts": 'import "bun:test";\n',
    })) {
      await mkdir(dirname(join(at, path)), { recursive: true });
      await writeFile(join(at, path), contents);
    }
    expect((await boundaryProblems(at)).filter((problem) => !problem.includes("stale"))).toEqual([
      "packages/engine/src/workflow-testing/index.ts: imports @agentswf/sandbox/srt — a workflow's test installs the fake sandbox provider, by its own path, never a real one",
      "packages/engine/src/workflow-testing/index.ts: imports @agentswf/sandbox/testing — a workflow's test installs the fake sandbox provider, by its own path, never a real one",
      "packages/engine/src/workflow-testing/index.ts: imports bun:test — a workflow's test helper imports no test runner",
      "packages/engine/src/workflow-testing/index.ts: path import ../decisions/fake reaches what packages/engine/src may not",
    ]);
  } finally {
    await rm(at, { recursive: true, force: true });
  }
});

test("an example's test uses the testing surface, never the engine's internals", async () => {
  const at = mkdtempSync(join(tmpdir(), "wf-boundaries-"));
  try {
    for (const [path, contents] of Object.entries({
      "examples/package.json": manifest(
        "@agentswf/examples",
        "@agentswf/contract",
        "@agentswf/engine",
      ),
      "examples/review/workflow.ts":
        'import "@agentswf/contract/workflow";\nimport "@agentswf/engine/workflow-testing";\n',
      "examples/review/workflow.test.ts":
        'import "bun:test";\nimport "node:fs";\nimport "@agentswf/engine/workflow-testing";\nimport "./workflow";\nimport "@agentswf/engine";\nimport "@agentswf/engine/testing";\nimport "@agentswf/harness";\nimport "../../packages/engine/src/workflow-runner";\n',
    })) {
      await mkdir(dirname(join(at, path)), { recursive: true });
      await writeFile(join(at, path), contents);
    }
    expect((await boundaryProblems(at)).filter((problem) => !problem.includes("stale"))).toEqual([
      "examples/review/workflow.test.ts: imports @agentswf/engine — a workflow's test uses the testing surface, never the engine or a harness",
      "examples/review/workflow.test.ts: imports @agentswf/engine/testing — a workflow's test uses the testing surface, never the engine or a harness",
      "examples/review/workflow.test.ts: imports @agentswf/harness — a workflow's test uses the testing surface, never the engine or a harness",
      "examples/review/workflow.test.ts: imports @agentswf/harness, but @agentswf/examples does not declare @agentswf/harness",
      "examples/review/workflow.test.ts: path import ../../packages/engine/src/workflow-runner escapes examples",
      "examples/review/workflow.ts: imports @agentswf/engine/workflow-testing — a workflow is written against the author surface, never the runtime",
    ]);
  } finally {
    await rm(at, { recursive: true, force: true });
  }
});

test("the review folders import down their order only", async () => {
  const review = "packages/lab/src/review";
  await write({
    "packages/lab/package.json": manifest("@agentswf/lab"),
    [`${review}/index.ts`]: 'import "./build/collect";\n',
    [`${review}/format/format.ts`]: 'import "../fixtures/set";\n',
    [`${review}/fixtures/set.ts`]: 'import "../format/format";\nimport "../build/collect";\n',
    [`${review}/build/collect.ts`]: 'import "../format/format";\nimport "../fixtures/set";\n',
    [`${review}/lab/plan.ts`]: 'import "../metrics/metrics";\nimport "../build/collect";\n',
    [`${review}/metrics/metrics.ts`]: 'import "../format/format";\n',
    [`${review}/misc/helper.ts`]: 'import "../format/format";\n',
    [`${review}/match.ts`]: 'import "./build/collect";\n',
    [`${review}/build/draft-key.ts`]: 'import "./collect";\nimport "../fixtures/set";\n',
    [`${review}/judge/check.ts`]: 'import "../build/collect";\n',
    [`${review}/format/io.ts`]: 'import "node:fs";\n',
  });
  const found = (await boundaryProblems(root)).filter((problem) => problem.includes(review));
  expect(found).toEqual([
    `${review}/fixtures/set.ts: path import ../build/collect reaches what ${review}/fixtures may not`,
    `${review}/format/format.ts: path import ../fixtures/set reaches what ${review}/format may not`,
    `${review}/format/io.ts: imports node:fs — ${review} is pure: no runtime builtins`,
    `${review}/judge/check.ts: path import ../build/collect reaches what ${review}/judge may not`,
    `${review}/lab/plan.ts: path import ../build/collect reaches what ${review}/lab may not`,
    `${review}/match.ts: only the entry sits beside the review folders; move it into one`,
    `${review}/misc: a folder the review layers don't place; add it to REVIEW_LAYERS`,
  ]);
});
