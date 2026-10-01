import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { outOfScope } from "./scope";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function candidate(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "awf-scope-"));
  dirs.push(dir);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}

const surface = `import { defineExecutableWorkflow } from "agentswf/workflow";
import Type from "typebox";
`;

test("the author surface alone, reaching only its agents, is in scope", () => {
  expect(outOfScope(candidate({ "workflow.ts": `${surface}export default 1;\n` }), [])).toEqual([]);
});

test("each way out of scope is named", () => {
  const problems = outOfScope(
    candidate({
      "workflow.ts": `${surface}import { join } from "node:path";
export { x } from "./other";
const a = await import("./b");
const b = Bun.file("x");
const c = fetch("https://x");
const d = process.env.HOME;
const prompt = "look at src/billing/invoice.ts first";
`,
      "notes.md": "scratch",
    }),
    ["src/billing/invoice.ts", "README.md"],
  );
  expect(problems).toEqual([
    "notes.md: a candidate is workflow.ts alone",
    "imports node:path: only agentswf/workflow, typebox, typebox/value",
    "imports ./other: only agentswf/workflow, typebox, typebox/value",
    "uses Bun's API",
    "uses the process",
    "uses the network",
    "uses a dynamic import",
    "names src/billing/invoice.ts, from a tuning case",
  ]);
});

test("words in the prompts it sends are not code, and a tuning key's words are not its own", () => {
  const prompt = `${surface}const prompt = \`Check the process. Then fetch (as needed) the callers.\`;
// process.env is not read here
export default prompt;
`;
  expect(outOfScope(candidate({ "workflow.ts": prompt }), [])).toEqual([]);
  const mechanism =
    "A retry after the lock times out writes the invoice twice, so the customer is charged twice.";
  const copied = `${surface}const hint = "Watch for this: a retry after the lock times out writes the invoice twice";\n`;
  expect(outOfScope(candidate({ "workflow.ts": copied }), [], [mechanism])).toEqual([
    'copies a tuning key\'s words: "a retry after the lock times out writes "',
  ]);
});

test("a folder without workflow.ts is refused", () => {
  expect(outOfScope(candidate({}), [])).toEqual(["no workflow.ts"]);
});
