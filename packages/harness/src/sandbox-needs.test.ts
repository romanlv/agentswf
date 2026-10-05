import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { chmod, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { hostHome, sandboxedArgs, sandboxNeeds } from "./sandbox-needs";
import { HARNESSES } from "./spec";

// A host laid out as this one is: claude a single binary, codex a release tree inside its state,
// pi a node package beside node.
const root = realpathSync(mkdtempSync(join(tmpdir(), "wf-needs-")));
const home = join(root, "home");
const agentHome = join(root, "run", "homes", "a1");
const claude = join(root, "share", "claude", "versions", "2.0.0");
const codexRelease = join(home, ".codex", "packages", "standalone", "releases", "0.1");
const cursorRelease = join(home, ".local", "share", "cursor-agent", "versions", "2026.10.01");
const nodeRoot = join(root, "node");
const piPackage = join(nodeRoot, "lib", "node_modules", "pi-coding-agent");
const environment = {
  HOME: home,
  PATH: `${join(root, "bin")}:${join(nodeRoot, "bin")}`,
  CLAUDE_CODE_OAUTH_TOKEN: "setup-token",
};

async function executable(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "#!/bin/sh\n");
  await chmod(path, 0o755);
}

beforeAll(async () => {
  await executable(claude);
  await executable(join(codexRelease, "bin", "codex"));
  await executable(join(nodeRoot, "bin", "node"));
  await executable(join(piPackage, "dist", "cli.js"));
  await writeFile(join(piPackage, "package.json"), "{}");
  await mkdir(join(root, "bin"), { recursive: true });
  await symlink(claude, join(root, "bin", "claude"));
  await symlink(join(codexRelease, "bin", "codex"), join(root, "bin", "codex"));
  await symlink(join(piPackage, "dist", "cli.js"), join(nodeRoot, "bin", "pi"));
  await executable(join(cursorRelease, "cursor-agent"));
  await symlink(join(cursorRelease, "cursor-agent"), join(root, "bin", "cursor-agent"));
  await mkdir(join(home, ".pi", "agent"), { recursive: true });
  await writeFile(
    join(home, ".pi", "agent", "settings.json"),
    JSON.stringify({ defaultProvider: "openai-codex" }),
  );
});

afterAll(() => rm(root, { recursive: true, force: true }));

describe("sandboxNeeds", () => {
  test("claude: its home, its setup token and no file, and web tools off", async () => {
    const needs = await sandboxNeeds("claude", agentHome, "claude-haiku-4-5", environment);
    const [onboarding, settings] = needs.defaults("/repo");
    expect(JSON.parse(onboarding!.contents)).toMatchObject({
      hasCompletedOnboarding: true,
      projects: { "/repo": { hasTrustDialogAccepted: true } },
    });
    // In the sandbox's home only: a host claude reads the operator's own settings.
    expect(settings?.path).toBe(join(agentHome, "settings.json"));
    expect(JSON.parse(settings!.contents)).toEqual({
      skipDangerousModePermissionPrompt: true,
      permissions: { defaultMode: "bypassPermissions" },
    });
    expect({ ...needs, defaults: [] }).toEqual({
      env: { CLAUDE_CONFIG_DIR: agentHome },
      seed: [],
      defaults: [],
      secrets: { CLAUDE_CODE_OAUTH_TOKEN: "setup-token" },
      domains: ["api.anthropic.com"],
      command: "claude",
      executable: claude,
      reads: [],
    });
    expect(sandboxedArgs("claude")).toEqual(["--disallowed-tools", "WebSearch,WebFetch"]);
  });

  test("codex: its home seeded from the operator's, its release tree, and search off", async () => {
    const needs = await sandboxNeeds("codex", agentHome, "gpt-6-luna", environment);
    expect(needs).toMatchObject({
      env: { CODEX_HOME: agentHome },
      seed: [
        {
          from: join(home, ".codex", "auth.json"),
          to: join(agentHome, "auth.json"),
          refreshes: [
            "tokens.id_token",
            "tokens.access_token",
            "tokens.refresh_token",
            "last_refresh",
          ],
        },
      ],
      domains: ["chatgpt.com", "*.chatgpt.com", "auth.openai.com"],
      command: "codex",
      executable: join(codexRelease, "bin", "codex"),
      reads: [codexRelease],
    });
    expect(sandboxedArgs("codex")).toEqual([
      "-c",
      'web_search="disabled"',
      "-c",
      "features.apps=false",
      "-c",
      "features.plugins=false",
      "-c",
      "features.remote_plugin=false",
    ]);
    expect(needs.secrets).toEqual({});
    expect(needs.defaults("/repo")).toEqual([
      {
        path: join(agentHome, "config.toml"),
        contents: '[projects."/repo"]\ntrust_level = "trusted"\n',
      },
    ]);
    // Moved state is where the credential comes from.
    const moved = await sandboxNeeds("codex", agentHome, undefined, {
      ...environment,
      CODEX_HOME: "/elsewhere",
    });
    expect(moved.seed.map(({ from, to }) => ({ from, to }))).toEqual([
      { from: "/elsewhere/auth.json", to: join(agentHome, "auth.json") },
    ]);
  });

  test("pi: its package and node, and the domains of the provider its model names", async () => {
    const needs = await sandboxNeeds("pi", agentHome, "openai-codex/gpt-5.6-terra", environment);
    expect(needs).toMatchObject({
      env: { PI_CODING_AGENT_DIR: agentHome },
      seed: [
        {
          from: join(home, ".pi", "agent", "auth.json"),
          to: join(agentHome, "auth.json"),
          refreshes: ["*.access", "*.refresh", "*.expires"],
        },
      ],
      domains: ["chatgpt.com", "*.chatgpt.com", "auth.openai.com"],
      command: "pi",
      executable: join(piPackage, "dist", "cli.js"),
      reads: [piPackage, nodeRoot],
    });
    expect(sandboxedArgs("pi")).toEqual(["--no-extensions"]);
    // Its shell is zsh, whose heredocs a sandbox lets it write (X22).
    expect(needs.defaults("/repo")).toEqual([
      { path: join(agentHome, "settings.json"), contents: '{"shellPath":"/bin/zsh"}\n' },
    ]);
    const anthropic = await sandboxNeeds("pi", agentHome, "anthropic/claude-opus-4-8", environment);
    expect(anthropic.domains).toContain("api.anthropic.com");
    // A fresh home has no settings: pi would choose a bare model's provider itself.
    for (const model of ["gpt-6-sol", undefined]) {
      await expect(sandboxNeeds("pi", agentHome, model, environment)).rejects.toThrow(
        "a sandboxed pi needs its model as provider/model",
      );
    }
    for (const provider of ["mystery", "constructor"]) {
      await expect(sandboxNeeds("pi", agentHome, `${provider}/m`, environment)).rejects.toThrow(
        `no model domains are known for pi's provider ${provider}`,
      );
    }
  });

  test("finds a regular executable file on PATH, as a shell does, and refuses a shim", async () => {
    const decoys = join(root, "decoys");
    await mkdir(join(decoys, "dir", "codex"), { recursive: true });
    await mkdir(join(decoys, "plain"), { recursive: true });
    await writeFile(join(decoys, "plain", "codex"), "not executable");
    const found = await sandboxNeeds("codex", agentHome, undefined, {
      ...environment,
      PATH: `${join(decoys, "dir")}::${join(decoys, "plain")}:${environment.PATH}`,
    });
    expect(found.executable).toBe(join(codexRelease, "bin", "codex"));
    await executable(join(root, "mise", "bin", "mise"));
    await mkdir(join(root, "shims"), { recursive: true });
    await symlink(join(root, "mise", "bin", "mise"), join(root, "shims", "codex"));
    await expect(
      sandboxNeeds("codex", agentHome, undefined, { ...environment, PATH: join(root, "shims") }),
    ).rejects.toThrow("codex on PATH is a mise shim");
  });

  test("cursor: a HOME of its own, its API key, its release directory, and its sandbox off", async () => {
    const needs = await sandboxNeeds("cursor", agentHome, "composer-2.5", {
      ...environment,
      CURSOR_API_KEY: "key",
    });
    expect({ ...needs, defaults: needs.defaults("/repo") }).toEqual({
      env: { HOME: agentHome, CURSOR_CONFIG_DIR: agentHome, AGENT_CLI_CREDENTIAL_STORE: "memory" },
      shortDirectory: "CURSOR_DATA_DIR",
      sharedWrites: [`/private/tmp/cursor-agent-persist-${process.getuid?.()}`],
      seed: [],
      defaults: [],
      secrets: { CURSOR_API_KEY: "key" },
      domains: ["*.cursor.sh"],
      command: "cursor-agent",
      executable: join(cursorRelease, "cursor-agent"),
      reads: [cursorRelease],
    });
    expect(sandboxedArgs("cursor")).toEqual(["--sandbox", "disabled"]);
    await expect(sandboxNeeds("cursor", agentHome, undefined, environment)).rejects.toThrow(
      "a sandboxed cursor needs CURSOR_API_KEY",
    );
    expect(() => hostHome("cursor", agentHome, environment)).toThrow(
      "cursor reads skills under HOME",
    );
  });

  test("refuses a harness not on PATH, and claude without its token", async () => {
    await expect(
      sandboxNeeds("codex", agentHome, undefined, { ...environment, PATH: "/nowhere" }),
    ).rejects.toThrow("codex is not on PATH");
    await expect(
      sandboxNeeds("claude", agentHome, undefined, {
        ...environment,
        CLAUDE_CODE_OAUTH_TOKEN: " ",
      }),
    ).rejects.toThrow("a sandboxed claude needs CLAUDE_CODE_OAUTH_TOKEN");
  });

  test("each turn plan puts the real flags where nothing swallows them or what follows", () => {
    for (const harness of ["claude", "codex", "pi", "cursor"] as const) {
      const spec = HARNESSES[harness];
      const args = sandboxedArgs(harness);
      for (const model of ["m", undefined]) {
        const context = { ...(model ? { model } : {}), sessionHint: "s", launchArgs: args };
        for (const plan of [
          spec.headlessTurn("prompt", context),
          spec.resumeTurn!("prompt", "session", context),
        ]) {
          const at = plan.argv.lastIndexOf(args.at(-1)!) - (args.length - 1);
          expect(plan.argv.slice(at, at + args.length)).toEqual([...args]);
          // claude's flag is variadic: an option must follow it. codex's `-` stays last.
          if (harness === "claude") expect(plan.argv[at + args.length]?.startsWith("-")).toBe(true);
          if (harness === "codex") expect(plan.argv.at(-1)).toBe("-");
        }
      }
    }
  });
});

describe("hostHome", () => {
  test("no host claude gets a home of its own, nor the settings a sandboxed one's has", () => {
    expect(() => hostHome("claude", agentHome, environment)).toThrow(
      "claude on the host keeps the operator's home",
    );
  });
});

describe("the sessions in a sandboxed agent's home", () => {
  const sessionsHome = join(root, "sessions-home");

  test("are codex's by start time, its root before the subagents it started", async () => {
    const day = join(sessionsHome, "sessions", "2026", "09", "26");
    await mkdir(day, { recursive: true });
    for (const name of ["T10-00-09-sub", "T10-00-01-root"]) {
      await writeFile(join(day, `rollout-2026-09-26${name}.jsonl`), "");
    }
    expect(await HARNESSES.codex.homeSessions!(sessionsHome)).toEqual(["root", "sub"]);
  });

  test("are none that a link in the home points at", async () => {
    const operator = join(root, "operator-sessions");
    await mkdir(join(operator, "p"), { recursive: true });
    await writeFile(join(operator, "p", "theirs.jsonl"), "");
    const linkedRoot = join(root, "linked-home");
    await mkdir(linkedRoot, { recursive: true });
    await symlink(operator, join(linkedRoot, "projects"));
    expect(await HARNESSES.claude.homeSessions!(linkedRoot)).toEqual([]);

    const linkedFile = join(root, "linked-file-home");
    await mkdir(join(linkedFile, "projects", "p"), { recursive: true });
    await writeFile(join(linkedFile, "projects", "p", "own.jsonl"), "");
    await symlink(
      join(operator, "p", "theirs.jsonl"),
      join(linkedFile, "projects", "p", "x.jsonl"),
    );
    expect(await HARNESSES.claude.homeSessions!(linkedFile)).toEqual(["own"]);
  });
});
