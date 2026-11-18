import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { awfArgv } from "../../shared/runner";
import { boxNetwork, boxProfile, hiddenOf, MODEL_DOMAINS } from "./box";
import type { CaseWorkspace } from "./workspace";

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) =>
  Bun.spawnSync(["git", ...args], { cwd, stdout: "ignore", stderr: "ignore" });

/** A project with a key, an ignored `.env`, its git history, a store and a trial's folders. */
function project() {
  const top = realpathSync(mkdtempSync(join(tmpdir(), "awf-lab-box-")));
  roots.push(top);
  const root = join(top, "project");
  const evals = join(root, "evals");
  const caseDir = join(evals, "ds/cases/a");
  mkdirSync(join(caseDir, "key"), { recursive: true });
  mkdirSync(join(root, "node_modules/dep"), { recursive: true });
  writeFileSync(join(root, "workflow.ts"), "export const code = true;\n");
  writeFileSync(join(root, ".gitignore"), ".env\nnode_modules/\n");
  writeFileSync(join(root, ".env"), "SECRET=1\n");
  writeFileSync(join(root, "node_modules/dep/index.js"), "module.exports = 1;\n");
  writeFileSync(join(evals, "ds/dataset.json"), "{}\n");
  writeFileSync(join(caseDir, "key.md"), "the key\n");
  writeFileSync(join(caseDir, "key/answer.txt"), "the answer\n");
  git(root, "init", "-q");
  git(root, "add", "-A");
  git(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base");
  const store = join(top, "store");
  const trial = join(top, "trial");
  for (const dir of [
    store,
    join(trial, "case"),
    join(trial, "scratch"),
    join(trial, "runs"),
    join(trial, "home"),
  ]) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(join(store, "record.json"), "{}\n");
  writeFileSync(join(trial, "case", "email.json"), "{}\n");
  const workspace: CaseWorkspace = {
    config: join(evals, "awf-lab.json"),
    evals,
    root,
    store,
    labHome: join(top, "lab-home"),
  };
  const profile = boxProfile(
    {
      root,
      caseDir: join(trial, "case"),
      scratch: join(trial, "scratch"),
      runRoot: join(trial, "runs"),
      home: join(trial, "home"),
      trialFile: join(trial, "trial.jsonl"),
      control: join(trial, "control"),
      toolchain: [],
      hidden: hiddenOf(root, workspace),
    },
    boxNetwork({ network: ["shop.example"] }, ["helpdesk.example", "localhost"]),
  );
  return { top, root, caseDir, store, trial, profile };
}

describe("the lab's box", () => {
  test("hides keys, git history, ignored files, the store and the home folder; shows the rest", () => {
    const { root, caseDir, store, trial, profile } = project();
    const { denyRead, allowRead, allowWrite } = profile.filesystem;
    for (const hidden of [
      join(caseDir, "key.md"),
      join(caseDir, "key"),
      join(root, ".git"),
      join(root, ".env"),
      store,
      realpathSync(homedir()),
    ]) {
      expect(denyRead).toContain(hidden);
    }
    expect(denyRead).not.toContain(join(root, "node_modules"));
    expect(allowRead).toContain(root);
    expect(allowRead).toContain(join(trial, "case"));
    expect(allowWrite).toEqual(
      expect.arrayContaining([join(trial, "scratch"), join(trial, "home")]),
    );
    expect(allowWrite).not.toContain(root);
  });

  test("reaches agents' reach, every harness's model domains and the workflow's real hosts", () => {
    const { profile } = project();
    const domains = profile.network.allowedDomains;
    expect(domains).toEqual(
      expect.arrayContaining([
        "shop.example",
        "helpdesk.example",
        ...Object.values(MODEL_DOMAINS).flat(),
      ]),
    );
    expect(domains).not.toContain("localhost");
  });

  test("a boxed run asks awf to set the workflow's sandboxes aside", () => {
    const argv = awfArgv({
      workflow: "env.ts",
      cwd: "/s",
      timeout: "5m",
      argv: [],
      runRoot: "/r",
      id: "x",
      boxed: true,
    });
    expect(argv).toContain("--boxed");
  });
});

const srt = Bun.which("srt", {
  PATH: [process.env.PATH, join(homedir(), ".local/share/mise/installs/node/22.20.0/bin")].join(
    ":",
  ),
});

describe.skipIf(!srt || process.platform !== "darwin")("the box under srt", () => {
  test("nothing in it reads a key, git history, an ignored file, the store or ~; the code it reads", () => {
    const { top, root, caseDir, store, trial, profile } = project();
    const file = join(top, "box.json");
    writeFileSync(file, JSON.stringify(profile));
    const canary = join(realpathSync(homedir()), `.awf-lab-box-canary-${crypto.randomUUID()}`);
    writeFileSync(canary, "home");
    try {
      const read = (path: string) =>
        Bun.spawnSync([srt!, "-s", file, "--", "/bin/cat", path], {
          cwd: join(trial, "scratch"),
          stdout: "pipe",
          stderr: "pipe",
        }).exitCode === 0;
      expect(read(join(root, "workflow.ts"))).toBe(true);
      expect(read(join(root, "node_modules/dep/index.js"))).toBe(true);
      expect(read(join(trial, "case", "email.json"))).toBe(true);
      expect(read(join(caseDir, "key.md"))).toBe(false);
      expect(read(join(caseDir, "key/answer.txt"))).toBe(false);
      expect(read(join(root, ".env"))).toBe(false);
      expect(read(join(root, ".git/HEAD"))).toBe(false);
      expect(read(join(store, "record.json"))).toBe(false);
      expect(read(canary)).toBe(false);
      const write = (path: string) =>
        Bun.spawnSync([srt!, "-s", file, "--", "/bin/sh", "-c", `echo x > '${path}'`], {
          cwd: join(trial, "scratch"),
          stdout: "ignore",
          stderr: "ignore",
        }).exitCode === 0;
      expect(write(join(trial, "scratch", "out.txt"))).toBe(true);
      expect(write(join(root, "planted.ts"))).toBe(false);
    } finally {
      rmSync(canary, { force: true });
    }
  }, 60_000);
});
