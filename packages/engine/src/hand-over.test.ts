import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handOverTarget, installedEngine, projectEngine } from "./hand-over";
import { checkProjectEngine, ENGINE_VERSION, EngineRefused, engineOf } from "./project-engine";

const AWF = join(import.meta.dir, "../../agentswf/src/awf.ts");
const OWN_AGENTSWF = realpathSync(join(import.meta.dir, "../../agentswf"));

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "awf-hand-over-")));
  dirs.push(dir);
  return dir;
}

/**
 * A project whose `node_modules/agentswf` is a stand-in `awf` at `version`, which prints what it
 * was given; with `--sigint`, it waits for one and takes its time to end.
 */
function project(version: string): { dir: string; engine: string } {
  const dir = tempDir();
  const engine = join(dir, "node_modules", "agentswf");
  mkdirSync(engine, { recursive: true });
  writeFileSync(
    join(engine, "package.json"),
    JSON.stringify({ name: "agentswf", version, bin: { awf: "./awf.ts" } }),
  );
  writeFileSync(
    join(engine, "awf.ts"),
    `const said = { argv: process.argv.slice(2), engine: process.env.AWF_ENGINE, cwd: process.cwd(), env: process.env.FROM_DOT_ENV ?? null };
if (process.argv.includes("--sigint")) {
  process.on("SIGINT", async () => {
    await Bun.sleep(400);
    console.log(JSON.stringify({ ...said, ended: true }));
    process.exit(7);
  });
  console.log("ready");
  await Bun.sleep(20_000);
}
console.log(JSON.stringify(said));
process.exit(Number(process.env.STAND_IN_EXIT ?? 0));
`,
  );
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ devDependencies: { agentswf: version } }),
  );
  writeFileSync(join(dir, ".env"), "FROM_DOT_ENV=read\n");
  return { dir, engine: realpathSync(engine) };
}

async function globalAwf(
  argv: string[],
  cwd: string,
  environment: Record<string, string> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn({
    cmd: [process.execPath, "--no-env-file", AWF, ...argv],
    cwd,
    env: { ...process.env, ...environment },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stdout, stderr };
}

describe("finding a project's engine", () => {
  test("by walking up for node_modules/agentswf/package.json, its installed version", () => {
    const { dir, engine } = project("0.0.0-fixture");
    const below = join(dir, "flows", "deep");
    mkdirSync(below, { recursive: true });
    expect(installedEngine(below)).toEqual({
      dir: engine,
      root: dir,
      version: "0.0.0-fixture",
      bin: join(engine, "awf.ts"),
    });
    expect(projectEngine(below)).toMatchObject({ kind: "installed", version: "0.0.0-fixture" });
  });

  test("declared and not installed, or none at all, by the nearest package.json", () => {
    const declared = tempDir();
    writeFileSync(
      join(declared, "package.json"),
      JSON.stringify({ devDependencies: { agentswf: "^0.1.0" } }),
    );
    expect(projectEngine(declared)).toEqual({
      kind: "declared",
      manifest: join(declared, "package.json"),
    });
    expect(projectEngine(tempDir())).toEqual({ kind: "none" });
    // A package of its own below a parent that declares it: the parent's isn't this one's.
    const app = join(declared, "app");
    mkdirSync(app);
    writeFileSync(join(app, "package.json"), JSON.stringify({ name: "app" }));
    expect(projectEngine(app)).toEqual({ kind: "none" });
  });

  test("an install whose manifest gives no version or awf is broken, as one not installed", () => {
    const dir = tempDir();
    mkdirSync(join(dir, "node_modules", "agentswf"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "agentswf", "package.json"), "{");
    expect(installedEngine(dir)).toBeUndefined();
    expect(projectEngine(dir)).toEqual({
      kind: "declared",
      manifest: join(dir, "node_modules", "agentswf", "package.json"),
    });
  });

  test("handed over only to another version, and never for init, help, --version or tick --all", () => {
    const { dir } = project("0.0.0-fixture");
    expect(handOverTarget(["runs"], dir, "0.0.0-fixture")).toBeUndefined();
    expect(handOverTarget(["runs"], dir, ENGINE_VERSION)?.version).toBe("0.0.0-fixture");
    for (const argv of [
      ["init"],
      ["help"],
      ["-h"],
      ["--help"],
      ["--version"],
      ["tick", "--all"],
      [],
    ])
      expect(handOverTarget(argv, dir, ENGINE_VERSION)).toBeUndefined();
    expect(handOverTarget(["tick"], dir, ENGINE_VERSION)?.version).toBe("0.0.0-fixture");
    expect(handOverTarget(["runs"], tempDir(), ENGINE_VERSION)).toBeUndefined();
  });
});

describe("the engine's check", () => {
  const refused = (work: () => void) => {
    try {
      work();
    } catch (error) {
      if (error instanceof EngineRefused) return { code: error.code, message: error.message };
      throw error;
    }
    return undefined;
  };

  test("refuses a project at another version, or declared and not installed, naming what to do", () => {
    const { dir } = project("0.0.0-fixture");
    expect(refused(() => checkProjectEngine(dir))).toEqual({
      code: "other-engine",
      message: expect.stringContaining(`run the project's, bunx awf, from ${dir}`),
    });
    const declared = tempDir();
    writeFileSync(
      join(declared, "package.json"),
      JSON.stringify({ dependencies: { agentswf: "*" } }),
    );
    expect(refused(() => checkProjectEngine(declared))).toEqual({
      code: "no-engine",
      message: expect.stringContaining("run bun install there"),
    });
  });

  test("runs a project at its version, or with none; a client refuses one with none", () => {
    const { dir } = project(ENGINE_VERSION);
    expect(refused(() => checkProjectEngine(dir))).toBeUndefined();
    const none = tempDir();
    expect(refused(() => checkProjectEngine(none))).toBeUndefined();
    expect(refused(() => checkProjectEngine(none, { client: true }))?.code).toBe("no-engine");
    expect(refused(() => checkProjectEngine(dir, { client: true }))).toBeUndefined();
  });

  test("refuses a file that resolves another version than its project", () => {
    const { dir } = project(ENGINE_VERSION);
    const nested = join(dir, "flows");
    fakeInstall(nested, "0.0.0-other");
    const file = join(nested, "flow.ts");
    expect(refused(() => checkProjectEngine(dir, { file }))).toEqual({
      code: "other-engine",
      message: expect.stringContaining("one project runs on one engine"),
    });
    expect(refused(() => checkProjectEngine(dir, { file: join(dir, "flow.ts") }))).toBeUndefined();
  });

  test("a project with none above it runs on the one its files resolve, which must agree", () => {
    // A workspace: .awf/ at the root, each package with a node_modules of its own.
    const workspace = tempDir();
    mkdirSync(join(workspace, ".awf"));
    fakeInstall(join(workspace, "a"), "0.0.0-other");
    fakeInstall(join(workspace, "b"), "0.0.0-third");
    const a = join(workspace, "a", "flow.ts");
    const b = join(workspace, "b", "flow.ts");
    expect(engineOf(workspace)).toEqual({ kind: "none" });
    expect(engineOf(workspace, [a])).toMatchObject({
      kind: "installed",
      version: "0.0.0-other",
      root: join(workspace, "a"),
    });
    expect(refused(() => checkProjectEngine(workspace, { file: a }))?.message).toContain(
      `run the project's, bunx awf, from ${join(workspace, "a")}`,
    );
    expect(refused(() => engineOf(workspace, [a, b]))?.message).toContain(
      "one project runs on one engine",
    );
  });
});

/** A stand-in `agentswf` at `version` installed in `dir`'s `node_modules`. */
function fakeInstall(dir: string, version: string): void {
  mkdirSync(join(dir, "node_modules", "agentswf"), { recursive: true });
  writeFileSync(
    join(dir, "node_modules", "agentswf", "package.json"),
    JSON.stringify({ version, bin: { awf: "./awf.ts" } }),
  );
}

describe("the global awf", () => {
  test("hands a project at another version over to its awf, with a warning, argv and cwd kept", async () => {
    const { dir, engine } = project("0.0.0-fixture");
    const below = join(dir, "flows");
    mkdirSync(below);
    const { code, stdout, stderr } = await globalAwf(["runs", "--json", "x/y"], below, {
      STAND_IN_EXIT: "3",
    });
    expect(code).toBe(3);
    expect(JSON.parse(stdout)).toEqual({
      argv: ["runs", "--json", "x/y"],
      engine,
      cwd: below,
      // Handed over, it reads no .env, as the global doesn't.
      env: null,
    });
    expect(stderr).toBe(
      `awf: awf ${ENGINE_VERSION} is not this project's 0.0.0-fixture; running the project's. Update one, or run bunx awf here.\n`,
    );
  });

  test("runs the command itself at the same version, with no warning", async () => {
    const { dir } = project(ENGINE_VERSION);
    const { code, stdout, stderr } = await globalAwf(
      ["runs", "--run-root", join(dir, "runs")],
      dir,
    );
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    expect(stdout).not.toContain("argv");
  });

  test("an awf AWF_ENGINE names doesn't hand over; one it doesn't name does", async () => {
    const { dir, engine } = project("0.0.0-fixture");
    const named = await globalAwf(["runs", "--run-root", join(dir, "runs")], dir, {
      AWF_ENGINE: OWN_AGENTSWF,
    });
    expect(named.stdout).not.toContain("argv");
    expect(named.stderr).not.toContain("running the project's");
    // An agent of a handed-over run inherits AWF_ENGINE naming the project's engine; the global
    // it runs is another, and hands over as any command does.
    const other = await globalAwf(["runs"], dir, { AWF_ENGINE: engine });
    expect(JSON.parse(other.stdout).engine).toBe(engine);
  });

  test("--version prints its own and the project's", async () => {
    const { dir, engine } = project("0.0.0-fixture");
    const { stdout } = await globalAwf(["--version"], dir);
    expect(stdout).toContain(`awf ${ENGINE_VERSION}`);
    expect(stdout).toContain(`this project's agentswf 0.0.0-fixture, in ${engine}`);
  });

  test("Ctrl-C returns the prompt only once the child has ended, with its code", async () => {
    const { dir } = project("0.0.0-fixture");
    const parent = Bun.spawn({
      cmd: [process.execPath, "--no-env-file", AWF, "run", "--sigint"],
      cwd: dir,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      // Its own process group, as a shell's foreground job: the terminal's Ctrl-C reaches both.
      detached: true,
    });
    const reader = parent.stdout.getReader();
    let seen = "";
    while (!seen.includes("ready")) {
      const { value, done } = await reader.read();
      if (done) break;
      seen += new TextDecoder().decode(value);
    }
    process.kill(-parent.pid, "SIGINT");
    const code = await parent.exited;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      seen += new TextDecoder().decode(value);
    }
    expect(code).toBe(7);
    expect(seen).toContain('"ended":true');
  });
});
