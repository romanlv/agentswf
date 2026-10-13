import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import root from "../package.json" with { type: "json" };
import { DEV_DEPENDENCIES, parseInitCommand } from "../packages/engine/src/init-command";
import { runOperatorCli } from "../packages/engine/src/operator-cli";
import { createTempRunDirs } from "../packages/engine/src/testing";

const ROOT = resolve(import.meta.dir, "..");
const dirs = createTempRunDirs();
afterAll(() => dirs.cleanup());

async function awf(argv: string[], cwd: string, install?: (dir: string) => Promise<number>) {
  const output: string[] = [];
  const exitCode = await runOperatorCli(argv, {
    cwd,
    stdout: (text) => output.push(text),
    stderr: (text) => output.push(text),
    ...(install ? { install } : {}),
  });
  return { exitCode, output: output.join("\n") };
}

describe("awf init", () => {
  test("an empty folder passes awf test and tsc at once, and init a second time writes nothing", async () => {
    const dir = dirs.tempRunDir();
    const init = await awf(["init", "--no-install"], dir);
    expect(init.exitCode).toBe(0);
    expect(init.output).toContain("created  hello/workflow.test.ts");
    expect(init.output).toContain("  bun install\n");

    const tests = await awf(["test"], dir);
    expect(tests.output).toContain("2 pass");
    expect(tests.exitCode).toBe(0);

    // What bun install would give it, from this repository's copies.
    mkdirSync(join(dir, "node_modules/@types"), { recursive: true });
    symlinkSync(join(ROOT, "packages/agentswf"), join(dir, "node_modules/agentswf"));
    symlinkSync(
      join(ROOT, "packages/engine/node_modules/typebox"),
      join(dir, "node_modules/typebox"),
    );
    symlinkSync(join(ROOT, "node_modules/@types/bun"), join(dir, "node_modules/@types/bun"));
    const tsc = Bun.spawnSync([join(ROOT, "node_modules/.bin/tsc"), "--noEmit", "-p", dir]);
    expect(tsc.stdout.toString()).toBe("");
    expect(tsc.exitCode).toBe(0);

    const again = await awf(["init", "--no-install"], dir);
    expect(again.output).not.toContain("created");
    expect(again.output).not.toContain("updated");
  }, 30_000);

  test("an existing package.json and .gitignore keep what they have and gain what they lack", async () => {
    const dir = dirs.tempRunDir();
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify(
        { name: "mine", scripts: { test: "vitest" }, dependencies: { typebox: "^1.0.0" } },
        null,
        4,
      ),
    );
    writeFileSync(join(dir, ".gitignore"), "/node_modules");
    const init = await awf(["init", "--no-install"], dir);
    expect(init.output).toContain(
      "updated  package.json (added @types/bun, agentswf, typescript, the check script)",
    );
    expect(init.output).toContain("updated  .gitignore (added .awf/)");
    const text = readFileSync(join(dir, "package.json"), "utf8");
    expect(text).toStartWith('{\n    "name"');
    const written = JSON.parse(text);
    expect(written.name).toBe("mine");
    expect(written.scripts).toEqual({ test: "vitest", check: "tsc --noEmit" });
    expect(written.dependencies).toEqual({ typebox: "^1.0.0" });
    expect(Object.keys(written.devDependencies)).toEqual(["@types/bun", "agentswf", "typescript"]);
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toBe("/node_modules\n.awf/\n");
  });

  test("a package.json that isn't JSON stops init before it writes anything", async () => {
    const dir = dirs.tempRunDir();
    writeFileSync(join(dir, "package.json"), "{ nope");
    const init = await awf(["init", "--no-install"], dir);
    expect(init.exitCode).toBe(1);
    expect(init.output).toContain("awf: package.json is not JSON");
    expect(await Bun.file(join(dir, "hello/workflow.ts")).exists()).toBe(false);
  });

  test("a package.json that is JSON but not an object stops init too", async () => {
    const dir = dirs.tempRunDir();
    writeFileSync(join(dir, "package.json"), "[1, 2]");
    const init = await awf(["init", "--no-install"], dir);
    expect(init.output).toContain("awf: package.json is not a JSON object");
    expect(readFileSync(join(dir, "package.json"), "utf8")).toBe("[1, 2]");
  });

  test("a path in the way stops init before it writes anything", async () => {
    const dir = dirs.tempRunDir();
    writeFileSync(join(dir, "hello"), "");
    const init = await awf(["init", "--no-install"], dir);
    expect(init.exitCode).toBe(1);
    expect(init.output).toContain("awf: hello exists and is not a directory");
    expect(await Bun.file(join(dir, "package.json")).exists()).toBe(false);
  });

  test("a symlink is skipped, never written through, even one that points nowhere", async () => {
    const dir = dirs.tempRunDir();
    const elsewhere = dirs.tempRunDir();
    symlinkSync(join(elsewhere, "agents.md"), join(dir, "AGENTS.md"));
    symlinkSync(join(elsewhere, "package.json"), join(dir, "package.json"));
    const init = await awf(["init", "--no-install"], dir);
    expect(init.exitCode).toBe(0);
    expect(init.output).toContain("skipped  AGENTS.md (a symlink)");
    expect(init.output).toContain("skipped  package.json (a symlink)");
    expect(await Bun.file(join(elsewhere, "agents.md")).exists()).toBe(false);
    expect(await Bun.file(join(elsewhere, "package.json")).exists()).toBe(false);
  });

  test("into a new folder it installs there, and the next steps start with cd", async () => {
    const dir = dirs.tempRunDir();
    const installed: string[] = [];
    const init = await awf(["init", "my workflows"], dir, async (into) => {
      installed.push(into);
      return 0;
    });
    expect(init.exitCode).toBe(0);
    expect(installed).toEqual([join(dir, "my workflows")]);
    expect(init.output).toContain("  cd 'my workflows'\n  awf test");
    const written = JSON.parse(readFileSync(join(dir, "my workflows/package.json"), "utf8"));
    expect(written.name).toBe("my-workflows");
  });

  test("a failed install says so, after the files are written", async () => {
    const dir = dirs.tempRunDir();
    const init = await awf(["init"], dir, async () => 1);
    expect(init.exitCode).toBe(1);
    expect(init.output).toContain("  bun install\n");
    expect(init.output).toContain("awf: bun install failed");
  });

  test("its dev dependencies are the versions this repository builds with", () => {
    expect(DEV_DEPENDENCIES).toMatchObject(root.workspaces.catalog);
  });

  test("agentswf is pinned to its own version, which is the engine's", () => {
    const version = (name: string) =>
      JSON.parse(readFileSync(join(ROOT, `packages/${name}/package.json`), "utf8")).version;
    expect(version("agentswf")).toBe(version("engine"));
    expect(DEV_DEPENDENCIES.agentswf).toBe(`^${version("agentswf")}`);
  });

  test("the README's hello workflow is the one init writes, without its comments", () => {
    const readme = readFileSync(join(ROOT, "README.md"), "utf8");
    const quoted = /```ts\n\/\/ hello\/workflow\.ts\n([\s\S]*?)```/.exec(readme)?.[1];
    const template = readFileSync(
      join(ROOT, "packages/engine/src/init-template/hello/workflow.ts.template"),
      "utf8",
    );
    const uncommented = template
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    expect(quoted).toBe(uncommented);
  });

  test("usage errors", () => {
    expect(parseInitCommand(["-h"], "/tmp")).toBe("help");
    expect(() => parseInitCommand(["--force"], "/tmp")).toThrow("unknown option: --force");
    expect(() => parseInitCommand(["a", "b"], "/tmp")).toThrow("one directory only");
  });
});
