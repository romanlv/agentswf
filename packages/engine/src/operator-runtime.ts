import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { HarnessAllowance } from "@agentswf/contract/records";
import type { SandboxEnvironmentKey } from "@agentswf/contract/workflow";
import {
  type Absent,
  type CallerPane,
  createCallerHostFactory,
  createHeadlessRunHostFactory,
  createHerdrRunHostFactory,
  createPlacementHostFactory,
  createSessionAccounting,
  HARNESSES,
  type Harness,
  type HerdrConfig,
  harnessState,
  isAbsent,
  type RunProcess,
  readAllowance,
  readClaudeBilling,
  readCodexBilling,
  readCursorLogin,
  runProcess,
  withholding,
} from "@agentswf/harness";
import type { AgentRunHostFactory, AgentRuntimeConfig } from "@agentswf/harness/adapter";
import type { SandboxProviders } from "@agentswf/sandbox";
import { createDockerProvider, findDocker } from "@agentswf/sandbox/docker";
import { createSrtProvider, findSrt } from "@agentswf/sandbox/srt";
import { createOpenRouterProvider } from "./decisions/openrouter";
import type { DecisionInstallation } from "./decisions/seam";
import { messageOf } from "./errors";
import {
  ensureRunSession,
  parseSessions,
  type RunSession,
  runSessionName,
} from "./herdr-run-session";

import { markWorkspace } from "./herdr-workspace-marks";

export type { RunSession } from "./herdr-run-session";

import { OPERATOR_ALIASES } from "./operator-aliases";

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
  /** The session `awf run --here` was started from, found in the Herdr session named (ADR 0010). */
  caller?: { pane: CallerPane; session: string };
  /** The operator's home. */
  home?: string;
  /** Told once, when the first pane agent's session is ready. */
  onRunSession?: (session: RunSession) => void;
};

/**
 * One run host for every agent: a Herdr tab for a pane agent, a subprocess per turn for a
 * headless one. `WITHHELD_ENVIRONMENT` is cleared from both.
 */
export async function installOperatorRuntime(
  timeoutMilliseconds: number,
  options: OperatorRuntimeOptions = {},
): Promise<OperatorRuntimeInstallation> {
  const {
    run = runProcess,
    environment = process.env,
    watchSandboxes = true,
    caller,
    home = homedir(),
    onRunSession,
  } = options;
  const unmetered = withholding(run, WITHHELD_ENVIRONMENT);
  refuseMeteredCredentials(environment);
  // Checked now, before any stage spends anything; made ready only for the first pane agent.
  const name = runSessionName(environment);
  const session = runSessionOnce(() => name, { run, environment, home }, onRunSession);
  const runConfig = (session: string): HerdrConfig => ({
    ...herdrConfig(session),
    commandTimeoutMs: Math.min(timeoutMilliseconds, 150_000),
    emptyEnvironment: PANE_WITHHELD_ENVIRONMENT,
    acceptWorkspaceTrust: true,
    watchSandboxes,
  });
  const host = loginChecked(
    unmetered,
    createPlacementHostFactory({
      // The session is made ready when the first pane agent opens, so an all-headless run never
      // calls Herdr.
      pane: {
        accounting: createSessionAccounting(unmetered),
        openRun: async (spec) => {
          const { name } = await session();
          const mark = await markWorkspace(home, name, spec.label ?? spec.runId);
          const config = { ...runConfig(name), onRunWorkspace: mark.bind };
          const host = await createHerdrRunHostFactory(config, run)
            .openRun(spec)
            .catch(async (error: unknown) => {
              await mark.release();
              throw error;
            });
          // Kept when the workspace would not close: a dead run's mark is what lets a later run
          // close it.
          const close: typeof host.close = async (reason) => {
            await host.close(reason);
            await mark.release();
          };
          return {
            openAgent: (request) => host.openAgent(request),
            inspect: () => host.inspect(),
            close,
          };
        },
      },
      headless: createHeadlessRunHostFactory({}, unmetered),
      ...(caller
        ? { caller: createCallerHostFactory(runConfig(caller.session), caller.pane, run) }
        : {}),
    }),
  );
  return {
    config: {
      aliases: OPERATOR_ALIASES,
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
 * How `awf allowance` reads each harness's plan: run as its agents are, so it reads the login they
 * get, and a usage screen opens in the Herdr session their panes would.
 */
export function allowanceReader(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  run: RunProcess = runProcess,
  signal?: AbortSignal,
  home: string = homedir(),
): (harness: Harness) => Promise<HarnessAllowance> {
  const unmetered = withholding(run, WITHHELD_ENVIRONMENT);
  const session = runSessionOnce(() => runSessionName(environment), { run, environment, home });
  return (harness) =>
    readAllowance(harness, {
      run: unmetered,
      now: Date.now,
      herdr: async () => ({
        ...herdrConfig((await session()).name),
        emptyEnvironment: PANE_WITHHELD_ENVIRONMENT,
      }),
      ...(signal ? { signal } : {}),
    });
}

/** Herdr in session `session`, where awf's runs open their tabs. */
export function herdrConfig(session: string): HerdrConfig {
  return { session, workspaceLabel: "awf run", commandTimeoutMs: 10_000 };
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
      unavailable[key] = messageOf(error);
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
 * The run session, made ready once for everything that asks. A failure is not kept: a run host
 * opened later, or the next harness's usage screen, asks again.
 */
function runSessionOnce(
  name: () => string,
  deps: Parameters<typeof ensureRunSession>[1],
  onReady?: (session: RunSession) => void,
): () => Promise<RunSession> {
  let ready: Promise<RunSession> | undefined;
  return () => {
    ready ??= Promise.resolve()
      .then(() => ensureRunSession(name(), deps))
      .then((session) => {
        // Saying where the agents are must never fail the agent.
        try {
          onReady?.(session);
        } catch {}
        return session;
      })
      .catch((error: unknown) => {
        ready = undefined;
        throw error;
      });
    return ready;
  };
}

/**
 * The Herdr session this process's pane is in, which `awf run --here` drives: the one owning
 * `$HERDR_SOCKET_PATH`. Never `AWF_HERDR_SESSION`, which places a run's agents, not its caller.
 */
export async function callerSession(
  run: RunProcess,
  environment: Readonly<Record<string, string | undefined>>,
): Promise<string> {
  const socket = environment.HERDR_SOCKET_PATH;
  if (!socket) throw new Error("not in a Herdr pane: HERDR_SOCKET_PATH is not set");
  const listed = await run({ argv: ["herdr", "session", "list", "--json"], timeoutMs: 10_000 });
  if (listed.exitCode !== 0) {
    throw new Error(`herdr session list failed: ${(listed.stderr || listed.stdout).trim()}`);
  }
  const name = parseSessions(listed.stdout).find((session) => session.socketPath === socket)?.name;
  // Guessing would drive a session nobody is looking at.
  if (name === undefined) {
    throw new Error(`no Herdr session owns ${socket} (\`herdr session list --json\`)`);
  }
  return name;
}

const METERED_CREDENTIAL_ENVIRONMENT = [
  ...new Set(Object.values(HARNESSES).flatMap((spec) => spec.meteredCredentials)),
];

/** What every harness's session sets for the commands it runs, `awf` among them. */
const CALLING_SESSION_ENVIRONMENT = [
  ...new Set(
    Object.values(HARNESSES).flatMap((spec) => [...spec.callingSessionEnv, ...spec.settingsEnv]),
  ),
];

/**
 * Unset for every agent: the metered credentials, which also refuse the run, the engine's own,
 * which a harness such as pi would otherwise bill against, the calling session's markers, and what
 * would override the settings an agent is launched at.
 */
const WITHHELD_ENVIRONMENT = [
  ...METERED_CREDENTIAL_ENVIRONMENT,
  "OPENROUTER_API_KEY",
  ...CALLING_SESSION_ENVIRONMENT,
];

/**
 * Unset in a run's panes besides: the config the run session's server starts with, which a `herdr`
 * started in a pane would otherwise read in place of the operator's.
 */
const PANE_WITHHELD_ENVIRONMENT = [...WITHHELD_ENVIRONMENT, "HERDR_CONFIG_PATH"];

function refuseMeteredCredentials(environment: Readonly<Record<string, string | undefined>>): void {
  const configured = METERED_CREDENTIAL_ENVIRONMENT.filter((name) => environment[name]?.trim());
  if (configured.length > 0) {
    throw new Error(
      `subscription runtime refused metered credential environment: ${configured.join(", ")}`,
    );
  }
}

/**
 * Each harness's subscription login is checked when its first agent opens, once a run: a run that
 * opens only codex agents needs no claude login, which is what lets one run in a box holding
 * codex's credential alone.
 */
function loginChecked(run: RunProcess, factory: AgentRunHostFactory): AgentRunHostFactory {
  const checks = new Map<string, Promise<void>>();
  const check = (harness: string): Promise<void> => {
    const login = Object.hasOwn(LOGINS, harness) ? LOGINS[harness as Harness] : undefined;
    if (!login || isAbsent(login)) return Promise.resolve();
    let checking = checks.get(harness);
    if (!checking) {
      checking = login(run);
      checks.set(harness, checking);
    }
    return checking;
  };
  return {
    ...factory,
    async openRun(spec) {
      const host = await factory.openRun(spec);
      return {
        ...host,
        async openAgent(request) {
          // The calling session is logged in as the operator logged it in; awf did not start it.
          if (!request.execution.caller) await check(request.execution.harness);
          return host.openAgent(request);
        },
        inspect: () => host.inspect(),
        close: (reason) => host.close(reason),
      };
    },
  };
}

/** The subscription login each harness's agents need, or why none is checked. */
const LOGINS: Readonly<Record<Harness, ((run: RunProcess) => Promise<void>) | Absent>> = {
  async claude(run) {
    const claude = await readClaudeBilling(run);
    if (claude !== "subscription") {
      throw new Error(
        `Claude subscription authentication is required (claude.ai login or \`claude setup-token\`); \`claude auth status\` reads as ${claude}`,
      );
    }
  },
  async codex(run) {
    const codex = await readCodexBilling(run);
    if (codex !== "subscription") {
      throw new Error(
        `Codex subscription authentication is required (ChatGPT login); \`codex login status\` reads as ${codex}`,
      );
    }
  },
  pi: { absent: "pi's login is per provider, and each agent's model names its own" },
  async cursor(run) {
    if (!(await readCursorLogin(run))) {
      throw new Error(
        "Cursor authentication is required (`cursor-agent login`); `cursor-agent status` reads as logged out",
      );
    }
  },
};
