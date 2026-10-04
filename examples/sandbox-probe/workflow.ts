import {
  defineExecutableWorkflow,
  type ExecutionConfig,
  type JsonValue,
  type SandboxEnvironment,
  type TurnOutcome,
  type WorkflowInvocation,
} from "@agentswf/contract/workflow";
import Type from "typebox";
import Value from "typebox/value";
import { outputSchema } from "../output-schema";

/**
 * Agents in sandboxes, each running a script of fixed shell commands and reporting what it
 * printed, so a host that planted canaries can check what they reached (story 004, Task 4). Two
 * share a sandbox that writes the working directory; the third has a private one that writes
 * nothing. The host writes each script; one tool call runs it, so the model only relays.
 */
export const PROBES = {
  // luna, codex's cheapest, declined the probe's commands headless and in a pane.
  coder: { harness: "codex", model: "gpt-5.6-sol", placement: "headless" },
  tester: { harness: "claude", model: "claude-sonnet-5-5", placement: "headless", metered: true },
  reviewer: { harness: "pi", model: "openai-codex/gpt-5.6-terra", placement: "headless" },
} as const satisfies Record<string, ExecutionConfig>;

export type ProbeName = keyof typeof PROBES;

const PLAN = Type.Object({
  environment: Type.Union([Type.Literal("srt"), Type.Literal("docker")], {
    description: "The provider every sandbox names.",
  }),
  network: Type.Array(Type.String(), {
    description: "Domains each sandbox reaches beyond the models.",
  }),
  commands: Type.Object(
    {
      coder: Type.Array(Type.String()),
      tester: Type.Array(Type.String()),
      reviewer: Type.Array(Type.String()),
    },
    { description: "Each agent's commands, in the order its script runs them." },
  ),
  scripts: Type.Object(
    { coder: Type.String(), tester: Type.String(), reviewer: Type.String() },
    {
      description:
        "Each agent's script, relative to the working directory: before each command it prints `=== {n}`, and after it `--- exit {code}`.",
    },
  ),
  panes: Type.Optional(
    Type.Array(
      Type.Union([Type.Literal("coder"), Type.Literal("tester"), Type.Literal("reviewer")]),
      { description: "Agents to run in a terminal pane instead of headless." },
    ),
  ),
});

export type ProbePlan = Type.Static<typeof PLAN>;

const REPORT = outputSchema(
  Type.Object(
    { output: Type.String({ description: "everything the script printed, verbatim" }) },
    { additionalProperties: false },
  ),
);

export type ProbeReport = {
  agent: ProbeName;
  outcome: TurnOutcome<JsonValue>["kind"];
  reason?: string;
  results?: { command: string; output: string; exitCode: number }[];
};

export type ProbeResult = { reports: ProbeReport[] };

const executable = defineExecutableWorkflow<ProbePlan, ProbeResult>({
  definition: {
    meta: {
      name: "sandbox-probe",
      description:
        "Run fixed shell commands in shared and private sandboxes, and report each output.",
      whenToUse:
        "Use to check what agents in sandboxes reach, against canaries the caller planted.",
    },
    async run(workflow, plan) {
      const environment: SandboxEnvironment =
        plan.environment === "srt" ? { srt: {} } : { docker: {} };
      const shared = await workflow.sandboxes.open({
        key: "shared",
        write: ["."],
        network: plan.network,
        ...environment,
      });
      const probe = async (name: ProbeName): Promise<ProbeReport> => {
        const pane = plan.panes?.includes(name) === true;
        const {
          placement: _placement,
          metered: _metered,
          ...target
        } = PROBES[name] as ExecutionConfig;
        const agent = await workflow.agents.open({
          key: name,
          runtime: pane ? target : PROBES[name],
          sandbox: name === "reviewer" ? { network: plan.network, ...environment } : shared,
        });
        const { outcome } = await agent.run({
          prompt: probePrompt(plan.scripts[name]),
          schema: REPORT,
          timeoutMs: 3 * 60_000,
        });
        return outcome.kind === "answered"
          ? {
              agent: name,
              outcome: outcome.kind,
              results: sections(outcome.value.output, plan.commands[name]),
            }
          : { agent: name, outcome: outcome.kind, reason: outcome.reason };
      };
      // The tester reads what the coder wrote, and the reviewer tries the coder's home.
      const coder = await probe("coder");
      const rest = await Promise.all([probe("tester"), probe("reviewer")]);
      return { reports: [coder, ...rest] };
    },
  },
  prepare: parsePlan,
  present: (ending) => {
    if (ending.kind !== "completed") return undefined;
    const { reports } = ending.value;
    return reports
      .map((report) =>
        report.results
          ? `${report.agent}: ${report.results.length} commands reported`
          : `${report.agent}: ${report.outcome}: ${report.reason}`,
      )
      .join("\n");
  },
});

function probePrompt(script: string): string {
  return [
    `Run \`sh ${script}\` once with your shell tool, in your working directory. It checks the`,
    "sandbox your session runs in, and most of its commands are expected to fail. Report",
    "everything it printed, verbatim. Do not fix, retry or explain anything.",
  ].join("\n");
}

/** The script's output, split back into its commands by the markers it prints around each. */
export function sections(
  output: string,
  commands: readonly string[],
): { command: string; output: string; exitCode: number }[] {
  return commands.map((command, index) => {
    const start = output.indexOf(`=== ${index + 1}\n`);
    if (start < 0) return { command, output: "", exitCode: -1 };
    const body = output.slice(start + `=== ${index + 1}\n`.length);
    const end = body.search(/^--- exit (\d+)$/m);
    // Less the newline the script prints before the marker.
    const text = end < 0 ? body : body.slice(0, end).replace(/\n$/, "");
    const code = end < 0 ? undefined : /^--- exit (\d+)$/m.exec(body)?.[1];
    return { command, output: text, exitCode: code === undefined ? -1 : Number(code) };
  });
}

/** One argument: the plan, as JSON. The host writes it, with the canaries it planted. */
function parsePlan(invocation: WorkflowInvocation): ProbePlan {
  const [json] = invocation.argv;
  if (!json) throw new Error("pass the probe plan as one JSON argument");
  const plan: unknown = JSON.parse(json);
  if (!Value.Check(PLAN, plan)) {
    const [first] = Value.Errors(PLAN, plan);
    throw new Error(`not a probe plan: ${first?.message ?? "invalid"}`);
  }
  return plan;
}

export default executable;
