import { afterAll, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { awfLogs } from "../../shared/runner";
import { runCases } from "./cli";
import { readTrials, runIds } from "./store";

// End to end: a tiny dataset in a project inside this package, with its own `node_modules`
// linking this checkout's `agentswf` and this lab, as `bun link` would, and `typescript`
// resolving from the package; the real runner starts the project's `awf` bin in it, with the
// lab's preload. A workflow with no agents: no cost.

const PACKAGE = join(import.meta.dir, "../../..");
const project = realpathSync(mkdtempSync(join(PACKAGE, ".e2e-")));
mkdirSync(join(project, "node_modules/@agentswf"), { recursive: true });
symlinkSync(realpathSync(join(PACKAGE, "../agentswf")), join(project, "node_modules/agentswf"));
symlinkSync(realpathSync(PACKAGE), join(project, "node_modules/@agentswf/lab"));
const outside = realpathSync(mkdtempSync(join(tmpdir(), "awf-lab-e2e-")));
afterAll(() => {
  rmSync(project, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

// The project's sources, spelled so the boundary checker never reads them as this file's imports.
const from = (spec: string) => `from "${spec}"`;
const lazy = (spec: string) => `${"import"}("${spec}")`;

function git(cwd: string, ...args: string[]) {
  const run = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (run.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr.toString()}`);
}

function write(files: Record<string, string>) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(project, path, ".."), { recursive: true });
    writeFileSync(join(project, path), text);
  }
}

const key = (want: number) =>
  `---\nkind: awf.case-key/0\nmarker: harbor-violet-pepper-anvil\nexpect:\n  answer: ${want}\n---\n\nWhy.\n`;

write({
  "tsconfig.json": JSON.stringify({ extends: "../../../tsconfig.base.json" }),
  "app/workflow.ts": [
    `import { defineWorkflow } ${from("agentswf/workflow")};`,
    "",
    "export default defineWorkflow<{ n: number }, { answer: number }>({",
    '  meta: { name: "tiny", description: "Adds one." },',
    "  prepare: ({ argv }) => ({ n: Number(argv[0] ?? 0) }),",
    "  run: async (_wf, { n }) => ({ answer: n + 1 }),",
    "});",
    "",
  ].join("\n"),
  "evals/awf-lab.json": JSON.stringify({ kind: "awf.lab-workspace/1" }),
  "evals/tiny/dataset.json": JSON.stringify({
    kind: "awf.case-dataset/0",
    sandbox: "workflow",
    agentReach: { network: [] },
    timeout: "1m",
    setupTimeout: "1m",
  }),
  "evals/tiny/env.ts": [
    `import { defineEnv } ${from("@agentswf/lab/cases")};`,
    "",
    "export default defineEnv({",
    `  workflow: () => ${lazy("../../app/workflow")},`,
    "  setup(c) {",
    "    const input: { n: number } = c.input;",
    "    return {",
    "      argv: [String(input.n)],",
    "      observe: (result) => ({ answer: result.answer, cwd: process.cwd() }),",
    "    };",
    "  },",
    "});",
    "",
  ].join("\n"),
  "evals/tiny/cases/right/input.json": JSON.stringify({ n: 41 }),
  "evals/tiny/cases/right/key.md": key(42),
  "evals/tiny/cases/wrong/input.json": JSON.stringify({ n: 1 }),
  "evals/tiny/cases/wrong/key.md": key(3),
  // A workflow that opens a sandbox of its own, and no agent: the reach check reads its records.
  "app/boxed.ts": [
    `import { defineWorkflow } ${from("agentswf/workflow")};`,
    "",
    "export default defineWorkflow({",
    '  meta: { name: "boxed", description: "Opens a sandbox." },',
    "  run: async (wf) => {",
    '    await wf.sandboxes.open({ key: "box", write: ["."], network: ["example.com"], docker: {} });',
    '    return { box: "open" };',
    "  },",
    "});",
    "",
  ].join("\n"),
  "evals/boxed/dataset.json": JSON.stringify({
    kind: "awf.case-dataset/0",
    sandbox: "workflow",
    agentReach: { network: ["example.com"] },
    timeout: "2m",
    setupTimeout: "1m",
  }),
  "evals/boxed/env.ts": [
    `import { defineEnv } ${from("@agentswf/lab/cases")};`,
    "",
    "export default defineEnv({",
    `  workflow: () => ${lazy("../../app/boxed")},`,
    "  setup: () => ({ observe: (result) => ({ box: result.box }) }),",
    "});",
    "",
  ].join("\n"),
  "evals/boxed/cases/open/input.json": "{}",
  "evals/boxed/cases/open/key.md":
    '---\nkind: awf.case-key/0\nmarker: harbor-violet-pepper-anvil\nexpect:\n  box: "open"\n---\n\nWhy.\n',
});
git(project, "init", "-q", "-b", "main");
git(project, "add", "-A");
git(project, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base");

test("a tiny dataset runs on the folder's own awf, and its runs read back from the store", async () => {
  const home = join(outside, "home");
  const tmp = join(outside, "tmp");
  mkdirSync(home);
  mkdirSync(tmp);
  const out: string[] = [];
  const err: string[] = [];
  const env = { PATH: process.env.PATH ?? "", HOME: home };
  const code = await runCases(["run", "--dataset", "tiny", "--yes"], {
    cwd: project,
    home,
    tmp,
    env,
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
  });
  const text = out.join("\n");
  expect({ code, text, err: err.join("\n") }).toMatchObject({ code: 1 });
  expect(text).toContain("failed, must pass");
  expect(text).toContain("wrong");
  expect(text).toContain("expect: answer is 2, the key wants 3");
  expect(text).toContain("passed 1 · failed 1");

  const store = join(
    home,
    ".awf/lab",
    readdirSync(join(home, ".awf/lab")).find((n) => n.startsWith(".e2e-"))!,
  );
  const trials = readTrials(store, runIds(store)[0]!);
  expect(trials).toHaveLength(2);
  const right = trials.find((t) => t.record.case === "right")!.record;
  expect(realpathSync(right.awf.bin)).toBe(realpathSync(join(PACKAGE, "../agentswf/src/awf.ts")));
  expect(right.runOutcome).toBe("completed");
  // The trial's process ran with the project as its working folder, the run in the scratch folder.
  expect(right.facts).toEqual({ answer: 42, cwd: project });
  expect(right.reach).toMatchObject({ ok: true, sandboxes: [] });
  const runs = join(store, "awf-runs");
  expect(readdirSync(runs).some((workflow) => existsSync(join(runs, workflow, right.runId!)))).toBe(
    true,
  );
  expect(readdirSync(tmp).filter((n) => n.startsWith("awf-lab-case-"))).toEqual([]);

  // The run reads back through the project's own awf with --run-root, as the marker search does.
  const logs = await awfLogs(
    { bin: right.awf.bin, dir: project },
    runs,
    `case-env-tiny/${right.runId}`,
    env,
  );
  if (!("text" in logs)) throw new Error(logs.unread);
  const events = (JSON.parse(logs.text) as { events: { kind?: string }[] }).events;
  expect(events.length).toBeGreaterThan(0);
  expect(logs.text).toContain(right.runId!);
}, 180_000);

const docker = (...args: string[]) => {
  try {
    return (
      Bun.spawnSync(["docker", ...args], { stdout: "ignore", stderr: "ignore" }).exitCode === 0
    );
  } catch {
    return false; // no docker on PATH: spawning it throws
  }
};
// The sandbox's default image, tagged by a hash of its Dockerfile as the provider tags it: a box
// opens only where it is built, and CI's runners have docker without it.
const image = `awf-agent:${new Bun.CryptoHasher("sha256")
  .update(readFileSync(join(PACKAGE, "../sandbox/docker/Dockerfile")))
  .digest("hex")
  .slice(0, 12)}`;
const dockerUp = docker("info") && docker("image", "inspect", image);

// Docker is the one sandbox provider that opens without a login or an install beyond itself; srt
// needs its own binary. Where neither runs, or the image isn't built, this test is skipped.
test.skipIf(!dockerUp)(
  "a workflow dataset runs a workflow that opens its own sandbox, and the reach check passes on its records",
  async () => {
    const home = join(outside, "home-boxed");
    const tmp = join(outside, "tmp-boxed");
    mkdirSync(home);
    mkdirSync(tmp);
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCases(["run", "--dataset", "boxed", "--yes"], {
      cwd: project,
      home,
      tmp,
      env: { PATH: process.env.PATH ?? "", HOME: home },
      stdout: (t) => out.push(t),
      stderr: (t) => err.push(t),
    });
    expect({ code, out: out.join("\n"), err: err.join("\n") }).toMatchObject({ code: 0 });
    const store = join(
      home,
      ".awf/lab",
      readdirSync(join(home, ".awf/lab")).find((n) => n.startsWith(".e2e-"))!,
    );
    const [trial] = readTrials(store, runIds(store)[0]!);
    expect(trial!.record.reach).toEqual({
      ok: true,
      problems: [],
      sockets: [],
      sandboxes: [
        { key: "box", provider: "docker", network: ["example.com"], webSearch: false, agents: [] },
      ],
    });
  },
  180_000,
);

test("a type error in env.ts stops run with exit 2 before any trial", async () => {
  const home = join(outside, "home2");
  mkdirSync(home);
  writeFileSync(
    join(project, "evals/tiny/env.ts"),
    [
      `import { defineEnv } ${from("@agentswf/lab/cases")};`,
      "export default defineEnv({",
      `  workflow: () => ${lazy("../../app/workflow")},`,
      "  setup: () => ({ observe: (result) => ({ answer: result.missing }) }),",
      "});",
      "",
    ].join("\n"),
  );
  const err: string[] = [];
  const code = await runCases(["run", "--dataset", "tiny", "--yes"], {
    cwd: project,
    home,
    tmp: outside,
    env: { PATH: process.env.PATH ?? "", HOME: home },
    stdout: () => {},
    stderr: (t) => err.push(t),
  });
  expect(code).toBe(2);
  expect(err.join("\n")).toMatch(/type error: evals\/tiny\/env\.ts\(\d+,\d+\): TS\d+:/);
  expect(existsSync(join(home, ".awf/lab"))).toBe(false);
}, 180_000);
