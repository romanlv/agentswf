import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { SrtEnvironment } from "@agentswf/contract/workflow";
import { resolveSandbox } from "../resolve";
import type { AgentContext, Occupant, OpenedSandbox, SandboxProvider } from "../seam";
import { runCommand, sandboxConformance } from "../testing/conformance";
import { createSrtProvider, findSrt } from ".";

// A local test: real srt on this machine, `sh` for an agent, no model. Skipped without srt.
const home = realpathSync(homedir());
// The defaults of `harnessState` in packages/harness/src/state.ts, which this package cannot import.
const harnessState = [join(home, ".claude"), join(home, ".codex"), join(home, ".pi", "agent")];
const found = await findSrt(process.env, harnessState);
const provider = found && createSrtProvider(found);

sandboxConformance("srt", provider && { provider, confines: true });

/** What srt adds to an agent's environment itself, and what `sh` does. */
const SRT_ADDS = new Set([
  "TMPDIR",
  "GIT_CONFIG_PARAMETERS",
  "GIT_SSH_COMMAND",
  "SANDBOX_RUNTIME",
  "__CF_USER_TEXT_ENCODING",
  "PWD",
  "SHLVL",
  "_",
  ...["HTTP", "HTTPS", "FTP", "ALL", "GRPC", "RSYNC", "NO"].flatMap((name) => [
    `${name}_PROXY`,
    `${name.toLowerCase()}_proxy`,
  ]),
  "DOCKER_HTTP_PROXY",
  "DOCKER_HTTPS_PROXY",
  ...["ADDRESS", "PORT", "TYPE", "USERNAME", "PASSWORD"].map((name) => `CLOUDSDK_PROXY_${name}`),
]);

describe.skipIf(!provider)("srt on this machine", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wf-srt-local-")));
  const runRoot = join(root, "runs");
  const repo = join(root, "repo");
  const canaries: string[] = [];
  let listener: ReturnType<typeof Bun.serve> | undefined;
  let opened: OpenedSandbox;
  let paneOccupant: Occupant;
  let sh: (script: string) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
  const directory = join(runRoot, "run", "local");

  /** An agent whose harness is `sh`, by the name a pane types. */
  const paneAgent = (name: string): AgentContext => ({
    cwd: repo,
    home: join(directory, "homes", name),
    door: {
      endpoint: join(root, `${name}.sock`),
      launcher: join(root, `door-${name}`, "wf"),
      boxScript: "",
      bundle: join(root, `door-${name}`, "wf.js"),
      reads: [],
    },
    harness: {
      env: {},
      seed: [],
      defaults: () => [],
      secrets: { PANE_TOKEN: "pane-secret" },
      domains: [],
      command: "sh-harness",
      executable: "/bin/sh",
      reads: [],
    },
  });

  beforeAll(async () => {
    await mkdir(join(repo, "src"), { recursive: true });
    Bun.spawnSync(["git", "init", "-q", repo]);
    await writeFile(join(repo, "src", "a.txt"), "tracked\n");
    const { sandbox } = await resolveSandbox(
      { write: ["."], network: ["registry.npmjs.org"] },
      {
        key: "local",
        cwd: repo,
        runRoot: await mkdirReal(runRoot),
        machineRoot: join(home, ".awf"),
        harnessState,
        providers: { installed: { srt: provider as SandboxProvider<unknown> }, default: "srt" },
      },
    );
    for (const name of ["a1", "a2", "a3"]) {
      await mkdir(join(directory, "homes", name), { recursive: true });
    }
    opened = await (provider as SandboxProvider<SrtEnvironment>).open(sandbox as never, {
      runRoot,
      directory,
      deadline: { unixMilliseconds: Date.now() + 120_000 },
    });
    const occupant = await opened.admit({
      cwd: repo,
      home: join(directory, "homes", "a1"),
      door: {
        endpoint: join(root, "none.sock"),
        launcher: join(root, "door", "wf"),
        boxScript: "",
        bundle: join(root, "door", "wf.js"),
        reads: [],
      },
      harness: {
        env: { AGENT_HOME_VAR: join(directory, "homes", "a1") },
        seed: [],
        secrets: {},
        defaults: () => [],
        domains: [],
        command: "/bin/sh",
        executable: "/bin/sh",
        reads: [],
      },
    });
    paneOccupant = await opened.admit(paneAgent("a2"));
    sh = (script) =>
      runCommand(
        occupant.launch({ argv: ["/bin/sh", "-c", script], cwd: repo, timeoutMs: 30_000 }),
      );
    listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("listener") });
  }, 60_000);

  afterAll(async () => {
    listener?.stop(true);
    await opened?.close();
    await Promise.all(
      [root, ...canaries].map((path) => rm(path, { recursive: true, force: true })),
    );
  });

  async function canary(directory: string): Promise<{ path: string; token: string }> {
    const token = `canary-${crypto.randomUUID()}`;
    const path = join(directory, `.awf-srt-${token}`);
    await writeFile(path, token);
    canaries.push(path);
    return { path, token };
  }

  test("an agent's environment is what the provider set, and srt's own", async () => {
    const { stdout } = await sh("/usr/bin/env");
    const names = stdout
      .trim()
      .split("\n")
      .map((line) => line.slice(0, line.indexOf("=")));
    const set = new Set([
      "HOME",
      "PATH",
      "CLAUDE_CODE_TMPDIR",
      "TMPPREFIX",
      "SHELL",
      "GIT_CONFIG_GLOBAL",
      "npm_config_cache",
      "AGENT_HOME_VAR",
    ]);
    expect(names.filter((name) => !set.has(name) && !SRT_ADDS.has(name))).toEqual([]);
    for (const name of set) expect(names).toContain(name);
  });

  test("a zsh heredoc, as an agent's `wf result` is written, works from a read-only directory", async () => {
    // The working directory here is writable, where bash would fall back to it: `out` is not.
    const { stdout } = await sh(
      `cd '${join(repo, "..")}' && $SHELL -c "cat <<'EOF'\nheredoc-ok\nEOF"`,
    );
    expect(stdout).toContain("heredoc-ok");
  });

  test("denied: /var/tmp, to read, list or write", async () => {
    const planted = await canary("/private/var/tmp");
    const { stdout } = await sh(
      `cat '${planted.path}' 2>/dev/null; ls /var/tmp 2>/dev/null; echo x > /var/tmp/awf-probe-${crypto.randomUUID()} 2>/dev/null && echo wrote`,
    );
    expect(stdout).not.toContain(planted.token);
    expect(stdout).not.toContain("wrote");
  });

  test("allowed: git in the working directory, and bun, node and npm from the toolchain", async () => {
    const { stdout, stderr } = await sh(
      "git status --short && echo git-ok; bun --version && node --version && npm --version && echo tools-ok",
    );
    expect(stdout).toContain("git-ok");
    expect(stdout).toContain("tools-ok");
    // Apple's git shim cannot write its xcrun cache in a denied temp directory; git still runs.
    expect(stderr).not.toContain("fatal");
  });

  test("denied: ~, harness state, /tmp and $TMPDIR", async () => {
    const places = [home, join(home, ".claude"), join(home, ".codex"), "/tmp", tmpdir()];
    const planted = await Promise.all(places.map(canary));
    const { stdout } = await sh(planted.map(({ path }) => `cat '${path}' 2>/dev/null;`).join(" "));
    for (const { token } of planted) expect(stdout).not.toContain(token);
  });

  test("denied: what in the gitdir the host's git runs or follows, though commits are written", async () => {
    const guarded = [
      "hooks/pre-commit",
      "config",
      "commondir",
      "config.worktree",
      "info/attributes",
    ];
    const { stdout } = await sh(
      [
        ...guarded.map((file) => `echo x >> .git/${file} 2>/dev/null || echo denied:${file};`),
        "echo x > src/b.txt && git add src/b.txt && git -c user.name=a -c user.email=a@b commit -qm agent && echo committed",
      ].join(" "),
    );
    for (const file of guarded) expect(stdout).toContain(`denied:${file}`);
    expect(stdout).toContain("committed");
    expect(await readFile(join(repo, ".git", "config"), "utf8")).not.toContain("\nx\n");
  });

  test("a pane's prelude confines its shell, with its secret loaded and nothing else", async () => {
    const pane = await paneOccupant.pane!();
    process.env.AWF_ENGINE_ONLY = "leaked";
    try {
      const shell = Bun.spawn({
        cmd: ["/bin/sh", "-c", pane.prelude],
        cwd: repo,
        stdin: new TextEncoder().encode(
          `echo "token=$PANE_TOKEN leak=$AWF_ENGINE_ONLY"; cat ${home}/.zshrc 2>/dev/null || echo denied-home; command -v sh-harness; exit\n`,
        ),
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout] = await Promise.all([new Response(shell.stdout).text(), shell.exited]);
      expect(stdout).toContain("token=pane-secret leak=");
      expect(stdout).not.toContain("leak=leaked");
      expect(stdout).toContain("denied-home");
      // The harness is found by the name the pane types.
      expect(stdout).toMatch(/\/bin\/[^/]+\/sh-harness\n/);
    } finally {
      delete process.env.AWF_ENGINE_ONLY;
    }
  }, 30_000);

  test("a pane in a terminal shows its own prompt, and its release ends every job it started", async () => {
    const occupant = await opened.admit(paneAgent("a3"));
    const pane = await occupant.pane!();
    const marker = 7000 + Math.floor(Math.random() * 999);
    let shown = "";
    const shell = Bun.spawn(["/bin/sh", "-c", pane.prelude], {
      cwd: repo,
      terminal: {
        cols: 200,
        rows: 50,
        data: (_terminal, data) => {
          shown += new TextDecoder().decode(data);
        },
      },
    });
    const until = async (seen: () => boolean) => {
      for (let tries = 0; tries < 100 && !seen(); tries++) await Bun.sleep(100);
      return seen();
    };
    try {
      expect(await until(() => shown.includes(pane.ready))).toBe(true);
      // The secret was read and is gone before anything confined ran.
      expect(await readdir(`${directory}.secrets`)).toEqual([]);
      // A job left in the background, and one in the foreground, as the harness is.
      shell.terminal!.write(`sleep ${marker} &\necho "token=$PANE_TOKEN"\nsleep ${marker + 1}\n`);
      expect(await until(() => shown.includes("token=pane-secret"))).toBe(true);
      expect(await until(() => running(marker) === 2)).toBe(true);
      await occupant.release();
      expect(await until(() => running(marker) === 0)).toBe(true);
    } finally {
      shell.kill("SIGKILL");
      shell.terminal?.close();
    }
  }, 30_000);

  test("the network: an allowed domain, and not localhost, another domain or a raw address", async () => {
    const curl = (url: string, label: string) =>
      `/usr/bin/curl -s -m 8 -o /dev/null ${url} && echo ${label}-reached || echo ${label}-denied;`;
    const { stdout } = await sh(
      [
        curl("https://registry.npmjs.org", "allowed"),
        curl(`http://127.0.0.1:${listener!.port}`, "localhost"),
        curl("https://pypi.org", "other"),
        curl("https://1.1.1.1", "raw"),
      ].join(" "),
    );
    expect(stdout).toContain("allowed-reached");
    expect(stdout).toContain("localhost-denied");
    expect(stdout).toContain("other-denied");
    expect(stdout).toContain("raw-denied");
  });
});

/** How many `sleep {seconds}` and `sleep {seconds + 1}` are running. */
function running(seconds: number): number {
  const found = Bun.spawnSync(["/usr/bin/pgrep", "-f", `^sleep (${seconds}|${seconds + 1})$`]);
  return found.stdout.toString().trim().split("\n").filter(Boolean).length;
}

async function mkdirReal(path: string): Promise<string> {
  await mkdir(path, { recursive: true });
  return realpathSync(path);
}
