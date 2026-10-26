import { afterAll, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { emitCommand } from "./emit-command";
import { writeJson } from "./files";
import { appendMailbox } from "./mailbox";
import { runOperatorCli } from "./operator-cli";
import { createRun, openRun, previousGone, processStart, readAttempts } from "./runs";
import { createTempRunDirs } from "./testing";
import { wake } from "./wake";

const dirs = createTempRunDirs();
afterAll(() => dirs.cleanup());

// A run that takes events until it has seen two, and returns them: no agent, so no harness. What
// it has seen is in a file, as anything that must outlive a park is.
const WORKFLOW = `import { appendFileSync, readFileSync } from "node:fs";
const Changes = { type: "object", properties: { case: { type: "string" }, n: { type: "number" } }, required: ["case"] };
const SEEN = new URL("./seen.txt", import.meta.url).pathname;
const seen = () => { try { return readFileSync(SEEN, "utf8").split("\\n").filter(Boolean).map(Number); } catch { return []; } };
import { defineEventWorkflow } from "agentswf/workflow";
export default defineEventWorkflow({
  definition: {
    meta: { name: "e2e-case", description: "Takes two events." },
    file: import.meta.path,
    events: { "dd.changes": Changes },
    key: (e) => e.data.case,
    starts: ["dd.changes"],
    async run(workflow) {
      for (;;) {
        for (const e of await workflow.receive({ label: seen().length + " seen" }))
          appendFileSync(SEEN, e.data.n + "\\n");
        if (seen().length >= 2) return { seen: seen() };
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

test("an event starts a detached run, which parks; the next continues it, from any directory", async () => {
  const { root, out, send } = setup();
  expect(await send(1)).toBe(0);
  const run = await openRun(join(root, ".awf", "runs"), "e2e-case", "e2e-case.k");
  // It takes the starting event, waits with nothing to take and no turn running, and parks.
  await until(async () => (await readAttempts(run)).at(-1)?.outcome === "parked");
  expect(await send(2)).toBe(0);
  await until(async () => (await readAttempts(run)).at(-1)?.outcome === "completed");
  expect(out).toEqual([
    "accepted e2e-case/e2e-case.k: started",
    "accepted e2e-case/e2e-case.k: continued",
  ]);
  expect((await readAttempts(run)).map((a) => a.outcome)).toEqual(["parked", "completed"]);
  // It returned having taken every event; its output went to the run's log, not a terminal.
  expect((await readAttempts(run)).at(-1)?.unacknowledged).toBe(0);
  expect(await Bun.file(join(run.dir, "process.log")).text()).toContain("◇ parked: 1 seen");
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

test("a continue reads the project's .env again, and not what the sender exported", async () => {
  const root = dirs.tempRunDir();
  mkdirSync(join(root, ".awf"));
  mkdirSync(join(root, "flows"));
  const file = join(root, "flows", "env.ts");
  writeFileSync(
    file,
    `import { appendFileSync } from "node:fs";
import { defineEventWorkflow } from "agentswf/workflow";
const Ping = { type: "object", properties: { n: { type: "number" } } };
export default defineEventWorkflow({
  definition: {
    meta: { name: "e2e-env", description: "Records its token at each wake." },
    file: import.meta.path,
    events: { ping: Ping },
    key: () => "one",
    starts: ["ping"],
    async run(workflow) {
      for (;;) {
        const events = await workflow.receive();
        appendFileSync(${JSON.stringify(join(root, "tokens.txt"))}, (process.env.TOKEN ?? "none") + "\\n");
        if (events.some((e) => e.data.n === 2)) return null;
      }
    },
  },
});
`,
  );
  writeFileSync(join(root, ".env"), "TOKEN=first\n");
  const home = dirs.tempRunDir();
  const io = { stdout: () => undefined, stderr: () => undefined };
  const send = (n: number, environment: Record<string, string | undefined>) =>
    emitCommand(
      ["--target", file, "ping", JSON.stringify({ n }), "--id", `p${n}`],
      dirs.tempRunDir(),
      io,
      {
        home,
        environment,
      },
    );
  expect(await send(1, { HOME: home, PATH: process.env.PATH })).toBe(0);
  const run = await openRun(join(root, ".awf", "runs"), "e2e-env", "e2e-env.one");
  await until(async () => (await readAttempts(run)).at(-1)?.outcome === "parked");
  writeFileSync(join(root, ".env"), "TOKEN=rotated\n");
  // A sender with a stale token exported, and a PATH of its own: the run has neither.
  expect(await send(2, { HOME: home, PATH: "/nowhere", TOKEN: "stale" })).toBe(0);
  await until(async () => (await readAttempts(run)).at(-1)?.outcome === "completed");
  expect((await Bun.file(join(root, "tokens.txt")).text()).trim().split("\n")).toEqual([
    "first",
    "rotated",
  ]);
}, 60_000);

test("a continue waits for the previous attempt's process to be gone", async () => {
  const root = dirs.tempRunDir();
  const run = await createRun(join(root, "runs"), {
    id: "w.k",
    workflow: "w",
    argv: [],
    cwd: root,
    sandbox: null,
    key: "k",
  });
  const previous = Bun.spawn({ cmd: ["sleep", "0.4"] });
  await Bun.sleep(50);
  mkdirSync(join(run.dir, "attempts"), { recursive: true });
  await writeJson(join(run.dir, "attempts", "1.json"), {
    version: 1,
    attempt: 1,
    file: "/f.ts",
    flags: {},
    pid: previous.pid,
    processStart: processStart(previous.pid),
    started: new Date().toISOString(),
    ended: new Date().toISOString(),
    outcome: "parked",
  });
  const started = Date.now();
  await previousGone(run, 2, () => undefined);
  expect(Date.now() - started).toBeGreaterThanOrEqual(250);
  expect(previous.exitCode).toBe(0);
});

test("a continue claims its attempt first, so wake returns, then waits for the previous process", async () => {
  const { root, file, home } = setup();
  const run = await createRun(join(root, ".awf", "runs"), {
    id: "e2e-case.k",
    workflow: "e2e-case",
    argv: [],
    cwd: root,
    sandbox: null,
    key: "k",
    env: { PATH: process.env.PATH ?? "" },
    file,
  });
  // Attempt 1 parked, its process still closing for a second.
  const previous = Bun.spawn({ cmd: ["sleep", "1.5"] });
  await Bun.sleep(50);
  mkdirSync(join(run.dir, "attempts"), { recursive: true });
  const now = new Date().toISOString();
  await writeJson(join(run.dir, "attempts", "1.json"), {
    version: 1,
    attempt: 1,
    file,
    flags: {},
    pid: previous.pid,
    processStart: processStart(previous.pid),
    started: now,
    ended: now,
    outcome: "parked",
  });
  await appendMailbox(run.dir, {
    version: 1,
    at: now,
    kind: "event",
    id: "c1",
    name: "dd.changes",
    data: { case: "k", n: 1 },
    from: "operator",
  });
  const started = Date.now();
  expect(await wake(run, { home, environment: { ...process.env, HOME: home } })).toMatchObject({
    did: "continued",
  });
  // Returned on the claim, the previous process still alive.
  expect(Date.now() - started).toBeLessThan(1_400);
  expect(previous.exitCode).toBeNull();
  // The new attempt wrote nothing yet: its first line waits for the previous process.
  const turns = await Bun.file(join(run.dir, "turns.jsonl"))
    .text()
    .catch(() => "");
  expect(turns).not.toContain('"attempt":2');
  await previous.exited;
  await until(async () =>
    (
      await Bun.file(join(run.dir, "turns.jsonl"))
        .text()
        .catch(() => "")
    ).includes('"attempt":2'),
  );
}, 60_000);
