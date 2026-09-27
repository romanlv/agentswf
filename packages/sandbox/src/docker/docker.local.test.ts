import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { DockerEnvironment } from "@wf/contract/workflow";
import { resolveSandbox } from "../resolve";
import type { Occupant, OpenedSandbox, SandboxProvider } from "../seam";
import { runCommand, sandboxConformance } from "../testing/conformance";
import { createDockerProvider, findDocker } from ".";

// A local test: a real daemon and the default image, `sh` for an agent, no model. Skipped
// without either; build the image with the command `docker.test.ts`'s refusal names.
const found = await findDocker(process.env);
// Asked once, bounded: a hung daemon skips this test rather than hanging it.
const built =
  found &&
  (await found.client.run(["image", "inspect", found.defaultImage], { timeoutMs: 5_000 }))
    .exitCode === 0;
const provider = found && built ? createDockerProvider(found) : undefined;

/** Processes in the box whose command line holds `pattern`, counted inside it. */
async function inBox(pattern: string, occupant: Occupant): Promise<number> {
  // `[s]leep` so the counting shell never counts itself.
  const bracketed = `[${pattern[0]}]${pattern.slice(1)}`;
  const { stdout } = await runCommand(
    occupant.launch({
      argv: ["sh", "-c", `ps -eo stat=,args= | grep -v '^Z' | grep -c '${bracketed}' || true`],
      timeoutMs: 10_000,
    }),
  );
  return Number(stdout.trim()) || 0;
}

sandboxConformance(
  "docker",
  provider && {
    provider,
    confines: true,
    running: inBox,
    environment: { key: "docker", settings: {} },
  },
);

describe.skipIf(!provider)("docker on this machine", () => {
  const root = realpathSync(mkdtempSync(join(realpathSync(homedir()), ".awf-docker-local-")));
  const runRoot = join(root, "runs");
  const work = join(root, "work");
  const outside = join(root, "outside");
  // Not `~`, where this test's files are: resolution would refuse them.
  const otherHome = realpathSync(mkdtempSync(join(tmpdir(), "wf-docker-home-")));
  let opened: OpenedSandbox;
  let occupant: Occupant;
  const sh = (script: string, timeoutMs = 30_000) =>
    runCommand(occupant.launch({ argv: ["sh", "-c", script], cwd: work, timeoutMs }));

  beforeAll(async () => {
    await mkdir(join(work, "out"), { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "canary.txt"), "canary-outside");
    await mkdir(runRoot, { recursive: true });
    await mkdir(join(root, "door"), { recursive: true });
    await writeFile(join(root, "door", "wf.js"), "console.log('bundle')\n");
    const { sandbox } = await resolveSandbox(
      { write: ["out"], network: ["registry.npmjs.org"], docker: {} },
      {
        key: "local",
        cwd: work,
        runRoot,
        harnessState: [],
        providers: { installed: { docker: provider as SandboxProvider<unknown> } },
        home: otherHome,
      },
    );
    const directory = join(runRoot, "run", "local");
    await mkdir(join(directory, "homes", "a1"), { recursive: true });
    opened = await (provider as SandboxProvider<DockerEnvironment>).open(sandbox as never, {
      runRoot,
      directory,
      deadline: { unixMilliseconds: Date.now() + 120_000 },
    });
    occupant = await opened.admit({
      cwd: work,
      home: join(directory, "homes", "a1"),
      door: {
        endpoint: join(root, "none.sock"),
        launcher: join(root, "door", "wf"),
        boxScript: "#!/bin/sh\necho door\n",
        bundle: join(root, "door", "wf.js"),
        reads: [],
      },
      harness: {
        env: {},
        seed: [],
        secrets: {},
        defaults: () => [],
        // Admitted after the box opened: the proxy's list grows to hold it.
        domains: ["pypi.org"],
        command: "sh",
        executable: "/bin/sh",
        reads: [],
      },
    });
  }, 120_000);

  afterAll(async () => {
    await opened?.close();
    await Promise.all([root, otherHome].map((path) => rm(path, { recursive: true, force: true })));
  });

  test("mounts: a host path outside reach is absent, the working directory read-only", async () => {
    const { stdout } = await sh(
      `ls '${outside}' 2>/dev/null || echo absent; echo x > probe.txt 2>/dev/null || echo cwd-read-only; echo x > out/w && echo out-writable`,
    );
    expect(stdout).toContain("absent");
    expect(stdout).toContain("cwd-read-only");
    expect(stdout).toContain("out-writable");
  });

  test("host-run config an agent makes is moved out in the box, and a link it plants is not followed", async () => {
    await writeFile(join(outside, "settings.json"), "operator's");
    const { stdout } = await sh(
      `echo planted > out/.mcp.json && ln -s '${outside}' out/.claude && echo made`,
    );
    expect(stdout).toContain("made");
    // The reap moved both, in the box, where the link names nothing.
    expect(await lstat(join(work, "out", ".mcp.json")).catch(() => undefined)).toBeUndefined();
    expect(await lstat(join(work, "out", ".claude")).catch(() => undefined)).toBeUndefined();
    expect(await readFile(join(outside, "settings.json"), "utf8")).toBe("operator's");
    expect(opened.record?.quarantined).toEqual(
      expect.arrayContaining([join(work, "out", ".mcp.json"), join(work, "out", ".claude")]),
    );
  });

  test("network: the proxy's list only, grown at admission, and no way around it", async () => {
    const curl = (url: string, label: string, flags = "") =>
      `curl -s -m 8 ${flags} -o /dev/null ${url} && echo ${label}-reached || echo ${label}-denied;`;
    const { stdout } = await sh(
      [
        curl("https://registry.npmjs.org", "allowed"),
        curl("https://pypi.org", "grown"),
        curl("https://www.python.org", "other"),
        curl("https://1.1.1.1", "raw"),
        curl("https://registry.npmjs.org", "bypass", '--noproxy "*"'),
        "getent hosts pypi.org >/dev/null && echo dns-reached || echo dns-denied;",
        'timeout 5 bash -c "echo > /dev/tcp/1.1.1.1/53" 2>/dev/null && echo tcp-reached || echo tcp-denied;',
        // The positive control for raw TCP: the proxy itself is reachable.
        "node -e \"require('net').connect(3128, new URL(process.env.HTTPS_PROXY).hostname).on('connect', () => { console.log('proxy-reached'); process.exit(0) }).on('error', () => { console.log('proxy-denied'); process.exit(0) })\";",
      ].join(" "),
      60_000,
    );
    for (const label of ["other", "raw", "bypass", "dns", "tcp"]) {
      expect(stdout).toContain(`${label}-denied`);
    }
    expect(stdout).toContain("allowed-reached");
    expect(stdout).toContain("grown-reached");
    expect(stdout).toContain("proxy-reached");
    // The refusal is in the proxy's log.
    const proxies = await found!.client.run(
      ["ps", "--filter", "label=awf.sandbox", "--filter", "name=-proxy", "--format", "{{.Names}}"],
      { timeoutMs: 10_000 },
    );
    const logs = await Promise.all(
      proxies.stdout
        .trim()
        .split("\n")
        .map((name) => found!.client.run(["logs", name], { timeoutMs: 10_000 })),
    );
    expect(logs.map((log) => log.stdout).join("")).toContain("deny www.python.org:443");
  }, 90_000);

  test("a pane in the box's own Herdr shows its prompt, holds its secret, and ends at release", async () => {
    const home = join(runRoot, "run", "local", "homes", "p1");
    await mkdir(home, { recursive: true });
    const paneOccupant = await opened.admit({
      cwd: work,
      home,
      door: {
        endpoint: join(root, "none-p1.sock"),
        launcher: join(root, "door-p1", "wf"),
        boxScript: "#!/bin/sh\necho door\n",
        bundle: join(root, "door", "wf.js"),
        reads: [],
      },
      harness: {
        env: {},
        seed: [],
        defaults: () => [],
        secrets: { PANE_TOKEN: "pane-'secret" },
        domains: [],
        command: "sh",
        executable: "/bin/sh",
        reads: [],
      },
    });
    const pane = await paneOccupant.pane!();
    if (pane.herdr === "run") throw new Error("a box's pane opens in the box's Herdr");
    const herdr = pane.herdr;
    expect(herdr.watch?.slice(0, 2)).toEqual(["docker", "exec"]);
    const call = async (...args: string[]) => {
      const result = await runCommand(herdr.run(args, 20_000));
      expect(result.exitCode).toBe(0);
      return result.stdout;
    };
    const workspace = JSON.parse(await call("workspace", "create", "--cwd", work, "--no-focus"))
      .result.workspace.workspace_id as string;
    const tab = await call("tab", "create", "--workspace", workspace, "--cwd", work, "--no-focus");
    const paneId = /"pane_id":"([^"]+)"/.exec(tab)![1]!;
    const screen = () => call("pane", "read", paneId);
    const until = async (seen: (shown: string) => boolean) => {
      for (let tries = 0; tries < 60; tries++) {
        if (seen(await screen())) return true;
        await Bun.sleep(250);
      }
      return false;
    };
    const marker = 6000 + Math.floor(Math.random() * 999);
    try {
      expect(await until((shown) => shown.trim() !== "")).toBe(true);
      await call("pane", "run", paneId, pane.prelude);
      const last = (shown: string) =>
        shown
          .split("\n")
          .filter((line) => line.trim() !== "")
          .at(-1) ?? "";
      expect(await until((shown) => last(shown).trimEnd().endsWith(pane.ready.trimEnd()))).toBe(
        true,
      );
      await call("pane", "run", paneId, `sleep ${marker} &`);
      await call("pane", "run", paneId, 'echo "token=$PANE_TOKEN home=$HOME"');
      await call("pane", "run", paneId, `sleep ${marker}`);
      expect(await until((shown) => shown.includes(`token=pane-'secret home=${home}`))).toBe(true);
      // The secret was read and deleted, and its value is on no command line in the box.
      const { stdout: left } = await sh(
        "ls /tmp/awf-secrets; cat /proc/[0-9]*/cmdline 2>/dev/null | tr '\\0' ' ' | grep -c 'pane-.secre[t]' || true",
      );
      expect(left.trim()).toBe("0");
      const counted = async (count: number) => {
        for (let tries = 0; tries < 40; tries++) {
          if ((await inBox(`sleep ${marker}`, occupant)) === count) return true;
          await Bun.sleep(250);
        }
        return false;
      };
      expect(await counted(2)).toBe(true);
      await paneOccupant.release();
      expect(await inBox(`sleep ${marker}`, occupant)).toBe(0);
    } finally {
      await call("workspace", "close", workspace).catch(() => undefined);
    }
  }, 120_000);

  test("a turn's exit code comes back through docker exec", async () => {
    expect((await sh("exit 3")).exitCode).toBe(3);
  });

  test("doors: the launcher's directory is root's, and neither launcher nor bundle is writable", async () => {
    const { stdout } = await sh(
      `stat -c %U '${join(root, "door")}'; echo x > '${join(root, "door", "wf")}' 2>/dev/null || echo launcher-denied; echo x > '${join(root, "door", "wf.js")}' 2>/dev/null || echo bundle-denied; '${join(root, "door", "wf")}'`,
    );
    expect(stdout).toContain("root");
    expect(stdout).toContain("launcher-denied");
    expect(stdout).toContain("bundle-denied");
    expect(stdout).toContain("door");
  });
});
