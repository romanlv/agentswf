import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { mkdir, readdir, readFile, readlink, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentContext, ResolvedSandbox, SandboxContext } from "../seam";
import { createSrtProvider, type SrtOptions } from ".";
import { agentProfile, baseProfile, checkProfile } from "./profile";

const root = realpathSync(mkdtempSync(join(tmpdir(), "wf-srt-unit-")));
afterAll(() => rm(root, { recursive: true, force: true }));

const home = "/Users/op";
const host: SrtOptions = {
  command: ["/opt/node/bin/node", "/opt/srt/cli.js"],
  path: ["/Users/op/.bun/bin", "/opt/homebrew/bin"],
  home,
  harnessState: ["/Users/op/.claude", "/Users/op/.codex", "/Users/op/.pi/agent"],
  toolchain: ["/Users/op/.bun", "/Users/op/.local"],
  probe: false,
};
const context: SandboxContext = {
  runRoot: "/Users/op/.awf/runs",
  directory: "/Users/op/.awf/runs/i/r/sandboxes/s1",
  deadline: { unixMilliseconds: Date.now() + 60_000 },
};
const spec: ResolvedSandbox<unknown> = {
  key: "box",
  cwd: "/Users/op/repo",
  read: ["/Users/op/notes", "/Users/op/repo/vendor"],
  write: ["/Users/op/repo"],
  network: ["registry.npmjs.org"],
  gitdirs: [
    { path: "/Users/op/repo/.git", writable: true },
    { path: "/Users/op/other/.git", writable: false },
  ],
  environment: {},
};
const agent: AgentContext = {
  cwd: "/Users/op/repo",
  home: `${context.directory}/homes/h1`,
  harness: {
    env: { CODEX_HOME: `${context.directory}/homes/h1` },
    seed: [],
    secrets: {},
    defaults: () => [],
    domains: ["chatgpt.com", "*.chatgpt.com"],
    command: "codex",
    executable: "/Users/op/.codex/packages/standalone/releases/1/bin/codex",
    reads: ["/Users/op/.codex/packages/standalone/releases/1"],
  },
  door: {
    endpoint: "/private/tmp/awf-x/a1/s.sock",
    launcher: "/private/tmp/awf-x/a1/wf",
    boxScript: "",
    bundle: "/private/tmp/awf-x/a1/wf.js",
    reads: ["/Users/op/.bun/bin/bun", "/private/tmp/awf-x/a1/wf.js"],
  },
};

const PROTECTED = ["/Users/op/repo/.git", "/Users/op/other/.git"].flatMap((gitdir) =>
  ["hooks", "config", "config.worktree", "commondir", "gitdir", "modules", "info"].map(
    (name) => `${gitdir}/${name}`,
  ),
);

describe("srt profiles", () => {
  test("the base: reach readable, write and homes writable, the run root and ~ denied", () => {
    expect(baseProfile(spec, context, host, `${context.directory}/tmp`, PROTECTED)).toEqual({
      enableWeakerNetworkIsolation: true,
      network: { allowedDomains: ["registry.npmjs.org"], deniedDomains: [], allowUnixSockets: [] },
      filesystem: {
        denyRead: [
          home,
          "/Users",
          "/home",
          "/Volumes",
          "/tmp",
          "/private/tmp",
          "/private/var/folders",
          "/private/var/tmp",
          context.runRoot,
        ],
        allowRead: [
          "/Users/op/repo",
          "/Users/op/notes",
          "/Users/op/repo/vendor",
          "/Users/op/repo/.git",
          "/Users/op/other/.git",
          context.directory,
          "/Users/op/.bun",
          "/Users/op/.local",
        ],
        allowWrite: [
          "/Users/op/repo",
          "/Users/op/repo/.git",
          `${context.directory}/homes`,
          `${context.directory}/tmp`,
        ],
        // The most specific of nested `read` and `write` wins: `vendor` stays read-only.
        denyWrite: [
          ...["/Users/op/repo/.git", "/Users/op/other/.git"].flatMap((gitdir) =>
            ["hooks", "config", "config.worktree", "commondir", "gitdir", "modules", "info"].map(
              (name) => `${gitdir}/${name}`,
            ),
          ),
          "/Users/op/repo/vendor",
        ],
      },
    });
  });

  test("an agent's: its domains, install tree and executable, and its door alone", () => {
    const base = baseProfile(spec, context, host, `${context.directory}/tmp`, PROTECTED);
    const profile = agentProfile(base, agent);
    expect(profile.network).toEqual({
      allowedDomains: ["registry.npmjs.org", "chatgpt.com", "*.chatgpt.com"],
      deniedDomains: [],
      allowUnixSockets: [agent.door.endpoint],
    });
    expect(profile.filesystem.allowRead.slice(base.filesystem.allowRead.length)).toEqual([
      "/Users/op/.codex/packages/standalone/releases/1",
      agent.harness.executable,
      "/Users/op/.bun/bin/bun",
      agent.door.bundle,
      "/private/tmp/awf-x/a1",
    ]);
    expect(profile.filesystem.denyWrite.at(-1)).toBe("/private/tmp/awf-x/a1");
    expect(profile.filesystem.allowWrite).toEqual(base.filesystem.allowWrite);
    // An install tree inside harness state passes; the base is untouched.
    expect(() => checkProfile(profile, host, context)).not.toThrow();
    expect(base.network.allowUnixSockets).toEqual([]);
  });

  test("an agent's short directory and shared writes: its own to bind in, and the /tmp link alone", () => {
    const base = baseProfile(spec, context, host, `${context.directory}/tmp`, PROTECTED);
    const shared = "/private/tmp/cursor-agent-persist-501";
    const profile = agentProfile(
      base,
      { ...agent, harness: { ...agent.harness, sharedWrites: [shared] } },
      "/private/tmp/awf-short",
    );
    expect(profile.network.allowUnixSockets).toEqual([
      agent.door.endpoint,
      "/private/tmp/awf-short",
    ]);
    expect(profile.filesystem.allowWrite.slice(base.filesystem.allowWrite.length)).toEqual([
      "/private/tmp/awf-short",
      shared,
    ]);
    expect(profile.filesystem.allowRead.slice(-3)).toEqual([
      "/private/tmp/awf-short",
      shared,
      "/tmp",
    ]);
    expect(() => checkProfile(profile, host, context)).not.toThrow();
    // Without a shared write under /tmp, the link stays denied with the rest.
    expect(agentProfile(base, agent, "/private/tmp/awf-short").filesystem.allowRead).not.toContain(
      "/tmp",
    );
  });

  test("macOS's xcrun cache, read alone where the host has one", () => {
    const cache = "/private/var/folders/x/T/xcrun_db";
    const base = baseProfile(
      spec,
      context,
      { ...host, xcrunCache: cache },
      `${context.directory}/tmp`,
      PROTECTED,
    );
    expect(base.filesystem.allowRead).toContain(cache);
    expect(base.filesystem.allowWrite).not.toContain(cache);
    expect(() => checkProfile(base, host, context)).not.toThrow();
  });

  type Change = Partial<Record<"denyRead" | "allowRead" | "allowWrite", string[]>>;
  test.each<[string, Change, string]>([
    ["re-allows ~", { allowRead: [home] }, "would expose ~"],
    ["re-allows a parent of ~", { allowRead: ["/Users"] }, "would expose ~"],
    [
      "reaches into the run root",
      { allowRead: [`${context.runRoot}/other`] },
      "reaches into the run root",
    ],
    ["exposes the run root", { allowWrite: ["/Users/op/.awf"] }, "would expose the run root"],
    ["exposes harness state", { allowRead: ["/Users/op/.codex"] }, "would expose harness state"],
    [
      "writes harness state",
      { allowWrite: ["/Users/op/.claude/projects"] },
      "in harness state be written",
    ],
    ["forgets to deny the run root", { denyRead: [home] }, "does not deny"],
  ])("the pure check refuses a profile that %s", (_name, change, reason) => {
    const base = baseProfile(spec, context, host, `${context.directory}/tmp`, PROTECTED);
    const bad = {
      ...base,
      filesystem: {
        ...base.filesystem,
        ...(change.denyRead ? { denyRead: change.denyRead } : {}),
        allowRead: [...base.filesystem.allowRead, ...(change.allowRead ?? [])],
        allowWrite: [...base.filesystem.allowWrite, ...(change.allowWrite ?? [])],
      },
    };
    expect(() => checkProfile(bad, host, context)).toThrow(reason);
  });
});

describe("the srt provider", () => {
  test("refuses a write inside a read inside a write, which srt would deny", async () => {
    await expect(
      createSrtProvider(host).open(
        { ...spec, environment: {}, write: ["/Users/op/repo", "/Users/op/repo/vendor/out"] },
        context,
      ),
    ).rejects.toThrow(
      "cannot make /Users/op/repo/vendor/out writable inside /Users/op/repo/vendor",
    );
  });

  test("takes no settings", () => {
    const provider = createSrtProvider(host);
    expect(provider.environment({})).toEqual({});
    expect(() => provider.environment({ image: "node" })).toThrow("srt takes no settings");
  });

  test("launches the harness by its real path after --, with exactly the agent's environment", async () => {
    const directory = join(root, "runs", "r", "sandboxes", "s1");
    await mkdir(join(directory, "homes", "h1"), { recursive: true });
    const local = { ...host, home: "/nonexistent-home", harnessState: [], toolchain: [] };
    const opened = await createSrtProvider(local).open(
      { ...spec, cwd: join(root, "work"), read: [], write: [], gitdirs: [], environment: {} },
      { ...context, runRoot: join(root, "runs"), directory },
    );
    const occupant = await opened.admit({
      ...agent,
      cwd: root,
      home: join(directory, "homes", "h1"),
      harness: {
        ...agent.harness,
        env: { CODEX_HOME: join(directory, "homes", "h1") },
        reads: [],
        executable: "/opt/codex/bin/codex",
        secrets: { SOME_TOKEN: "secret" },
      },
    });
    const command = occupant.launch({
      argv: ["codex", "--version"],
      cwd: root,
      env: { OVERLAY: "1" },
      stdin: "prompt",
      timeoutMs: 1_000,
    });
    // After the shell that records the group's leader.
    const [node, cli, flag, profile, separator, ...rest] = command.argv.slice(4);
    expect([node, cli, flag, separator, ...rest]).toEqual([
      "/opt/node/bin/node",
      "/opt/srt/cli.js",
      "-s",
      "--",
      "/opt/codex/bin/codex",
      "--version",
    ]);
    expect(JSON.parse(await readFile(profile!, "utf8")).network.allowedDomains).toContain(
      "chatgpt.com",
    );
    expect(command).toMatchObject({ group: true, stdin: "prompt", cwd: root, timeoutMs: 1_000 });
    expect(command.argv.slice(0, 2)).toEqual(["/bin/sh", "-c"]);
    expect(command.env).toEqual({
      HOME: "/nonexistent-home",
      PATH: "/Users/op/.bun/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin",
      CLAUDE_CODE_TMPDIR: join(directory, "tmp"),
      SHELL: "/bin/zsh",
      TMPPREFIX: join(directory, "tmp", "zsh"),
      GIT_CONFIG_GLOBAL: join(directory, "homes", "h1", "gitconfig"),
      npm_config_cache: join(directory, "tmp", "npm"),
      CODEX_HOME: join(directory, "homes", "h1"),
      SOME_TOKEN: "secret",
      OVERLAY: "1",
    });
    // A command other than the harness's runs as named.
    expect(
      occupant.launch({ argv: ["/bin/sh", "-c", "true"], timeoutMs: 1 }).argv.slice(9),
    ).toEqual(["/bin/sh", "-c", "true"]);

    // A pane: its own profile with a terminal, the harness linked by name, the token in a file
    // beside the sandbox's directory, which no agent in it reads.
    expect(opened.panes).toBe(true);
    const pane = await occupant.pane!();
    expect(pane.herdr).toBe("run");
    expect(pane.harness).toBe("codex");
    expect(pane.prelude.startsWith("exec /usr/bin/env -i ")).toBe(true);
    expect(pane.prelude).not.toContain("SOME_TOKEN");
    expect(pane.prelude).not.toContain("'secret'");
    // What its prompt shows, the typed prelude cannot.
    expect(pane.ready).toMatch(/^awf-%-[0-9a-f]{32}% $/);
    expect(pane.prelude).not.toContain(pane.ready.trimEnd());
    expect(pane.prelude).toContain(`'\\''/bin/zsh'\\'' '\\''-f'\\'' '\\''+m'\\''`);
    const bin = /PATH='([^:']+)/.exec(pane.prelude)![1]!;
    expect(await readlink(join(bin, "codex"))).toBe("/opt/codex/bin/codex");
    expect(pane.prelude).toContain("TERM='xterm-256color'");
    expect(pane.prelude).toContain("TMPPREFIX=");
    const [secrets] = await readdir(`${directory}.secrets`);
    const secretsFile = join(`${directory}.secrets`, secrets!);
    expect(await readFile(secretsFile, "utf8")).toBe("SOME_TOKEN='secret'\n");
    expect((await stat(secretsFile)).mode & 0o777).toBe(0o600);
    expect((await stat(`${directory}.secrets`)).mode & 0o777).toBe(0o700);
    // Read, then deleted, before the shell is confined.
    expect(pane.prelude).toContain(`rm -f '\\''${secretsFile}'\\''; exec`);
    const paneProfile = /([^' ]+-pane\.json)/.exec(pane.prelude)![1]!;
    const paneSettings = JSON.parse(await readFile(paneProfile, "utf8"));
    expect(paneSettings.allowPty).toBe(true);
    expect(paneSettings.filesystem.allowRead).not.toContain(`${directory}.secrets`);
    // The headless profile has none.
    expect(JSON.parse(await readFile(profile!, "utf8")).allowPty).toBeUndefined();

    // A secret the pane's shell never read goes at release.
    await occupant.release();
    expect(await stat(secretsFile).catch(() => undefined)).toBeUndefined();
    expect(() => occupant.launch({ argv: ["codex"], timeoutMs: 1 })).toThrow("released");
    await opened.close();
    for (const left of ["bin", "pids", "profiles", "tmp"]) {
      expect(await stat(join(directory, left)).catch(() => undefined)).toBeUndefined();
    }
    expect(await stat(`${directory}.secrets`).catch(() => undefined)).toBeUndefined();
  });
});
