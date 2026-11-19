import { afterAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createSingleSessionHostFactory } from "@agentswf/harness";
import { createFakeAdapter } from "@agentswf/harness/testing";
import { runOperatorCli } from "./operator-cli";
import { openRun } from "./runs";
import { createTempRunDirs, eventProject } from "./testing";

const dirs = createTempRunDirs();
afterAll(() => dirs.cleanup());

const WORKFLOW = `import { defineWorkflow } from "agentswf/workflow";
export default defineWorkflow({
  meta: { name: "boxed", description: "Returns at once." },
  file: import.meta.path,
  async run() {
    return "done";
  },
});
`;

async function started(flags: string[]) {
  const { root, file, home } = eventProject(dirs, "boxed.ts", WORKFLOW);
  const out: string[] = [];
  const awf = (argv: string[]) =>
    runOperatorCli(argv, {
      home,
      environment: { ...process.env, HOME: home },
      stdout: (t: string) => out.push(t),
      stderr: () => undefined,
      installRuntime: async () => ({
        config: {
          aliases: {},
          host: createSingleSessionHostFactory(
            createFakeAdapter({ script: () => ({ state: "failed", detail: "no agent opens" }) }),
          ),
        },
        cleanup: async () => undefined,
      }),
    });
  const runRoot = join(root, ".awf", "runs");
  expect(await awf(["run", file, "--id", "r", "--run-root", runRoot, ...flags])).toBe(0);
  const run = await openRun(runRoot, "boxed", "r");
  out.length = 0;
  expect(await awf(["runs", "boxed/r", "--run-root", runRoot, "--json"])).toBe(0);
  const json = JSON.parse(out.join(""));
  out.length = 0;
  expect(await awf(["runs", "boxed/r", "--run-root", runRoot])).toBe(0);
  const text = out.join("\n");
  const output = JSON.parse(readFileSync(join(run.dir, "out.json"), "utf8"));
  return { run, json, text, output };
}

test("a boxed run says so in run.json, out.json and awf runs: its agents ran in its caller's box", async () => {
  const { run, json, text, output } = await started(["--boxed"]);
  expect(run.record.boxed).toBe(true);
  expect(output.boxed).toBe(true);
  expect(json.run.boxed).toBe(true);
  expect(text.split("\n")[0]).toContain("boxed by its caller");
});

test("a run not boxed says nothing of a box", async () => {
  const { run, json, text, output } = await started([]);
  expect(run.record.boxed).toBeUndefined();
  expect(output.boxed).toBeUndefined();
  expect(json.run.boxed).toBeUndefined();
  expect(text).not.toContain("boxed by");
});
