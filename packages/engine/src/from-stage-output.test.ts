import { afterAll, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { runOperatorCli } from "./operator-cli";
import { createTempRunDirs, eventProject } from "./testing";

const dirs = createTempRunDirs();
afterAll(() => dirs.cleanup());

const WORKFLOW = `import { defineWorkflow } from "agentswf/workflow";
const PLAN = { type: "object", properties: { doc: { type: "string" } }, required: ["doc"] };
export default defineWorkflow({
  meta: { name: "two-stages", description: "Plans, then builds." },
  async run(wf) {
    const plan = await wf.stage("plan", { result: PLAN }, async () => ({ doc: "a.md" }));
    return wf.stage("build", async () => plan.doc);
  },
});
`;

test("a stop for the values --from-stage needs keeps them in out.json", async () => {
  const { root, file, home } = eventProject(dirs, "two-stages.ts", WORKFLOW);
  const err: string[] = [];
  const code = await runOperatorCli(
    ["run", file, "--cwd", root, "--id", "r", "--from-stage", "build"],
    {
      home,
      environment: { ...process.env, HOME: home },
      stdout: () => undefined,
      stderr: (text) => err.push(text),
    },
  );
  expect(code).toBe(3);
  const runs = join(root, ".awf", "runs", "two-stages");
  const [id] = readdirSync(runs);
  const output = JSON.parse(await Bun.file(join(runs, id!, "out.json")).text());
  expect(output).toMatchObject({
    outcome: "stopped",
    stage: "plan",
    needs: [
      {
        stage: "plan",
        schema: { type: "object", properties: { doc: { type: "string" } }, required: ["doc"] },
      },
    ],
  });
});
