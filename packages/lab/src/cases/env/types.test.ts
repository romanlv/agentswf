import { afterAll, expect, test } from "bun:test";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A project whose installed `agentswf` and its `@agentswf/*` packages are copies of their own, of
// the same name and version as the lab's, with this lab linked in as `bun link` would: its env.ts
// must type-check against its own workflow, by its own `tsc`, and so must its workflow's test. A
// lab importing `agentswf` would bring its own copy into the project's check, where TypeScript,
// taking packages of one name and version for one, mixes the two copies' types.

const LAB = realpathSync(join(import.meta.dir, "../../.."));
const PACKAGES = join(LAB, "..");
const ROOT_MODULES = join(PACKAGES, "../node_modules");
const top = realpathSync(mkdtempSync(join(tmpdir(), "awf-lab-types-")));
afterAll(() => rmSync(top, { recursive: true, force: true }));

// The project's sources, spelled so the boundary checker never reads them as this file's imports.
const from = (spec: string) => `from "${spec}"`;
const lazy = (spec: string) => `${"import"}("${spec}")`;

function copyPackage(name: string, to: string) {
  for (const part of ["package.json", "src"]) {
    cpSync(join(PACKAGES, name, part), join(to, part), {
      recursive: true,
      filter: (path) => !/\.(test|eval|typecheck)\.ts$/.test(path),
    });
  }
}

test("an env.ts type-checks in a project whose agentswf is another copy than the lab's", async () => {
  const modules = join(top, "node_modules");
  mkdirSync(join(modules, "@agentswf"), { recursive: true });
  mkdirSync(join(modules, "@types"), { recursive: true });
  copyPackage("agentswf", join(modules, "agentswf"));
  for (const name of ["contract", "engine", "harness", "sandbox"]) {
    copyPackage(name, join(modules, "@agentswf", name));
  }
  symlinkSync(LAB, join(modules, "@agentswf/lab"));
  symlinkSync(realpathSync(join(LAB, "node_modules/typebox")), join(modules, "typebox"));
  symlinkSync(realpathSync(join(ROOT_MODULES, "typescript")), join(modules, "typescript"));
  symlinkSync(realpathSync(join(ROOT_MODULES, "@types/bun")), join(modules, "@types/bun"));
  const files: Record<string, string> = {
    "tsconfig.json": JSON.stringify({
      compilerOptions: {
        target: "ESNext",
        module: "ESNext",
        moduleResolution: "bundler",
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        allowImportingTsExtensions: true,
      },
      // env.ts is read first, as where `evals/` sorts before the workflow's folder: what it
      // imports then stands for every file of that name and version.
      include: ["evals", "triage"],
    }),
    "triage/workflow.ts": [
      `import { defineWorkflow } ${from("agentswf/workflow")};`,
      "",
      "export default defineWorkflow<{ n: number }, { answer: number }>({",
      '  meta: { name: "tiny", description: "Adds one." },',
      "  prepare: ({ argv }) => ({ n: Number(argv[0] ?? 0) }),",
      "  run: async (_wf, { n }) => ({ answer: n + 1 }),",
      "});",
      "",
    ].join("\n"),
    "triage/workflow.test.ts": [
      `import { expect, test } ${from("bun:test")};`,
      `import { testWorkflow } ${from("agentswf/testing")};`,
      `import workflow ${from("./workflow")};`,
      "",
      'test("adds one", async () => {',
      "  const run = await testWorkflow(workflow, { args: { n: 1 } });",
      "  expect(run.value.answer).toBe(2);",
      "});",
      "",
    ].join("\n"),
    "evals/ds/env.ts": [
      `import { defineEnv } ${from("@agentswf/lab/cases")};`,
      "",
      "export default defineEnv({",
      `  workflow: () => ${lazy("../../triage/workflow")},`,
      "  setup(c) {",
      "    const input: { n: number } = c.input;",
      "    return {",
      "      argv: [String(input.n)],",
      "      observe: (result) => ({ answer: result.answer }),",
      "    };",
      "  },",
      "});",
      "",
    ].join("\n"),
  };
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(top, path, ".."), { recursive: true });
    writeFileSync(join(top, path), text);
  }
  const tsc = Bun.spawn(
    [
      process.execPath,
      join(modules, "typescript/bin/tsc"),
      "-p",
      "tsconfig.json",
      "--pretty",
      "false",
    ],
    { cwd: top, stdout: "pipe", stderr: "pipe" },
  );
  const [out, err, code] = await Promise.all([
    new Response(tsc.stdout).text(),
    new Response(tsc.stderr).text(),
    tsc.exited,
  ]);
  expect(`${out}${err}`).toBe("");
  expect(code).toBe(0);
}, 120_000);
