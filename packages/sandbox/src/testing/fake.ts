import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { LaunchedGroups } from "../groups";
import type {
  AgentContext,
  AgentDoor,
  OpenedSandbox,
  PaneHerdr,
  ResolvedSandbox,
  SandboxContext,
  SandboxedCommand,
  SandboxProvider,
} from "../seam";

export type FakeSandboxEvent =
  | { kind: "open"; sandbox: string; runRoot: string }
  | { kind: "admit"; sandbox: string; home: string; door: AgentDoor }
  | { kind: "release"; sandbox: string; home: string }
  | { kind: "launch" | "reap"; sandbox: string; home: string; argv: readonly string[] }
  | { kind: "close"; sandbox: string };

export type FakeSandboxOptions = {
  /** A reason to refuse this open, as a provider that cannot hold a spec does. */
  refuseOpen?(spec: ResolvedSandbox<unknown>): string | undefined;
  /** A reason to refuse this agent. */
  refuseAdmit?(agent: AgentContext): string | undefined;
  /** A reason every reap fails with, as a box gone from under it would. */
  failReap?: string;
  /** What the provider reports for the run's record. */
  record?: OpenedSandbox["record"];
  /** It hosts panes behind this prelude, each in the run's own Herdr unless it names another. */
  panes?: { prelude: string; ready: string; herdr?: PaneHerdr };
};

/** The markers every launched process carries: its sandbox's key, and its agent's home. */
export const FAKE_SANDBOX_ENV = "AWF_FAKE_SANDBOX";
export const FAKE_OCCUPANT_ENV = "AWF_FAKE_OCCUPANT";

/**
 * A provider that confines nothing, so engine and adapter tests can see what went through the
 * seam: every call is an event, and every process it launches carries `AWF_FAKE_SANDBOX`. Its
 * processes are real, run as a group from a pid file the way srt's are, so `reap`, `release`
 * and `close` really end them.
 */
export function createFakeSandboxProvider(options: FakeSandboxOptions = {}): {
  provider: SandboxProvider<Record<string, unknown>>;
  events: FakeSandboxEvent[];
} {
  const events: FakeSandboxEvent[] = [];
  const provider: SandboxProvider<Record<string, unknown>> = {
    environment(raw) {
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        throw new Error("fake sandbox settings must be an object");
      }
      return raw as Record<string, unknown>;
    },
    async open(spec, context) {
      const refused = options.refuseOpen?.(spec);
      if (refused) throw new Error(refused);
      events.push({ kind: "open", sandbox: spec.key, runRoot: context.runRoot });
      return openFake(spec, context, options, events);
    },
  };
  return { provider, events };
}

function openFake(
  spec: ResolvedSandbox<unknown>,
  context: SandboxContext,
  options: FakeSandboxOptions,
  events: FakeSandboxEvent[],
): OpenedSandbox {
  const pids = join(context.directory, "pids");
  const agents: LaunchedGroups[] = [];
  const { panes } = options;
  return {
    ...(options.record ? { record: options.record } : {}),
    ...(panes ? { panes: true as const } : {}),
    async admit(agent) {
      const refused = options.refuseAdmit?.(agent);
      if (refused) throw new Error(refused);
      const { home } = agent;
      events.push({ kind: "admit", sandbox: spec.key, home, door: agent.door });
      const groups = new LaunchedGroups(join(pids, randomUUID()));
      agents.push(groups);
      return {
        launch(root): SandboxedCommand {
          const argv = [...root.argv];
          events.push({ kind: "launch", sandbox: spec.key, home, argv });
          const wrapped = groups.wrap(argv);
          return {
            ...root,
            argv: wrapped.argv,
            env: {
              PATH: process.env.PATH ?? "/usr/bin:/bin",
              HOME: home,
              ...agent.harness.env,
              ...agent.harness.secrets,
              ...root.env,
              [FAKE_SANDBOX_ENV]: spec.key,
              [FAKE_OCCUPANT_ENV]: home,
            },
            group: true,
            async reap() {
              events.push({ kind: "reap", sandbox: spec.key, home, argv });
              await groups.kill(wrapped.pidFile);
              if (options.failReap) throw new Error(options.failReap);
            },
          };
        },
        async release() {
          events.push({ kind: "release", sandbox: spec.key, home });
          await groups.killAll();
        },
        ...(panes
          ? {
              pane: async () => ({
                herdr: panes.herdr ?? ("run" as const),
                prelude: panes.prelude,
                ready: panes.ready,
                harness: agent.harness.command,
              }),
            }
          : {}),
      };
    },
    async close() {
      events.push({ kind: "close", sandbox: spec.key });
      await Promise.all(agents.map((groups) => groups.killAll()));
      await rm(pids, { recursive: true, force: true });
    },
  };
}
