import { afterAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runOperatorCli } from "../packages/engine/src/operator-cli";
import { createTempRunDirs } from "../packages/engine/src/testing";

// The workflow API's samples are code: a block whose first line names a file is that file. A bare
// name is written to a folder of its own and run there with `awf test`, as an author would; an
// example's path is quoted from that example, and must still be in it.
const ROOT = join(import.meta.dir, "..");
const runDirs = createTempRunDirs();
afterAll(() => runDirs.cleanup());

const page = readFileSync(join(ROOT, "docs/workflow-api.md"), "utf8");
const samples = [...page.matchAll(/```ts\n\/\/ (\S+)\n([\s\S]*?)```/g)].map(([, file, code]) => ({
  file: file!,
  code: code!,
}));
const lines = (code: string) =>
  code
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");

test("the samples quoted from an example are still in it", () => {
  const quoted = samples.filter(({ file }) => file.startsWith("examples/"));
  expect(quoted.length).toBeGreaterThan(0);
  for (const { file, code } of quoted) {
    const source = readFileSync(join(ROOT, file), "utf8").replaceAll(
      "@agentswf/engine/workflow-testing",
      "agentswf/testing",
    );
    expect(lines(source)).toContain(lines(code));
  }
});

test("the page's workflow and its tests pass under awf test, in a folder of their own", async () => {
  const dir = runDirs.tempRunDir();
  const own = samples.filter(({ file }) => !file.includes("/"));
  expect(own.map(({ file }) => file)).toEqual(["summarize.ts", "summarize.test.ts"]);
  for (const { file, code } of own) await Bun.write(join(dir, file), code);
  const output: string[] = [];
  const exitCode = await runOperatorCli(["test"], {
    cwd: dir,
    stdout: (text) => output.push(text),
    stderr: (text) => output.push(text),
  });
  expect(output.join("\n")).toContain("2 pass");
  expect(exitCode).toBe(0);

  // The page's own `awf test summarize.test.ts -t nudged`.
  output.length = 0;
  expect(
    await runOperatorCli(["test", "summarize.test.ts", "-t", "nudged"], {
      cwd: dir,
      stdout: (text) => output.push(text),
      stderr: (text) => output.push(text),
    }),
  ).toBe(0);
  expect(output.join("\n")).toContain("1 filtered out");
});
