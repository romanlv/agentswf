import { realpath, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { HarnessSandboxNeeds } from "@agentswf/sandbox";
import { harnessSpec } from "./spec";
import { HOME_ENV, harnessState } from "./state";
import { type Absent, type Harness, isAbsent } from "./types";

type Environment = Readonly<Record<string, string | undefined>>;

/** What a harness needs to run in a sandbox, beyond what every agent gets. */
type SandboxedHarness = {
  /**
   * Credential files copied from the operator's state into the home, each with the fields a
   * refresh rewrites: nothing else of it may change for the copy to be written back.
   */
  seed: readonly { file: string; refreshes: readonly string[] }[];
  /** A credential the operator's environment holds for a login no copied file carries. */
  token?: { env: string; from: string };
  domains(model: string | undefined): readonly string[];
  /** Config written fresh into the home: `defaults` in the seam. */
  defaults?(cwd: string): readonly { name: string; contents: string }[];
  /**
   * Inserted into each turn's arguments where they swallow nothing: they turn off what reaches past
   * the sandbox from the model's side (X15).
   */
  args: readonly string[];
  /** Whether an agent on the host may have a home of its own, which skills can need. */
  hostHome: true | Absent;
  /** What points it at `home`; absent, its state variable alone. */
  env?(home: string): Record<string, string>;
  /** The variable the provider sets to a short directory of the agent's own; see the seam. */
  shortDirectory?: string;
  /** Host directories it writes outside its home, shared; see the seam. */
  sharedWrites?(): string[];
  /** What its executable needs beside itself, where `installReads` cannot tell. */
  reads?(executable: string): string[];
};

/**
 * Where a ChatGPT login's requests go, and where its token refreshes. The refresh host was not
 * measured: no turn in Task 0 needed one (X13).
 */
const CHATGPT = ["chatgpt.com", "*.chatgpt.com", "auth.openai.com"] as const;

/** Where cursor's requests go, its login and model calls both. */
const CURSOR = ["*.cursor.sh"] as const;

/**
 * pi's model domains by provider. Only `openai-codex` was measured (X5, X20); the others follow
 * pi's own endpoints and refresh hosts, unmeasured.
 */
const PI_PROVIDER_DOMAINS: Readonly<Record<string, readonly string[]>> = {
  "openai-codex": CHATGPT,
  anthropic: ["api.anthropic.com", "console.anthropic.com", "platform.claude.com"],
  openai: ["api.openai.com"],
};

const SANDBOXED: Readonly<Record<Harness, SandboxedHarness | Absent>> = {
  claude: {
    // claude keeps its login in the keychain, where no copy reaches; a setup token stands in, and
    // lasts a year, so nothing refreshes.
    seed: [],
    token: { env: "CLAUDE_CODE_OAUTH_TOKEN", from: "from `claude setup-token`" },
    domains: () => ["api.anthropic.com"],
    // One argument for the list, and never last: the flag takes every argument up to the next.
    args: ["--disallowed-tools", "WebSearch,WebFetch"],
    hostHome: {
      absent:
        "claude on the host keeps the operator's home: its login is in the keychain, and its home's settings turn off the prompts only a sandbox stands in for",
    },
    // A pane's claude asks for onboarding, the folder's trust and the bypass before its first
    // prompt, and loses that prompt otherwise (H3, H6). Headless asks for none; one home's files
    // serve both placements, and a trusted folder's project settings stay inside the sandbox.
    // Its permission prompts are off, as the sandbox answers what they would ask (permissions.md),
    // in this home's user settings, which only a sandboxed claude reads.
    defaults: (cwd) => [
      {
        name: ".claude.json",
        contents: `${JSON.stringify({
          hasCompletedOnboarding: true,
          lastOnboardingVersion: "2.1.226",
          projects: { [cwd]: { hasTrustDialogAccepted: true, projectOnboardingSeenCount: 1 } },
        })}\n`,
      },
      {
        name: "settings.json",
        contents: `${JSON.stringify({
          skipDangerousModePermissionPrompt: true,
          permissions: { defaultMode: "bypassPermissions" },
        })}\n`,
      },
    ],
  },
  codex: {
    // `tokens.account_id` is not among them: a login to another account is not a refresh.
    seed: [
      {
        file: "auth.json",
        refreshes: [
          "tokens.id_token",
          "tokens.access_token",
          "tokens.refresh_token",
          "last_refresh",
        ],
      },
    ],
    // A ChatGPT login: the only one the operator's runtime accepts.
    domains: () => CHATGPT,
    // A pane's codex loses its first prompt to the folder-trust question without this (H3).
    // Headless, it also reads the repository's `.codex/config.toml`, which runs confined like the
    // rest, and whose settings the `-c` flags below override.
    defaults: (cwd) => [
      {
        name: "config.toml",
        contents: `[projects.${JSON.stringify(cwd)}]\ntrust_level = "trusted"\n`,
      },
    ],
    // `tools.web_search=false` leaves the tool in place (X15). Apps and plugins act through the
    // login on the operator's ChatGPT account, past any sandbox (Task 4 found them listed).
    args: [
      "-c",
      'web_search="disabled"',
      "-c",
      "features.apps=false",
      "-c",
      "features.plugins=false",
      "-c",
      "features.remote_plugin=false",
    ],
    hostHome: true,
  },
  pi: {
    // One entry per provider logged in; an OAuth one's `accountId`, where it has one, stays.
    // anthropic's names no account, so its tokens are all a refresh changes, another login's too.
    seed: [{ file: "auth.json", refreshes: ["*.access", "*.refresh", "*.expires"] }],
    domains: (model) => {
      // A fresh home has no settings, so pi picks a bare model's provider from its catalogue:
      // only a named provider says which domains it will reach.
      const provider = model?.includes("/") ? model.slice(0, model.indexOf("/")) : undefined;
      if (provider === undefined) {
        throw new Error("a sandboxed pi needs its model as provider/model, such as openai-codex/…");
      }
      if (!Object.hasOwn(PI_PROVIDER_DOMAINS, provider)) {
        throw new Error(`no model domains are known for pi's provider ${provider}`);
      }
      return PI_PROVIDER_DOMAINS[provider]!;
    },
    // pi's core has no web search (X15); an extension, the operator's or the project's, could.
    args: ["--no-extensions"],
    hostHome: true,
    // pi runs `/bin/bash` unless told otherwise, and macOS's bash 3.2 writes every heredoc,
    // `wf result`'s included, where a sandbox denies it (X22); zsh writes it under `TMPPREFIX`.
    // The docker image carries zsh too.
    defaults: () => [
      { name: "settings.json", contents: `${JSON.stringify({ shellPath: "/bin/zsh" })}\n` },
    ],
  },
  cursor: {
    // Its login is in the keychain, which a home of its own does not reach; an API key stands in.
    seed: [],
    token: { env: "CURSOR_API_KEY", from: "a Cursor API key, from its dashboard" },
    domains: () => CURSOR,
    // Its config directory holds its chats and settings; skills, rules, MCP servers and hooks it
    // reads under `HOME/.cursor` whatever moves them, so `HOME` moves too.
    // Its key is kept in memory: it would otherwise try to save it to the keychain, and warn.
    env: (home) => ({ HOME: home, CURSOR_CONFIG_DIR: home, AGENT_CLI_CREDENTIAL_STORE: "memory" }),
    // Its data directory holds its worker's socket, its transcripts and its trust, none of which
    // outlives the agent: where its path passes 84 characters, as a sandbox home's does, the socket
    // falls back to the shared `/tmp/.cursor` (cursor-agent 2026.10.01).
    shortDirectory: "CURSOR_DATA_DIR",
    // A resume takes a lock under `/tmp/cursor-agent-persist-{uid}`, which nothing moves, and makes
    // that directory first, which srt denies though it exists. The operator's own cursor and every
    // sandboxed one share it: its locks, and the bindings `agent persist` writes.
    sharedWrites: () => [
      join("/private/tmp", `cursor-agent-persist-${process.getuid?.() ?? "user"}`),
    ],
    // Its own sandbox, inside ours, is off. Its web tools stay, as the operator chose (story 019):
    // its search runs on cursor's servers, and a fetch reaches only the sandbox's domains.
    args: ["--sandbox", "disabled"],
    // A release directory: a wrapper script, the node it runs and its bundle beside it.
    reads: (executable) => [dirname(executable)],
    hostHome: {
      absent:
        "cursor reads skills under HOME, which on the host is git's and every tool's home too, and its login does not follow a moved one",
    },
  },
};

/** `harness`'s sandbox needs, or why it has none. */
function sandboxed(harness: string): SandboxedHarness | Absent {
  return Object.hasOwn(SANDBOXED, harness)
    ? SANDBOXED[harness as Harness]
    : { absent: `${harness} is not a harness awf knows` };
}

/**
 * A home of `harness`'s own at `home`, for an agent on the host that needs one to be given skills:
 * the credential and first-run answers a sandboxed agent's gets, and nothing else of the operator's.
 */
export function hostHome(
  harness: string,
  home: string,
  environment: Environment = process.env,
): Pick<HarnessSandboxNeeds, "env" | "seed" | "defaults"> {
  const needs = sandboxed(harness);
  if (isAbsent(needs)) throw new Error(`${harness} cannot have a home of its own: ${needs.absent}`);
  if (isAbsent(needs.hostHome)) throw new Error(needs.hostHome.absent);
  return ownHome(harness as Harness, needs, home, environment);
}

function ownHome(
  harness: Harness,
  sandboxed: SandboxedHarness,
  home: string,
  environment: Environment,
): Pick<HarnessSandboxNeeds, "env" | "seed" | "defaults"> {
  const state = harnessState(environment)[harness];
  return {
    env: sandboxed.env?.(home) ?? { [HOME_ENV[harness]]: home },
    seed: sandboxed.seed.map(({ file, refreshes }) => ({
      from: join(state, file),
      to: join(home, file),
      refreshes,
    })),
    defaults: (cwd) =>
      (sandboxed.defaults?.(cwd) ?? []).map(({ name, contents }) => ({
        path: join(home, name),
        contents,
      })),
  };
}

/** The variables a sandboxed harness's login is read from, every harness's. */
export function sandboxTokens(): string[] {
  return Object.values(SANDBOXED).flatMap((needs) =>
    !isAbsent(needs) && needs.token ? [needs.token.env] : [],
  );
}

/** Whether a harness can run in a sandbox at all. */
export function sandboxable(harness: string): boolean {
  return !isAbsent(sandboxed(harness));
}

/** The arguments a sandboxed turn adds, turning off what the model reaches past the sandbox. */
export function sandboxedArgs(harness: string): readonly string[] {
  const needs = sandboxed(harness);
  return isAbsent(needs) ? [] : needs.args;
}

/**
 * What `harness` needs to run in a sandbox with `home` as its home, for `model`, found on
 * `environment`'s `PATH`: the provider gives an agent that same `PATH`. Rejects a harness no
 * sandbox can run, one not on `PATH` or behind a version manager's shim, and a claude without its
 * setup token.
 */
export async function sandboxNeeds(
  harness: string,
  home: string,
  model: string | undefined,
  environment: Environment = process.env,
): Promise<HarnessSandboxNeeds> {
  const needs = sandboxed(harness);
  if (isAbsent(needs)) throw new Error(`${harness} cannot run in a sandbox: ${needs.absent}`);
  const tokenValue = needs.token ? environment[needs.token.env]?.trim() : undefined;
  if (needs.token && !tokenValue) {
    throw new Error(
      `a sandboxed ${harness} needs ${needs.token.env} (${needs.token.from}): its login lives in the keychain`,
    );
  }
  const domains = needs.domains(model);
  const command = harnessSpec(harness as Harness).interactive().argv[0]!;
  const executable = await findExecutable(command, environment);
  return {
    ...ownHome(harness as Harness, needs, home, environment),
    secrets: needs.token && tokenValue ? { [needs.token.env]: tokenValue } : {},
    domains,
    ...(needs.shortDirectory ? { shortDirectory: needs.shortDirectory } : {}),
    ...(needs.sharedWrites ? { sharedWrites: needs.sharedWrites() } : {}),
    command,
    executable,
    reads: needs.reads?.(executable) ?? (await installReads(executable, environment)),
  };
}

/**
 * What the executable needs besides itself: a node package's root and node's own install; the
 * release a `bin/` directory sits in; nothing for a single binary.
 */
async function installReads(executable: string, environment: Environment): Promise<string[]> {
  const packageRoot = await above(executable, "package.json");
  if (packageRoot) {
    const node = await findExecutable("node", environment);
    return [packageRoot, dirname(dirname(node))];
  }
  return basename(dirname(executable)) === "bin" ? [dirname(dirname(executable))] : [];
}

/** Version managers whose shim resolves to the manager, which cannot run under srt's reach. */
const SHIMS = new Set(["mise", "asdf", "volta", "rtx"]);

/** The real path of `command` on `environment`'s `PATH`, as a shell would find it. */
async function findExecutable(command: string, environment: Environment): Promise<string> {
  for (const directory of (environment.PATH ?? "").split(":")) {
    if (!directory) continue;
    const found = await stat(join(directory, command)).catch(() => undefined);
    // A regular file with an execute bit: `access` would pass a directory too.
    if (!found?.isFile() || (found.mode & 0o111) === 0) continue;
    const real = await realpath(join(directory, command));
    if (SHIMS.has(basename(real))) {
      throw new Error(`${command} on PATH is a ${basename(real)} shim; put its install on PATH`);
    }
    return real;
  }
  throw new Error(`${command} is not on PATH`);
}

/** The nearest directory above `file` holding `name`. */
async function above(file: string, name: string): Promise<string | undefined> {
  for (let at = dirname(file); dirname(at) !== at; at = dirname(at)) {
    if (await Bun.file(join(at, name)).exists()) return at;
  }
  return undefined;
}
