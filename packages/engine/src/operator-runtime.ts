import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SandboxEnvironmentKey } from "@wf/contract/workflow";
import {
  createHeadlessRunHostFactory,
  createHerdrRunHostFactory,
  createPlacementHostFactory,
  harnessState,
  type RunProcess,
  readClaudeBilling,
  readCodexBilling,
  runProcess,
  withholding,
} from "@wf/harness";
import type { AgentRuntimeConfig } from "@wf/harness/adapter";
import type { SandboxProviders } from "@wf/sandbox";
import { createDockerProvider, findDocker } from "@wf/sandbox/docker";
import { createSrtProvider, findSrt } from "@wf/sandbox/srt";
import { createOpenRouterProvider } from "./decisions/openrouter";
import type { DecisionInstallation } from "./decisions/seam";

export type OperatorRuntimeInstallation = {
  config: AgentRuntimeConfig;
  /** The sandbox providers this machine has, and the one a spec naming none runs in. */
  sandboxes?: SandboxProviders;
  /** The decision models workflows may ask, and their aliases. */
  decisions?: DecisionInstallation;
  cleanup(): Promise<void>;
};

export type OperatorRuntimeOptions = {
  run?: RunProcess;
  environment?: Readonly<Record<string, string | undefined>>;
  /** A tab in the run's workspace for each sandbox's own Herdr. On unless false. */
  watchSandboxes?: boolean;
};

/**
 * One run host for every agent: a Herdr tab for a pane agent, a subprocess per turn for a
 * headless one. Metered credentials are cleared from both.
 */
export async function installOperatorRuntime(
  timeoutMilliseconds: number,
  options: OperatorRuntimeOptions = {},
): Promise<OperatorRuntimeInstallation> {
  const { run = runProcess, environment = process.env, watchSandboxes = true } = options;
  const unmetered = withholding(run, WITHHELD_ENVIRONMENT);
  await assertSubscriptionAuthentication(unmetered, environment);
  const panes = (session: string) =>
    createHerdrRunHostFactory(
      {
        session,
        workspaceLabel: "awf run",
        commandTimeoutMs: Math.min(timeoutMilliseconds, 150_000),
        settleTimeoutMs: timeoutMilliseconds,
        emptyEnvironment: WITHHELD_ENVIRONMENT,
        acceptWorkspaceTrust: true,
        watchSandboxes,
      },
      run,
    );
  const { accounting } = panes("default");
  const host = createPlacementHostFactory({
    // The session is looked up when the first pane agent opens, so an all-headless run never
    // calls Herdr.
    pane: {
      ...(accounting ? { accounting } : {}),
      openRun: async (spec) => panes(await herdrSession(run, environment)).openRun(spec),
    },
    headless: createHeadlessRunHostFactory({ turnTimeoutMs: timeoutMilliseconds }, unmetered),
  });
  return {
    config: {
      aliases: {
        claude: {
          harness: "claude",
          model: "sonnet",
        },
        codex: {
          harness: "codex",
          model: "gpt-5.6-sol",
        },
      },
      host,
    },
    sandboxes: await installSandboxes(environment),
    decisions: installDecisions({ OPENROUTER_API_KEY: await openRouterKey(environment) }),
    // Nothing to undo: the agent's `wf` is a launcher the control plane installs beside its own
    // socket, and the control plane removes both when the run closes.
    cleanup: async () => undefined,
  };
}

/**
 * The sandbox providers this machine has: srt when its CLI is on `PATH`, docker when its CLI is;
 * its daemon is first asked when a sandbox opens. srt is the default when installed, as it runs
 * the project's own toolchain, which an image lacks (story 004), and when it is there but cannot
 * be set up: a spec naming none then fails saying why, rather than moving to docker unsaid.
 */
export async function installSandboxes(
  environment: Readonly<Record<string, string | undefined>>,
): Promise<SandboxProviders> {
  // A provider that cannot be set up fails only the specs that name it, not every run.
  const unavailable: Partial<Record<SandboxEnvironmentKey, string>> = {};
  const found = <T>(key: SandboxEnvironmentKey, finding: Promise<T | undefined>) =>
    finding.catch((error: unknown) => {
      unavailable[key] = error instanceof Error ? error.message : String(error);
      return undefined;
    });
  const [srt, docker] = await Promise.all([
    found("srt", findSrt(environment, Object.values(harnessState(environment)))),
    found("docker", findDocker(environment)),
  ]);
  const installed = {
    ...(srt ? { srt: createSrtProvider(srt) } : {}),
    ...(docker ? { docker: createDockerProvider(docker) } : {}),
  };
  const fallback = srt || unavailable.srt ? "srt" : docker ? "docker" : undefined;
  return {
    installed,
    ...(fallback ? { default: fallback } : {}),
    ...(Object.keys(unavailable).length > 0 ? { unavailable } : {}),
  };
}

/**
 * `OPENROUTER_API_KEY` from the environment, else from `.env` in `cwd`. Only that name is read:
 * awf runs bun with `--no-env-file`, and bunfig says the same here, because `.env` can hold a
 * Claude token that would change how every agent logs in.
 */
export async function openRouterKey(
  environment: Readonly<Record<string, string | undefined>>,
  cwd = process.cwd(),
): Promise<string | undefined> {
  if (environment.OPENROUTER_API_KEY?.trim()) return environment.OPENROUTER_API_KEY;
  const text = await readFile(join(cwd, ".env"), "utf8").catch(() => "");
  for (const line of text.split("\n")) {
    const found = /^\s*(?:export\s+)?OPENROUTER_API_KEY\s*=\s*(.*?)\s*$/.exec(line);
    if (found) return found[1]!.replace(/^(["'])(.*)\1$/, "$2");
  }
  return undefined;
}

/**
 * Jev through OpenRouter, as `jev`, when `OPENROUTER_API_KEY` is set. The engine holds the key;
 * no agent's environment has it. Without a usable key, asking for `jev` says why.
 */
export function installDecisions(
  environment: Readonly<Record<string, string | undefined>>,
): DecisionInstallation {
  const apiKey = environment.OPENROUTER_API_KEY?.trim();
  const refused = (reason: string) => ({
    providers: {},
    aliases: {},
    unavailable: { jev: reason },
  });
  if (!apiKey) return refused("OPENROUTER_API_KEY is not set");
  // A key with a space or line break in it would be quoted back by the request that failed on it.
  if (!/^[\x21-\x7e]+$/.test(apiKey)) {
    return refused("OPENROUTER_API_KEY is not one token of printable characters");
  }
  return {
    providers: { openrouter: createOpenRouterProvider({ apiKey }) },
    aliases: { jev: { provider: "openrouter", model: "typesafe/jev-1.13" } },
  };
}

/**
 * `AWF_HERDR_SESSION` when set; otherwise the session of the pane awf runs in, so its agents open
 * beside it; `default` outside Herdr.
 */
export async function herdrSession(
  run: RunProcess,
  environment: Readonly<Record<string, string | undefined>>,
): Promise<string> {
  if (environment.AWF_HERDR_SESSION) return environment.AWF_HERDR_SESSION;
  const socket = environment.HERDR_SOCKET_PATH;
  if (!socket) return "default";
  const listed = await run({ argv: ["herdr", "session", "list", "--json"], timeoutMs: 10_000 });
  let sessions: { name?: unknown; socket_path?: unknown }[] = [];
  if (listed.exitCode === 0) {
    try {
      sessions = JSON.parse(listed.stdout).sessions ?? [];
    } catch {}
  }
  const name = sessions.find((session) => session.socket_path === socket)?.name;
  // Falling back to `default` would put the agents in a session nobody is looking at.
  if (typeof name !== "string") {
    throw new Error(
      `no Herdr session owns ${socket} (\`herdr session list --json\`); set AWF_HERDR_SESSION`,
    );
  }
  return name;
}

const METERED_CREDENTIAL_ENVIRONMENT = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "CODEX_API_KEY",
] as const;

/**
 * Unset for every agent: the metered credentials, which also refuse the run, and the engine's own,
 * which a harness such as pi would otherwise bill against.
 */
const WITHHELD_ENVIRONMENT = [...METERED_CREDENTIAL_ENVIRONMENT, "OPENROUTER_API_KEY"] as const;

async function assertSubscriptionAuthentication(
  run: RunProcess,
  environment: Readonly<Record<string, string | undefined>>,
): Promise<void> {
  const configured = METERED_CREDENTIAL_ENVIRONMENT.filter((name) => environment[name]?.trim());
  if (configured.length > 0) {
    throw new Error(
      `subscription runtime refused metered credential environment: ${configured.join(", ")}`,
    );
  }
  const [claude, codex] = await Promise.all([readClaudeBilling(run), readCodexBilling(run)]);
  if (claude !== "subscription") {
    throw new Error(
      `Claude subscription authentication is required (claude.ai login or \`claude setup-token\`); \`claude auth status\` reads as ${claude}`,
    );
  }
  if (codex !== "subscription") {
    throw new Error(
      `Codex subscription authentication is required (ChatGPT login); \`codex login status\` reads as ${codex}`,
    );
  }
}
