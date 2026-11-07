import { afterAll, describe, expect, test } from "bun:test";
import { runOperatorCli } from "./operator-cli";
import { createTempRunDirs, eventProject } from "./testing";

const dirs = createTempRunDirs();
afterAll(() => dirs.cleanup());

const workflow = (body: string) => `import { defineWorkflow } from "agentswf/workflow";
export default defineWorkflow({
  meta: { name: "chatty", description: "Logs, then ends." },
  async run(wf) {
    wf.log("skipped", { subject: "a" });
    await wf.stage("only", async () => {
      ${body}
    });
    return "done";
  },
});
`;

async function run(body: string, flags: readonly string[]) {
  const { root, file, home } = eventProject(dirs, "chatty.ts", workflow(body));
  const out: string[] = [];
  const err: string[] = [];
  const code = await runOperatorCli(["run", file, "--cwd", root, ...flags], {
    home,
    environment: { ...process.env, HOME: home },
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
  });
  return { code, out, err };
}

describe("awf run --quiet", () => {
  test("a run that completes writes its result and nothing to stderr", async () => {
    const quiet = await run(``, ["--quiet"]);
    expect(quiet).toMatchObject({ code: 0, err: [] });
    expect(JSON.parse(quiet.out.join(""))).toMatchObject({ outcome: "completed", value: "done" });
    // Without it, the same run's progress and ending are on stderr.
    const loud = await run(``, []);
    expect(loud.err.join("\n")).toContain("skipped");
    expect(loud.err.join("\n")).toContain("completed · chatty");
  });

  test("a run that fails says so on stderr, and nothing of its progress", async () => {
    const { code, out, err } = await run(`throw new Error("no inbox");`, ["--quiet"]);
    expect(code).toBe(1);
    expect(out).toEqual([]);
    expect(err[0]).toMatch(/^✗ failed in only: .*no inbox/);
    expect(err).not.toContain("");
    expect(err.join("\n")).not.toContain("skipped");
    expect(err.join("\n")).toContain("records");
  });

  test("goes with --json, and not with --here", async () => {
    const json = await run(``, ["--quiet", "--json"]);
    expect(json).toMatchObject({ code: 0, err: [] });
    expect(JSON.parse(json.out.join(""))).toMatchObject({ outcome: "completed" });
    const here = await run(``, ["--quiet", "--here"]);
    expect(here.code).toBe(2);
    expect(here.err.join("\n")).toContain("leave out --quiet");
  });
});
