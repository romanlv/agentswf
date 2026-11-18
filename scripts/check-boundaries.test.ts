import { afterAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { boundaryProblems } from "./check-boundaries";

const root = mkdtempSync(join(tmpdir(), "awf-boundaries-"));
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
  const at = mkdtempSync(join(tmpdir(), "awf-boundaries-"));
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

test("an example imports agentswf/workflow and agentswf/typebox, and its test agentswf/testing, as an author's do", async () => {
  const at = mkdtempSync(join(tmpdir(), "awf-boundaries-"));
  try {
    for (const [path, contents] of Object.entries({
      "examples/package.json": manifest("@agentswf/examples", "agentswf", "@agentswf/engine"),
      "examples/review/workflow.ts":
        'import "agentswf/workflow";\nimport "agentswf/typebox";\nimport "agentswf/testing";\nimport "@agentswf/contract/workflow";\nimport "typebox";\n',
      "examples/review/workflow.test.ts":
        'import "bun:test";\nimport "node:fs";\nimport "agentswf/testing";\nimport "agentswf/workflow";\nimport "agentswf/typebox";\nimport "./workflow";\nimport "@agentswf/engine/workflow-testing";\nimport "agentswf";\nimport "../../packages/engine/src/workflow-runner";\n',
    })) {
      await mkdir(dirname(join(at, path)), { recursive: true });
      await writeFile(join(at, path), contents);
    }
    expect((await boundaryProblems(at)).filter((problem) => !problem.includes("stale"))).toEqual([
      "examples/review/workflow.test.ts: imports @agentswf/engine/workflow-testing — a workflow's test uses agentswf/workflow, agentswf/typebox and agentswf/testing alone",
      "examples/review/workflow.test.ts: imports agentswf — a workflow's test uses agentswf/workflow, agentswf/typebox and agentswf/testing alone",
      "examples/review/workflow.test.ts: path import ../../packages/engine/src/workflow-runner escapes examples",
      "examples/review/workflow.ts: imports @agentswf/contract/workflow — a workflow is written against the author surface, agentswf/workflow and agentswf/typebox",
      "examples/review/workflow.ts: imports @agentswf/contract/workflow, but @agentswf/examples does not declare @agentswf/contract",
      "examples/review/workflow.ts: imports agentswf/testing — a workflow is written against the author surface, agentswf/workflow and agentswf/typebox",
    ]);
  } finally {
    await rm(at, { recursive: true, force: true });
  }
});

test("the case kind imports only itself and the shared folder, and names no domain word", async () => {
  const cases = "packages/lab/src/cases";
  const shared = "packages/lab/src/shared";
  await write({
    "packages/lab/package.json": manifest("@agentswf/lab"),
    [`${shared}/runner.ts`]: 'import "node:fs";\n',
    [`${shared}/compare/index.ts`]: "export {};\n",
    [`${shared}/compare/index.test.ts`]: "export {};\n",
    [`${shared}/config.ts`]: 'import "../cases/format/settings";\nimport "node:path";\n',
    [`${cases}/format/settings.ts`]: 'import "../../shared/config";\n',
    [`${cases}/lab/verdict.ts`]:
      'import "../format/settings";\nimport "../../review/format/format";\n',
    [`${cases}/lab/store.ts`]: 'import "node:fs";\n// a mail case, in a comment\n',
    [`${cases}/lab/grade.ts`]: 'export const label = "finding";\n',
    [`${cases}/lab/mailbox.ts`]: "export {};\n",
    [`${cases}/lab/grade.test.ts`]: 'export const fixture = "mail";\n',
  });
  const found = (await boundaryProblems(root)).filter(
    (problem) => problem.includes(cases) || problem.includes(shared),
  );
  expect(found).toEqual([
    `${cases}/lab/grade.ts: names "finding", a word of one workflow's domain; the case kind knows none`,
    `${cases}/lab/mailbox.ts: its name holds a word of one workflow's domain (mail, review, finding)`,
    `${cases}/lab/verdict.ts: names "review", a word of one workflow's domain; the case kind knows none`,
    `${cases}/lab/verdict.ts: path import ../../review/format/format reaches what ${cases} may not`,
    `${cases}/lab/verdict.ts: path import ../../review/format/format reaches what ${cases}/lab may not`,
    `${shared}/config.ts: imports node:path — ${shared} is pure: no runtime builtins`,
    `${shared}/config.ts: path import ../cases/format/settings reaches what ${shared} may not`,
    `${shared}/config.ts: path import ../cases/format/settings reaches what ${shared} may not`,
  ]);
});

test("the case kind's env imports only agentswf/workflow of awf, and the lab's side no agentswf", async () => {
  const cases = "packages/lab/src/cases";
  const shared = "packages/lab/src/shared";
  await write({
    "packages/lab/package.json": manifest("@agentswf/lab"),
    [`${cases}/env/index.ts`]: 'export const w = require("agentswf/workflow");\n',
    [`${cases}/env/mock.ts`]: 'import "agentswf";\nimport "@agentswf/contract/records";\n',
    [`${cases}/env/case.ts`]: 'import "agentswf/testing";\n',
    [`${cases}/env/env.test.ts`]: 'import "agentswf/testing";\n',
    [`${cases}/env/fixtures/app/workflow.ts`]: 'import "agentswf/typebox";\n',
    [`${cases}/lab/inspect.ts`]: 'import "agentswf/workflow";\n',
    [`${cases}/lab/cli.test.ts`]: 'import "agentswf/workflow";\n',
    [`${cases}/format/records.ts`]: 'import "agentswf";\n',
    [`${shared}/runner.ts`]: 'import "agentswf/workflow";\n',
  });
  const found = (await boundaryProblems(root)).filter(
    (problem) =>
      problem.includes("packages/lab/src/") &&
      problem.includes("agentswf") &&
      !problem.includes("does not declare"),
  );
  const env =
    "@agentswf/lab/cases runs in a project's process: it imports agentswf/workflow, which the running engine serves, and no @agentswf package";
  const lab = "the lab starts a folder's own awf as a process, and never loads an agentswf";
  expect(found).toEqual([
    `${cases}/env/case.ts: imports agentswf/testing — ${env}`,
    `${cases}/env/mock.ts: imports @agentswf/contract/records — ${env}`,
    `${cases}/env/mock.ts: imports agentswf — ${env}`,
    `${cases}/format/records.ts: imports agentswf — ${lab}`,
    `${cases}/lab/inspect.ts: imports agentswf/workflow — ${lab}`,
    `${shared}/runner.ts: imports agentswf/workflow — ${lab}`,
  ]);
});
