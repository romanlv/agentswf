// A project whose `agentswf` is a copy of this engine at another version, driven through the global
// `awf`: every command, and the attempt a wake launches, runs on the copy (ADR 0014).

import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ENGINE_VERSION } from "./project-engine";
import { createRun } from "./runs";

const PACKAGES = join(import.meta.dir, "../..");
const AWF = join(PACKAGES, "agentswf/src/awf.ts");
const FIXTURE = "0.0.0-fixture";

let root: string;
let home: string;
let fixture: string;
let bare: string;
let log: string;

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "awf-engine-copy-")));
  home = join(root, "home");
  mkdirSync(home);
  log = join(root, "invocations.jsonl");
  fixture = join(root, "fixture");
  const modules = join(fixture, "node_modules");
  copyPackage("agentswf", join(modules, "agentswf"));
  for (const name of ["engine", "contract", "harness", "sandbox"])
    copyPackage(name, join(modules, "@agentswf", name));
  symlinkSync(
    realpathSync(join(PACKAGES, "engine/node_modules/typebox")),
    join(modules, "typebox"),
  );
  // The copy says which engine ran each command and each attempt, to a file, since an attempt
  // inherits little of the environment; and it serves a surface of its own.
  const cli = join(modules, "@agentswf/engine/src/operator-cli.ts");
  writeFileSync(
    cli,
    readFileSync(cli, "utf8").replace(
      "if (import.meta.main) await main();",
      `(await import("node:fs")).appendFileSync(${JSON.stringify(log)}, JSON.stringify({ version: manifest.version, argv: process.argv.slice(2) }) + "\\n");
if (import.meta.main) await main();`,
    ),
  );
  const author = join(modules, "@agentswf/contract/src/workflow/author.ts");
  writeFileSync(author, `${readFileSync(author, "utf8")}\nexport const fixtureMarker = true;\n`);
  writeFileSync(
    join(fixture, "package.json"),
    JSON.stringify({ devDependencies: { agentswf: FIXTURE } }),
  );
  writeFileSync(join(fixture, ".env"), "FROM_DOT_ENV=read\n");
  bare = join(root, "bare");
  mkdirSync(bare);
  for (const project of [fixture, bare]) {
    writeFileSync(join(project, "plain.ts"), PLAIN);
    writeFileSync(join(project, "events.ts"), EVENTS);
  }
  writeFileSync(join(fixture, "sender.ts"), sender(join(bare, "events.ts")));
  writeFileSync(join(bare, "sender.ts"), sender(join(fixture, "events.ts")));
}, 60_000);

afterAll(() => rmSync(root, { recursive: true, force: true }));

function copyPackage(name: string, to: string): void {
  cpSync(join(PACKAGES, name), to, {
    recursive: true,
    filter: (path) => !path.includes("node_modules") && !path.endsWith(".test.ts"),
  });
  const manifest = join(to, "package.json");
  const read = JSON.parse(readFileSync(manifest, "utf8")) as { version: string };
  writeFileSync(manifest, JSON.stringify({ ...read, version: FIXTURE }, null, 2));
}

const PLAIN = `import * as surface from "agentswf/workflow";
export default surface.defineWorkflow({
  meta: { name: "plain", description: "Says which surface it got." },
  run: async () => ({ fixture: "fixtureMarker" in surface, env: process.env.FROM_DOT_ENV ?? null }),
});
`;

// With `fail-first` beside it, fails its first attempt, so a tick has something to continue.
const EVENTS = `import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as surface from "agentswf/workflow";
export default surface.defineWorkflow({
  meta: { name: "events", description: "Says which surface it got." },
  file: import.meta.path,
  events: { ping: { type: "object", properties: {}, additionalProperties: false } },
  run: async () => {
    const once = join(import.meta.dir, "failed-once");
    if (existsSync(join(import.meta.dir, "fail-first")) && !existsSync(once)) {
      writeFileSync(once, "");
      throw new Error("the first attempt fails");
    }
    return { fixture: "fixtureMarker" in surface, env: process.env.FROM_DOT_ENV ?? null };
  },
});
`;

/** A run that emits to `target`'s run `w1`, and returns what came of it. */
function sender(target: string): string {
  return `import * as surface from "agentswf/workflow";
import target from ${JSON.stringify(target)};
export default surface.defineWorkflow({
  meta: { name: "sender", description: "Emits to another project's workflow." },
  run: async (wf) => {
    try {
      return await wf.emit(target, "w1", "ping", {});
    } catch (error) {
      return String(error);
    }
  },
});
`;
}

async function awf(
  argv: string[],
  cwd: string,
  environment: Record<string, string> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn({
    cmd: [process.execPath, "--no-env-file", AWF, ...argv],
    cwd,
    env: { ...process.env, HOME: home, AWF_ENGINE: "", ...environment },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stdout, stderr };
}

function invocations(): { version: string; argv: string[] }[] {
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

/** What a run's last attempt returned, once it has. */
async function completed(project: string, ref: string): Promise<unknown> {
  const output = join(project, ".awf/runs", ref, "output.json");
  const giveUp = Date.now() + 30_000;
  for (;;) {
    if (existsSync(output)) {
      const read = JSON.parse(readFileSync(output, "utf8")) as { outcome: string; value?: unknown };
      if (read.outcome === "completed") return read.value;
    }
    if (Date.now() > giveUp)
      throw new Error(
        `${ref} never completed: ${existsSync(output) ? readFileSync(output, "utf8") : "no output"}`,
      );
    await Bun.sleep(100);
  }
}

test("every command, and the attempt a wake launches, runs on the project's engine", async () => {
  // A fresh clone: no .awf yet.
  expect(existsSync(join(fixture, ".awf"))).toBe(false);
  const plain = await awf(["run", "plain.ts", "--json"], fixture);
  expect(plain.stderr).toContain(`awf ${ENGINE_VERSION} is not this project's ${FIXTURE}`);
  expect(JSON.parse(plain.stdout).value).toEqual({ fixture: true, env: null });
  expect(invocations().at(-1)).toEqual({ version: FIXTURE, argv: ["run", "plain.ts", "--json"] });

  const emitted = await awf(
    ["emit", "--target", "events.ts", "--id", "e1", "ping", "{}", "--json"],
    fixture,
  );
  expect(JSON.parse(emitted.stdout)).toMatchObject({ outcome: "accepted", did: "started" });
  // The detached attempt: the copy's own CLI, which reads the project's .env.
  expect(await completed(fixture, "events/e1")).toEqual({ fixture: true, env: "read" });
  expect(invocations().some((each) => each.argv[0] === "run" && each.argv.includes("e1"))).toBe(
    true,
  );
  expect(invocations().every((each) => each.version === FIXTURE)).toBe(true);

  // Now with an .awf: still handed over.
  const runs = await awf(["runs", "events/e1", "--json"], fixture);
  expect(JSON.parse(runs.stdout).run.state).toBe("completed");
  expect(invocations().at(-1)?.argv).toEqual(["runs", "events/e1", "--json"]);

  // From outside the project, on the global: the run is found and refused, naming the project.
  const elsewhere = await awf(["runs", "events/e1", "--json"], root);
  // As a run this engine can't read: 3.
  expect(elsewhere.code).toBe(3);
  expect(elsewhere.stderr).toContain(
    `${fixture} runs on its agentswf ${FIXTURE}, and this awf is ${ENGINE_VERSION}: run the project's, bunx awf, from ${fixture}`,
  );
  // wf.emit from the global's run into the fixture's project is refused; from the fixture's into a
  // project with no agentswf, taken.
  const refused = await awf(["run", "sender.ts", "--json"], bare);
  expect(JSON.parse(refused.stdout).value).toContain(`${fixture} runs on its agentswf ${FIXTURE}`);
  const taken = await awf(["run", "sender.ts", "--json"], fixture);
  expect(JSON.parse(taken.stdout).value).toBe("accepted");
  // A project with no agentswf runs on whichever engine wakes it: here, the fixture's.
  expect(await completed(bare, "events/w1")).toEqual({ fixture: true, env: null });
}, 90_000);

test("awf tick --all from a third project wakes each project on its own engine", async () => {
  // A run in each project whose first attempt fails, for the tick to continue.
  for (const project of [fixture, bare]) {
    writeFileSync(join(project, "fail-first"), "");
    const sent = await awf(
      ["emit", "--target", "events.ts", "--id", "t1", "ping", "{}", "--json"],
      project,
    );
    expect(JSON.parse(sent.stdout)).toMatchObject({ did: "started" });
  }
  for (const project of [fixture, bare]) {
    const state = join(project, ".awf/runs/events/t1/attempts/1.json");
    const giveUp = Date.now() + 30_000;
    while (!(existsSync(state) && JSON.parse(readFileSync(state, "utf8")).outcome === "failed")) {
      if (Date.now() > giveUp) throw new Error(`${project}'s t1 never failed`);
      await Bun.sleep(100);
    }
  }
  const declared = join(root, "declared");
  mkdirSync(join(declared, ".awf"), { recursive: true });
  writeFileSync(
    join(declared, "package.json"),
    JSON.stringify({ dependencies: { agentswf: "*" } }),
  );
  // An event run there, which a tick would wake: a project with none is passed over.
  await createRun(join(declared, ".awf/runs"), {
    id: "d1",
    workflow: "events",
    argv: [],
    cwd: declared,
    sandbox: null,
    events: true,
  });
  writeFileSync(
    join(home, ".awf/projects"),
    `${readFileSync(join(home, ".awf/projects"), "utf8")}${declared}\n`,
  );
  // A third project, pinning a version neither is at: tick --all names no project, so it is
  // never handed over by the directory it is typed in.
  const third = join(root, "third");
  mkdirSync(join(third, "node_modules/agentswf"), { recursive: true });
  writeFileSync(
    join(third, "node_modules/agentswf/package.json"),
    JSON.stringify({ version: "0.0.0-third", bin: { awf: "./missing.ts" } }),
  );
  const before = invocations().length;
  const ticked = await awf(["tick", "--all", "--json"], third);
  expect(ticked.code).toBe(1);
  expect(ticked.stderr).toContain(`${declared} declares agentswf`);
  expect(ticked.stderr).toContain("run bun install there");
  expect(JSON.parse(ticked.stdout).woke).toEqual(
    expect.arrayContaining([
      { ref: "events/t1", did: "continued", why: "failed" },
      { ref: "events/t1", did: "continued", why: "failed" },
    ]),
  );
  expect(JSON.parse(ticked.stdout).woke).toHaveLength(2);
  // The fixture's tick ran on the fixture's engine, in its directory; the bare project's on the
  // global, in-process, which the copy never logs.
  const since = invocations().slice(before);
  expect(since.find((each) => each.argv[0] === "tick")).toEqual({
    version: FIXTURE,
    argv: ["tick", "--run-root", join(fixture, ".awf/runs"), "--json"],
  });
  expect(await completed(fixture, "events/t1")).toEqual({ fixture: true, env: "read" });
  expect(await completed(bare, "events/t1")).toEqual({ fixture: false, env: null });
}, 120_000);
