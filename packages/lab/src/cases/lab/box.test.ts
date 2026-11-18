import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { awfArgv } from "../../shared/runner";
import {
  awfReads,
  boxNetwork,
  boxProfile,
  hiddenAround,
  hiddenOf,
  MODEL_DOMAINS,
  toolchainOf,
} from "./box";
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
  // An older lab's fixtures, tracked, holding a key: hidden only by `hide`.
  mkdirSync(join(root, "datasets/old"), { recursive: true });
  writeFileSync(join(root, "datasets/old/key.json"), "the old key\n");
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
    hide: ["datasets"],
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
      join(root, "datasets"),
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

  test("a copy whose node_modules links an install reads the install's folder and its links", () => {
    const { top, root } = project();
    const copy = join(top, "copy");
    mkdirSync(copy);
    symlinkSync(join(root, "node_modules"), join(copy, "node_modules"));
    mkdirSync(join(top, "pkg"));
    symlinkSync(join(top, "pkg"), join(root, "node_modules", "linked"));
    const reads = toolchainOf(copy, "/usr/bin:/bin");
    expect(reads).toContain(join(root, "node_modules"));
    expect(reads).toContain(join(top, "pkg"));
  });

  test("never reads the home folder, nor an awf checkout's examples/, which hold datasets", () => {
    const { top, root } = project();
    const home = join(top, "home");
    mkdirSync(join(home, "bin"), { recursive: true });
    writeFileSync(join(home, "bin", "claude"), "#!/bin/sh\n", { mode: 0o755 });
    const reads = toolchainOf(root, `${join(home, "bin")}:/usr/bin:/bin`, home);
    expect(reads).not.toContain(home);
    expect(reads).toContain(join(home, "bin"));
    const awf = join(top, "awf");
    for (const dir of ["packages/agentswf/src", "examples/shop/evals", "node_modules"]) {
      mkdirSync(join(awf, dir), { recursive: true });
    }
    writeFileSync(join(awf, "package.json"), "{}\n");
    writeFileSync(join(awf, "packages/agentswf/src/awf.ts"), "\n");
    const awfDirs = awfReads({ bin: join(awf, "packages/agentswf/src/awf.ts") });
    expect(awfDirs).toContain(join(awf, "packages"));
    expect(awfDirs).not.toContain(join(awf, "examples"));
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
      expect(read(join(root, "datasets/old/key.json"))).toBe(false);
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

describe.skipIf(!srt || process.platform !== "darwin")("a loop's proposer under srt", () => {
  test("writes the try's copy but not its evals/, reads its bundle, and nothing else of the store", () => {
    const { top, root, trial, caseDir } = project();
    // The store inside the lab's home, both hidden, as on a machine.
    const labHome = join(top, "lab-home");
    const store = join(labHome, "project-1");
    // A try's copy and bundle inside the store, as a loop keeps them.
    const tryDir = join(store, "loops/l/tries/1");
    const code = join(tryDir, "code");
    const bundle = join(tryDir, "bundle");
    for (const dir of [
      join(code, "evals/ds"),
      bundle,
      join(store, "runs/other"),
      join(labHome, "trials"),
      join(tryDir, "proposer/home"),
      join(tryDir, "proposer/runs"),
    ]) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(join(code, "evals/ds/env.ts"), "export default {};\n");
    writeFileSync(join(bundle, "feedback.json"), "[]\n");
    writeFileSync(join(store, "runs/other/trial.json"), "{}\n");
    const workspace: CaseWorkspace = {
      config: join(root, "evals/awf-lab.json"),
      evals: join(root, "evals"),
      root,
      store,
      labHome,
    };
    const profile = boxProfile(
      {
        root,
        caseDir: bundle,
        scratch: code,
        runRoot: join(tryDir, "proposer/runs"),
        home: join(tryDir, "proposer/home"),
        trialFile: join(tryDir, "proposer/trial.jsonl"),
        control: join(trial, "control"),
        // A read that reaches the workspace's own checkout, as an install linked back into it does.
        toolchain: [root],
        hidden: [
          ...hiddenOf(code, workspace).filter((path) => path !== store && path !== labHome),
          ...hiddenAround(labHome, [tryDir]),
        ],
        readOnly: [join(code, "evals")],
        reads: [tryDir],
      },
      [],
    );
    const file = join(top, "proposer-box.json");
    writeFileSync(file, JSON.stringify(profile));
    const sh = (script: string) =>
      Bun.spawnSync([srt!, "-s", file, "--", "/bin/sh", "-c", script], {
        cwd: code,
        stdout: "ignore",
        stderr: "ignore",
      }).exitCode === 0;
    expect(sh(`echo x > '${join(code, "workflow.ts")}'`)).toBe(true);
    expect(sh(`echo x > '${join(code, "evals/ds/env.ts")}'`)).toBe(false);
    expect(sh(`cat '${join(bundle, "feedback.json")}'`)).toBe(true);
    expect(sh(`cat '${join(root, "workflow.ts")}'`)).toBe(true);
    expect(sh(`cat '${join(caseDir, "key.md")}'`)).toBe(false);
    expect(sh(`cat '${join(caseDir, "key/answer.txt")}'`)).toBe(false);
    expect(sh(`cat '${join(store, "runs/other/trial.json")}'`)).toBe(false);
    expect(sh(`echo x > '${join(bundle, "feedback.json")}'`)).toBe(false);
    expect(sh(`mkdir -p '${join(tryDir, "proposer/home/.awf")}'`)).toBe(true);
    // An agent's shell is zsh, whose here-documents go to TMPPREFIX, under the box's home.
    const tmp = join(tryDir, "proposer/home/tmp");
    mkdirSync(tmp, { recursive: true });
    const zsh = Bun.spawnSync(
      [srt!, "-s", file, "--", "/bin/zsh", "-c", `cat > '${join(code, "notes.ts")}' <<'E'\nx\nE`],
      {
        cwd: code,
        env: { ...process.env, TMPPREFIX: join(tmp, "zsh") },
        stdout: "ignore",
        stderr: "ignore",
      },
    );
    expect(zsh.exitCode).toBe(0);
    // The proposer's agent starts in the try's folder.
    expect(sh(`cd '${tryDir}' && ls`)).toBe(true);
    expect(sh(`echo x > '${join(tryDir, "planted.json")}'`)).toBe(false);
  }, 60_000);
});
