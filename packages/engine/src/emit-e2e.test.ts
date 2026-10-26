import { afterAll, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { emitCommand } from "./emit-command";
import { runOperatorCli } from "./operator-cli";
import { openRun, readAttempts } from "./runs";
import { createTempRunDirs } from "./testing";

const dirs = createTempRunDirs();
afterAll(() => dirs.cleanup());

// A run that takes events until it has seen two, and returns them: no agent, so no harness.
const WORKFLOW = `import { defineEventWorkflow } from "agentswf/workflow";
const Changes = { type: "object", properties: { case: { type: "string" }, n: { type: "number" } }, required: ["case"] };
export default defineEventWorkflow({
  definition: {
    meta: { name: "e2e-case", description: "Takes two events." },
    file: import.meta.path,
    events: { "dd.changes": Changes },
    key: (e) => e.data.case,
    starts: ["dd.changes"],
    async run(workflow) {
      const seen = [];
      for (;;) {
        for (const e of await workflow.receive({ label: seen.length + " seen" })) seen.push(e.data.n);
        if (seen.length >= 2) return { seen };
      }
    },
  },
});
`;

function setup() {
  const root = dirs.tempRunDir();
  mkdirSync(join(root, ".awf"));
  mkdirSync(join(root, "flows"));
  const file = join(root, "flows", "case.ts");
  writeFileSync(file, WORKFLOW);
  const home = dirs.tempRunDir();
  const out: string[] = [];
  const io = { stdout: (t: string) => out.push(t), stderr: (t: string) => out.push(`! ${t}`) };
  const send = (n: number) =>
    emitCommand(
      ["--target", file, "dd.changes", JSON.stringify({ case: "k", n }), "--id", `c${n}`],
      dirs.tempRunDir(),
      io,
      { home, environment: { ...process.env, HOME: home } },
    );
  return { root, file, home, out, send };
}

async function until(check: () => Promise<boolean>, ms = 20_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(50);
  }
}

test("an event starts a detached run, a later one nudges it, from any directory", async () => {
  const { root, out, send } = setup();
  expect(await send(1)).toBe(0);
  const run = await openRun(join(root, ".awf", "runs"), "e2e-case", "e2e-case.k");
  // Its first wait has taken the starting event and waits for the next.
  await until(async () =>
    (await Bun.file(join(run.dir, "mailbox.jsonl")).text()).includes('"1 seen"'),
  );
  expect(await send(2)).toBe(0);
  await until(async () => (await readAttempts(run)).at(-1)?.outcome === "completed");
  expect(out).toEqual([
    "accepted e2e-case/e2e-case.k: started",
    "accepted e2e-case/e2e-case.k: nudged",
  ]);
  const output = JSON.parse(await Bun.file(join(run.dir, "output.json")).text()) as {
    value: unknown;
  };
  expect(output.value).toEqual({ seen: [1, 2] });
  expect(await send(3)).toBe(0);
  expect(out.at(-1)).toBe("refused e2e-case/e2e-case.k: returned");
}, 60_000);

test("awf run refuses a workflow with events", async () => {
  const { file, home } = setup();
  const err: string[] = [];
  const code = await runOperatorCli(["run", file], {
    home,
    stdout: () => undefined,
    stderr: (t) => err.push(t),
  });
  expect(code).toBe(2);
  expect(err.join("\n")).toContain("is a workflow with events, which an event starts: awf emit");
});

test("awf run --continue of a keyed run takes no stage, values or arguments", async () => {
  const { file, home } = setup();
  for (const [extra, message] of [
    [["--from-stage", "x"], "takes no --from-stage or --values"],
    [["--", "arg"], "takes no arguments"],
  ] as const) {
    const err: string[] = [];
    const code = await runOperatorCli(["run", file, "--continue", "e2e-case.k", ...extra], {
      home,
      stdout: () => undefined,
      stderr: (t) => err.push(t),
    });
    expect(code).toBe(2);
    expect(err.join("\n")).toContain(message);
  }
});
