import { randomUUID } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { SandboxRecord } from "@agentswf/contract/records";
import type {
  AbsoluteDeadline,
  AgentExecution,
  SandboxEnvironmentKey,
  SandboxRef,
} from "@agentswf/contract/workflow";
import { type AgentSkills, harnessState, sandboxNeeds, skillsLayout } from "@agentswf/harness";
import {
  type AgentDoor,
  type HarnessSandboxNeeds,
  type Occupant,
  type OpenedSandbox,
  type ResolvedSandbox,
  repositoryOf,
  resolveSandbox,
  type SandboxProviders,
  withinReach,
} from "@agentswf/sandbox";
import { CONTROL_PLANE_ROOT } from "./control-plane";
import { messageOf } from "./errors";
import { machinePaths } from "./runs";
import { type CredentialLocks, placeCarried, type SeededHome, seedHome } from "./sandbox-homes";
import { placeSkills, type ResolvedSkill } from "./skills/run-skills";

/** The providers a run may open sandboxes with, and where their directories are made. */
export type RunSandboxOptions = {
  providers: SandboxProviders;
  /**
   * Where each sandbox's own directory, its homes and quarantine, is made. Outside the run root, so
   * a provider that denies it hides none of a sandbox's own.
   */
  sandboxesDir: string;
  /**
   * The operator's environment, which says where each harness keeps its state, the `PATH` an
   * agent's harness is found on and claude's token. Defaults to the engine's.
   */
  environment?: Readonly<Record<string, string | undefined>>;
  /**
   * The operator's sandbox for the whole run (`awf run --sandbox`): every agent runs in it, at the
   * run's working directory, and the workflow opens none of its own. Unresolved, as a file gave it.
   */
  run?: unknown;
};

/** Why a workflow's own sandbox is refused in a run the operator gave one. */
export const RUN_SANDBOX_ONLY =
  "every agent in this run runs in the sandbox awf run --sandbox gave it; a workflow cannot open its own";

/** Where one agent will run in a sandbox, settled before anything is opened for it. */
export type Seat = {
  /** The agent's working directory, by its real path, which is the one every provider shares. */
  cwd: string;
  home: string;
  /** Its skills, copied into its home as it is seeded; absent when the workflow named none. */
  skills?: AgentSkills;
  /**
   * Admits the agent through `door`, once its home is seeded, with `carry`'s files where a fork's
   * session comes from another home; serialized per sandbox.
   */
  admit(door: AgentDoor, carry?: string): Promise<SeatedAgent>;
  /**
   * Undoes a seat whose agent never opened: its admission is released, and a private sandbox
   * closes, so nothing outlives the failure. Never rejects: a failure is logged.
   */
  abandon(): Promise<void>;
};

export type SeatedAgent = {
  occupant: Occupant;
  /** Hands a refreshed credential back to the operator; after each operation and at release. */
  writeBack(): Promise<void>;
  /** Writes back, then releases the occupant; once, however often it is called. */
  release(): Promise<void>;
};

type RunSandbox = {
  key: string;
  provider: SandboxEnvironmentKey;
  resolved: ResolvedSandbox<unknown>;
  directory: string;
  opened: OpenedSandbox;
  /** The last admission in line; the next one waits for it. */
  admitting: Promise<unknown>;
  agents: { agent: string; home: string; domains: readonly string[] }[];
  /** Its close, once started; a private sandbox's starts when its agent fails to open. */
  closing?: Promise<void>;
  /** Whether the operator was told how to watch its panes, which it says at its first. */
  watched?: true;
};

/**
 * One run's sandboxes: the ones the workflow opens, and the private ones inline specs make. The
 * engine keeps them here, apart from any provider: it resolves a spec, opens it through the
 * provider its environment names, admits agents one at a time, and closes each after its agents.
 */
export class RunSandboxes {
  /** Each key taken, by an open landed or in flight; a failed open frees its key. */
  readonly #keys = new Map<string, Promise<RunSandbox>>();
  /** Every sandbox that opened, in order, closed early or not: what the record lists. */
  readonly #opened: RunSandbox[] = [];
  readonly #refs = new WeakMap<object, RunSandbox>();
  /** Every admitted agent, released after its session closes and before its channel does. */
  readonly #held: SeatedAgent[] = [];
  readonly #providers: SandboxProviders;
  readonly #environment: Readonly<Record<string, string | undefined>>;
  #runRoot: Promise<string> | undefined;
  /** The operator's sandbox, opened once before the workflow runs. */
  #runSandbox: Promise<RunSandbox> | undefined;
  #closed = false;

  constructor(
    private readonly options: {
      sandboxes?: RunSandboxOptions;
      runRoot: string;
      cwd: string;
      deadline: AbsoluteDeadline;
      /** The run's credential write-backs, which a host agent's own home shares. */
      locks: CredentialLocks;
      log(message: string): void;
    },
  ) {
    this.#providers = options.sandboxes?.providers ?? { installed: {} };
    this.#environment = options.sandboxes?.environment ?? process.env;
  }

  /** Whether the operator gave the run a sandbox, which every agent runs in. */
  get hasRunSandbox(): boolean {
    return this.options.sandboxes?.run !== undefined;
  }

  /** `workflow.sandboxes.open`. */
  async open(spec: unknown): Promise<SandboxRef> {
    if (this.hasRunSandbox) throw new Error(RUN_SANDBOX_ONLY);
    const key = (spec as { key?: unknown } | null)?.key;
    if (typeof key !== "string" || key === "") throw new Error("a sandbox needs a key");
    if (key.startsWith("agent:")) {
      throw new Error(`sandbox key ${key}: agent: names the sandboxes agents are given`);
    }
    const sandbox = await this.#register(key, () => this.#open(key, spec, false));
    const ref = Object.freeze({ key: sandbox.key, provider: sandbox.provider });
    this.#refs.set(ref, sandbox);
    return ref as unknown as SandboxRef;
  }

  /**
   * Where `agent` runs, given its spec's `sandbox`: a ref this run returned, or an inline spec for
   * a private sandbox, opened now. Rejects before anything is opened for the agent itself: an
   * unknown ref, an agent outside the sandbox's reach, a harness no sandbox can run.
   */
  async seat(agent: {
    key: string;
    sandbox: unknown;
    cwd: string;
    execution: AgentExecution;
    skills?: readonly ResolvedSkill[];
    /** A fork's parent, whose sandbox it shares, a private one too. */
    joins?: string;
  }): Promise<Seat> {
    const shared = this.hasRunSandbox
      ? await this.#joinRunSandbox()
      : (this.#shared(agent.sandbox) ??
        (agent.joins === undefined ? undefined : await this.#parents(agent.joins)));
    const pane = agent.execution.placement !== "headless";
    const key = `agent:${agent.key}`;
    const sandbox =
      shared ?? (await this.#register(key, () => this.#open(key, agent.sandbox, true, agent.cwd)));
    let seated: Promise<SeatedAgent> | undefined;
    const abandon = async () => {
      await seated?.then((agent) => agent.release()).catch(() => undefined);
      if (shared) return;
      await this.#close(sandbox).catch((error: unknown) =>
        this.options.log(`sandbox ${key}: ${messageOf(error)}`),
      );
    };
    try {
      if (pane && !sandbox.opened.panes) {
        throw new Error(`agent ${agent.key}: sandbox ${sandbox.key} hosts no panes`);
      }
      const cwd = await realpath(agent.cwd);
      assertWithin(sandbox, agent.key, cwd, await repositoryOf(cwd, await realpath(homedir())));
      const id = randomUUID();
      const home = join(sandbox.directory, "homes", id);
      // Beside `homes/`, which every agent in the sandbox can write, and out of their reach.
      const staging = join(sandbox.directory, "staging", id);
      const needs = await sandboxNeeds(
        agent.execution.harness,
        home,
        agent.execution.model,
        this.#environment,
      );
      const given = agent.skills;
      const skills = given
        ? skillsLayout(
            agent.execution.harness,
            given.map((skill) => skill.name),
            { sandboxHome: home },
          )
        : undefined;
      // Into the staged home, before it moves where the sandbox's agents can write.
      const populate = (carry?: string) => async (staged: string) => {
        if (given && skills) {
          await placeSkills(given, join(staged, relative(home, skills.directory)));
        }
        if (carry) await placeCarried(carry, staged);
      };
      return {
        cwd,
        home,
        ...(skills ? { skills } : {}),
        abandon,
        admit: (door, carry) => {
          seated = this.#admit(
            sandbox,
            agent.key,
            cwd,
            { home, staging },
            needs,
            door,
            populate(carry),
          );
          return seated;
        },
      };
    } catch (error) {
      await abandon();
      throw error;
    }
  }

  /** A fork's parent's private sandbox, which must still be open: a fork never opens its own. */
  async #parents(parent: string): Promise<RunSandbox> {
    const sandbox = await this.#keys.get(`agent:${parent}`)?.catch(() => undefined);
    if (!sandbox || sandbox.closing) {
      throw new Error(`agent ${parent}'s sandbox is closed, so its fork has nowhere to run`);
    }
    return sandbox;
  }

  /**
   * Whether a reopened agent names the sandbox it runs in: the same ref, or an inline spec that
   * resolves as its private one did. When its private sandbox never opened or was closed after a
   * failure, the agent's own failure is the answer, so this says yes and lets it speak.
   */
  async same(agentKey: string, first: unknown, next: unknown, cwd: string): Promise<boolean> {
    if (first === undefined) return false;
    if (this.#isRef(first) || this.#isRef(next)) return first === next;
    const key = `agent:${agentKey}`;
    // Still opening counts: the first open's spec is the one to compare against.
    const current = await this.#keys.get(key)?.catch(() => undefined);
    if (!current || current.closing) return true;
    const { sandbox } = await resolveSandbox(next, await this.#resolveOptions(key, cwd, true));
    // What the spec says, not the gitdirs found: an agent's own clone or worktree adds one.
    const said = ({ gitdirs: _, ...rest }: ResolvedSandbox<unknown>) => rest;
    return isDeepStrictEqual(said(sandbox), said(current.resolved));
  }

  /**
   * Releases every seated agent: after the host closed their sessions, before their channels. The
   * run is ending, so nothing opens or is admitted after it.
   */
  async release(): Promise<unknown[]> {
    this.#closed = true;
    await Promise.allSettled(
      [...this.#keys.values()].map((sandbox) => sandbox.then((s) => s.admitting)),
    );
    const settled = await Promise.allSettled(this.#held.map((agent) => agent.release()));
    return settled.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
  }

  /**
   * Closes every sandbox, after its agents. One still opening is waited for, and closed as it
   * lands, so the record lists it and nothing it made outlives the run.
   */
  async close(): Promise<unknown[]> {
    this.#closed = true;
    await Promise.allSettled(this.#keys.values());
    const settled = await Promise.allSettled(this.#opened.map((sandbox) => this.#close(sandbox)));
    return settled.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
  }

  /** Each sandbox the run opened, a private one closed after its agent failed too, with its agents. */
  records(): SandboxRecord[] {
    return this.#opened.map(({ key, provider, resolved, directory, opened, agents }) => {
      const domains = new Set([...resolved.network, ...agents.flatMap((agent) => agent.domains)]);
      return {
        callPath: [],
        key,
        provider,
        spec: {
          cwd: resolved.cwd,
          read: [...resolved.read],
          write: [...resolved.write],
          network: [...resolved.network],
          [provider]: resolved.environment,
        },
        directory,
        gitdirs: resolved.gitdirs.map((gitdir) => ({ ...gitdir })),
        domains: [...domains].sort(),
        ...(opened.record ? { provided: structuredClone(opened.record) } : {}),
        agents: agents.map(({ agent, home }) => ({ callPath: [], agent, home })),
      };
    });
  }

  /**
   * Opens the operator's sandbox before the workflow runs, so one that can't open fails the run
   * before it starts rather than as the workflow's failure.
   */
  async openRunSandbox(): Promise<void> {
    await this.#joinRunSandbox();
  }

  #joinRunSandbox(): Promise<RunSandbox> {
    // Opened once: a spec that fails to open fails every agent the same way, and is not retried.
    this.#runSandbox ??= this.#register("run", () =>
      this.#open("run", this.options.sandboxes?.run, true),
    );
    return this.#runSandbox;
  }

  #isRef(sandbox: unknown): boolean {
    return typeof sandbox === "object" && sandbox !== null && this.#refs.has(sandbox);
  }

  #close(sandbox: RunSandbox): Promise<void> {
    sandbox.closing ??= sandbox.opened.close();
    return sandbox.closing;
  }

  #shared(sandbox: unknown): RunSandbox | undefined {
    if (typeof sandbox !== "object" || sandbox === null) {
      throw new Error("an agent's sandbox is a ref from sandboxes.open or an inline spec");
    }
    const shared = this.#refs.get(sandbox);
    if (shared) return shared;
    // A ref-shaped object the engine did not make is not a spec either.
    if ("provider" in sandbox) {
      throw new Error("not a sandbox this run opened; pass the ref sandboxes.open returned");
    }
    return undefined;
  }

  async #register(key: string, open: () => Promise<RunSandbox>): Promise<RunSandbox> {
    if (this.#closed) throw new Error("the run's sandboxes are closed");
    if (this.#keys.has(key)) throw new Error(`sandbox ${key} is already open`);
    const opening = open();
    this.#keys.set(key, opening);
    let sandbox: RunSandbox;
    try {
      sandbox = await opening;
    } catch (error) {
      // So a retry can use the key again.
      this.#keys.delete(key);
      throw error;
    }
    this.#opened.push(sandbox);
    // Landed after the run's sandboxes closed: it closes at once, and is still recorded.
    if (this.#closed) {
      await this.#close(sandbox).catch(() => undefined);
      throw new Error("the run's sandboxes are closed");
    }
    return sandbox;
  }

  async #open(
    key: string,
    spec: unknown,
    inline: boolean,
    cwd = this.options.cwd,
  ): Promise<RunSandbox> {
    const options = await this.#resolveOptions(key, cwd, inline);
    const { provider, sandbox: resolved } = await resolveSandbox(spec, options);
    // Resolving found the provider installed, which only the operator's sandboxes install.
    const setup = this.options.sandboxes;
    const installed = setup?.providers.installed[provider];
    if (!setup || !installed) throw new Error(`the ${provider} sandbox provider is not installed`);
    // Minted, not derived from the key, which may hold `/` or `..`; real, as every path a
    // provider is handed is, so a path rule it writes matches what the system checks.
    const parent = setup.sandboxesDir;
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const directory = join(await realpath(parent), randomUUID());
    // Before the provider opens: a box mounts `homes/` once, and later agents' homes appear in it.
    await mkdir(join(directory, "homes"), { recursive: true, mode: 0o700 });
    const opened = await installed.open(resolved, {
      runRoot: options.runRoot,
      directory,
      deadline: this.options.deadline,
    });
    return { key, provider, resolved, directory, opened, admitting: Promise.resolve(), agents: [] };
  }

  async #resolveOptions(key: string, cwd: string, inline: boolean) {
    this.#runRoot ??= realpath(this.options.runRoot);
    return {
      key,
      cwd,
      runRoot: await this.#runRoot,
      machineRoot: machinePaths(homedir()).root,
      providers: this.#providers,
      harnessState: Object.values(harnessState(this.#environment)),
      controlRoot: CONTROL_PLANE_ROOT,
      inline,
    };
  }

  #admit(
    sandbox: RunSandbox,
    agent: string,
    cwd: string,
    { home, staging }: { home: string; staging: string },
    needs: HarnessSandboxNeeds,
    door: AgentDoor,
    populate?: (staged: string) => Promise<void>,
  ): Promise<SeatedAgent> {
    const admission = sandbox.admitting.then(async (): Promise<SeatedAgent> => {
      if (this.#closed) throw new Error("the run's sandboxes are closed");
      const seeded: SeededHome = await seedHome(
        home,
        staging,
        needs,
        cwd,
        this.options.locks,
        populate,
      );
      const occupant = await sandbox.opened.admit({ cwd, home, harness: needs, door });
      sandbox.agents.push({ agent, home, domains: needs.domains });
      // Admitted as the run released its agents: released now, before its sandbox closes.
      if (this.#closed) {
        await occupant.release().catch(() => undefined);
        throw new Error("the run's sandboxes are closed");
      }
      const who = `sandbox ${sandbox.key}: ${agent}`;
      let released: Promise<void> | undefined;
      const seated: SeatedAgent = {
        occupant: this.#logged(sandbox, occupant, who),
        writeBack: () => seeded.writeBack(),
        release: () => {
          released ??= seeded
            .writeBack()
            .catch((error) => this.options.log(`${who}: ${messageOf(error)}`))
            .then(() => occupant.release());
          return released;
        },
      };
      this.#held.push(seated);
      return seated;
    });
    sandbox.admitting = admission.catch(() => undefined);
    return admission;
  }

  /**
   * The occupant, with a reap that fails logged where it happens, on every path, and the operator
   * told how to watch a sandbox's own Herdr at its first pane.
   */
  #logged(sandbox: RunSandbox, occupant: Occupant, who: string): Occupant {
    const { pane } = occupant;
    return {
      ...occupant,
      ...(pane
        ? {
            pane: async () => {
              const terminal = await pane();
              const { herdr } = terminal;
              if (herdr !== "run" && herdr.watch && !sandbox.watched) {
                sandbox.watched = true;
                this.options.log(
                  `sandbox ${sandbox.key}: watch its panes with ${herdr.watch.join(" ")}`,
                );
              }
              return terminal;
            },
          }
        : {}),
      launch: (root) => {
        const command = occupant.launch(root);
        const { reap } = command;
        if (!reap) return command;
        return {
          ...command,
          reap: () =>
            reap().catch((error: unknown) =>
              this.options.log(`${who}: a turn's leftovers may still run: ${messageOf(error)}`),
            ),
        };
      },
    };
  }
}

function assertWithin(
  sandbox: RunSandbox,
  agent: string,
  cwd: string,
  repository: { gitdirs: string[] } | undefined,
): void {
  if (!withinReach(sandbox.resolved, cwd)) {
    throw new Error(`agent ${agent}: ${cwd} is outside sandbox ${sandbox.key}'s reach`);
  }
  const known = new Set(sandbox.resolved.gitdirs.map((gitdir) => gitdir.path));
  const missing = repository?.gitdirs.find((gitdir) => !known.has(gitdir));
  // A running box cannot gain a mount, so the gitdir must have been resolved when it opened.
  if (missing) {
    throw new Error(
      `agent ${agent}: its gitdir ${missing} is outside sandbox ${sandbox.key}'s reach`,
    );
  }
}
