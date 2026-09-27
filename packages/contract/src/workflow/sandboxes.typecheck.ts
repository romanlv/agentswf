import type {
  AgentOpenSpec,
  InlineSandboxSpec,
  SandboxEnvironment,
  SandboxEnvironmentKey,
  SandboxOpenSpec,
  SandboxRef,
  SandboxSpec,
  WorkflowContext,
} from "./index";

declare const context: WorkflowContext;
declare const ref: SandboxRef;

const headless = { placement: "headless" } as const;

async function acceptedShapes(): Promise<void> {
  const box = await context.sandboxes.open({
    key: "build",
    write: ["."],
    network: ["registry.npmjs.org", "*.npmjs.org"],
    docker: { image: "awf-agent:node22" },
  });
  const local = await context.sandboxes.open({ key: "lint", cwd: "/repo", srt: {} });
  const unpinned = { read: ["~/notes"] } satisfies SandboxSpec;
  const opened: AgentOpenSpec[] = [
    { key: "coder", runtime: { alias: "codex", ...headless }, sandbox: box },
    { key: "linter", runtime: "pi", sandbox: local },
    { key: "reviewer", runtime: "codex", sandbox: {} },
    { key: "reader", runtime: "codex", sandbox: unpinned },
    { key: "tester", runtime: "claude", sandbox: { write: ["."], docker: {} } },
  ];
  void [box.provider, opened];
}

function rejectedShapes(): void {
  // @ts-expect-error A sandbox has at most one environment.
  const twoEnvironments: SandboxOpenSpec = { key: "both", srt: {}, docker: {} };
  // @ts-expect-error srt takes no settings yet.
  const srtSettings: SandboxSpec = { srt: { image: "node" } };
  const lookAlike = { key: "build", provider: "srt" };
  // @ts-expect-error Only the engine makes a ref; a look-alike is not one.
  const forged: AgentOpenSpec = { key: "coder", runtime: "codex", sandbox: lookAlike };
  // @ts-expect-error An open spec is not an inline one: its key would name a shared sandbox.
  const keyed: AgentOpenSpec = { key: "coder", runtime: "codex", sandbox: { key: "build" } };
  // @ts-expect-error An inline sandbox's working directory is the agent's.
  const inlineCwd: InlineSandboxSpec = { cwd: "/elsewhere" };
  // @ts-expect-error A ref's provider cannot be written into a spec.
  const inlineProvider: InlineSandboxSpec = { provider: "docker" };
  void [twoEnvironments, srtSettings, forged, keyed, inlineCwd, inlineProvider, ref];
}

// Every environment key is a settings field in a spec, and every settings field is a key.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type SettingsFields = SandboxEnvironment extends infer E ? (E extends E ? keyof E : never) : never;
const environmentsMatch: Same<SettingsFields, SandboxEnvironmentKey> = true;

void [acceptedShapes, rejectedShapes, environmentsMatch];
