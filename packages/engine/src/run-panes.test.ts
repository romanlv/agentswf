import { afterAll, expect, test } from "bun:test";
import { join } from "node:path";
import { createSingleSessionHostFactory } from "@agentswf/harness";
import type { AgentSessionAdapter, HarnessActivation } from "@agentswf/harness/adapter";
import { createFakeAdapter } from "@agentswf/harness/testing";
import { emitCommand } from "./emit-command";
import { writeJson } from "./files";
import { runOperatorCli } from "./operator-cli";
import { openRun, readAttempts } from "./runs";
import { createTempRunDirs, eventProject } from "./testing";
import type { Launch } from "./wake";

const dirs = createTempRunDirs();
afterAll(() => dirs.cleanup());

// Each event opens an agent whose turn fails; it returns at the second. Every attempt after the
// first is a wake, which passes no flags.
const WORKFLOW = `import { defineWorkflow } from "agentswf/workflow";
const Go = { type: "object", properties: { n: { type: "number" } }, required: ["n"] };
export default defineWorkflow({
  meta: { name: "panes-kept", description: "Fails a turn at each event." },
  file: import.meta.path,
  events: { go: Go },
  async run(wf) {
    for (;;) {
      for (const e of await wf.receive({ label: "go" })) {
        const worker = await wf.agents.open({ key: "worker-" + e.data.n, runtime: "review" });
        await worker.run({ prompt: "Fail.", nudge: false });
        if (e.data.n >= 2) return "done";
      }
    }
  },
});
`;

/** A fake TUI harness whose turns fail, and what each agent's host was asked and told at close. */
function failingHarness() {
  const fake = createFakeAdapter({ script: () => ({ state: "failed", detail: "it broke" }) });
  const asked: HarnessActivation[] = [];
  const kept: Record<string, boolean> = {};
  const adapter: AgentSessionAdapter = {
    ...fake,
    async activate(request) {
      asked.push(request);
      const session = await fake.activate(request);
      return {
        ...session,
        close: (reason, options) => {
          kept[request.key] ||= options?.keep === true;
          return session.close(reason, options);
        },
      };
    },
  };
  return { adapter, asked, kept };
}

function setup() {
  const { root, file, home } = eventProject(dirs, "panes.ts", WORKFLOW);
  const out: string[] = [];
  const environment = { ...process.env, HOME: home };
  const launched: string[] = [];
  // As a wake launches an attempt, without running it: the test runs it, in this process.
  const launch: Launch = async (_run, given) => {
    launched.push(given);
  };
  const harness = failingHarness();
  const io = { stdout: (t: string) => out.push(t), stderr: (t: string) => out.push(`! ${t}`) };
  const awf = (argv: string[]) =>
    runOperatorCli(argv, {
      home,
      environment,
      launch,
      ...io,
      installRuntime: async () => ({
        config: {
          aliases: { review: { harness: "fake", model: "fake" } },
          host: createSingleSessionHostFactory(harness.adapter),
        },
        cleanup: async () => undefined,
      }),
    });
  const send = (n: number) =>
    emitCommand(
      ["--target", file, "--id", "k", "go", JSON.stringify({ n }), "--event-id", `e${n}`],
      root,
      io,
      { home, environment, launch },
    );
  const runRoot = join(root, ".awf", "runs");
  // What a detached wake runs: no flag but the run's.
  const woken = () => awf(["run", file, "--id", "k", "--continue", "--run-root", runRoot]);
  return { file, out, runRoot, harness, awf, send, woken, launched };
}

test("--keep-panes and --workspace are recorded, and a run that parks and wakes keeps both", async () => {
  const { file, out, runRoot, harness, awf, send, woken, launched } = setup();
  expect(
    await awf(["run", file, "--id", "k", "--keep-panes", "on-failure", "--workspace", "review"]),
  ).toBe(0);
  expect(launched).toHaveLength(1);
  const run = await openRun(runRoot, "panes-kept", "k");
  expect(run.record.panes).toEqual({ workspace: { name: "review" }, keep: "on-failure" });

  expect(await send(1)).toBe(0);
  expect(await woken()).toBe(0);
  expect((await readAttempts(run)).map((a) => a.outcome)).toEqual(["parked"]);
  // Its process is this one: as a real wake's would be, the parked attempt's is gone.
  const [first] = await readAttempts(run);
  await writeJson(join(run.dir, "attempts", "1.json"), {
    ...first,
    processStart: "2000-01-01T00:00:00.000Z",
  });

  expect(await send(2)).toBe(0);
  expect(await woken()).toBe(0);
  const attempts = await readAttempts(run);
  expect(attempts.map((a) => a.outcome)).toEqual(["parked", "completed"]);
  expect(attempts.map((a) => a.flags)).toEqual([{}, {}]);

  for (const key of ["worker-1", "worker-2"]) {
    expect(harness.asked.find((asked) => asked.key === key)).toMatchObject({
      layout: { workspace: { name: "review" } },
      keepPane: "on-failure",
    });
    // Its turn failed, so its pane stays.
    expect(harness.kept[key]).toBe(true);
  }
  expect(out.filter((line) => line.startsWith("! awf: ") && line.includes("deprecated"))).toEqual(
    [],
  );
}, 60_000);

const PLAIN = `import { defineWorkflow } from "agentswf/workflow";
export default defineWorkflow({
  meta: { name: "panes-plain", description: "Fails a turn, and stops." },
  async run(wf) {
    const worker = await wf.agents.open({ key: "worker", runtime: "review", pane: { front: true } });
    await worker.run({ prompt: "Fail.", nudge: false });
    throw new Error("stopped");
  },
});
`;

test("a plain run records the flags too, and its continue keeps them", async () => {
  const { root, file, home } = eventProject(dirs, "plain.ts", PLAIN);
  const harness = failingHarness();
  const out: string[] = [];
  const awf = (...argv: string[]) =>
    runOperatorCli(["run", file, "--cwd", root, ...argv], {
      home,
      environment: { ...process.env, HOME: home },
      stdout: (t) => out.push(t),
      stderr: (t) => out.push(`! ${t}`),
      installRuntime: async () => ({
        config: {
          aliases: { review: { harness: "fake", model: "fake" } },
          host: createSingleSessionHostFactory(harness.adapter),
        },
        cleanup: async () => undefined,
      }),
    });
  expect(await awf("--id", "p", "--keep-panes", "on-failure", "--workspace", "origin")).toBe(1);
  expect(await awf("--id", "p", "--continue")).toBe(1);
  const run = await openRun(join(root, ".awf", "runs"), "panes-plain", "p");
  expect(run.record.panes).toEqual({ workspace: "origin", keep: "on-failure" });
  expect(harness.asked).toHaveLength(2);
  for (const asked of harness.asked) {
    expect(asked).toMatchObject({
      layout: { workspace: "origin" },
      front: true,
      keepPane: "on-failure",
    });
  }
  expect(harness.kept.worker).toBe(true);
});

test("awf run refuses a pane flag without its value", async () => {
  const { file, out, awf } = setup();
  expect(await awf(["run", file, "--id", "k", "--keep-panes", "sometimes"])).toBe(2);
  expect(out.at(-1)).toContain("--keep-panes needs never, on-failure or always");
  expect(await awf(["run", file, "--id", "k", "--workspace", "--json"])).toBe(2);
  expect(out.at(-1)).toContain("--workspace needs run, origin or a workspace's name");
  expect(await awf(["run", file, "--id", "k", "--workspace", "a", "--workspace", "b"])).toBe(2);
  expect(out.at(-1)).toContain("--workspace given twice");
  expect(await awf(["run", file, "--id", "k", "--workspace", " "])).toBe(2);
  expect(out.at(-1)).toContain("--workspace needs run, origin or a workspace's name");
});

test("a continue or awf run --id may repeat a run's pane flags, never change them", async () => {
  const { file, out, runRoot, awf } = setup();
  expect(await awf(["run", file, "--id", "k", "--keep-panes", "always"])).toBe(0);
  expect((await openRun(runRoot, "panes-kept", "k")).record.panes).toEqual({ keep: "always" });
  expect(await awf(["run", file, "--id", "k", "--keep-panes", "always"])).toBe(0);
  expect(await awf(["run", file, "--id", "k", "--keep-panes", "never"])).toBe(2);
  expect(out.at(-1)).toBe(
    "! awf: k keeps the --keep-panes it was started with; leave --keep-panes out",
  );
  expect(await awf(["run", file, "--id", "k", "--continue", "--workspace", "origin"])).toBe(2);
  expect(out.at(-1)).toBe(
    "! awf: k was started without --workspace, so with --workspace run; leave it out",
  );
  expect(await awf(["run", file, "--id", "k", "--continue", "--workspace", "run"])).toBe(0);
});

test("a run an event started has no pane flags, and takes only their defaults later", async () => {
  const { file, out, runRoot, awf, send } = setup();
  expect(await send(1)).toBe(0);
  const run = await openRun(runRoot, "panes-kept", "k");
  expect(run.record).not.toHaveProperty("panes");
  expect(await awf(["run", file, "--id", "k", "--workspace", "run", "--keep-panes", "never"])).toBe(
    0,
  );
  expect((await openRun(runRoot, "panes-kept", "k")).record).not.toHaveProperty("panes");
  expect(await awf(["run", file, "--id", "k", "--keep-panes", "always"])).toBe(2);
  expect(out.at(-1)).toBe(
    "! awf: k was started without --keep-panes, so with --keep-panes never; leave it out",
  );
  expect(await awf(["run", file, "--id", "k", "--continue", "--workspace", "origin"])).toBe(2);
  expect(out.at(-1)).toBe(
    "! awf: k was started without --workspace, so with --workspace run; leave it out",
  );
});
