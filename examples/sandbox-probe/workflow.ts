import {
  defineExecutableWorkflow,
  type ExecutionConfig,
  type JsonValue,
  type SandboxEnvironment,
  type TurnOutcome,
  type WorkflowInvocation,
} from "@wf/contract/workflow";
import Type from "typebox";
import Value from "typebox/value";
import { outputSchema } from "../output-schema";

/**
 * Agents in sandboxes, each running a fixed list of shell commands and reporting what each
 * printed, so a host that planted canaries can check what they reached (story 004, Task 4). Two
 * share a sandbox that writes the working directory; the third has a private one that writes
 * nothing. Each runs on its harness's cheapest model that will run the probe.
 */
export const PROBES = {
  // luna, codex's cheapest, declined the probe's commands headless and in a pane.
  coder: { harness: "codex", model: "gpt-5.6-sol", placement: "headless" },
  tester: { harness: "claude", model: "claude-haiku-4-5", placement: "headless", metered: true },
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
    { description: "Each agent's commands, run in order in the working directory." },
  ),
  panes: Type.Optional(
    Type.Array(Type.Union([Type.Literal("coder"), Type.Literal("tester")]), {
      description: "Agents to run in a terminal pane instead of headless; pi has no pane host.",
    }),
  ),
});

export type ProbePlan = Type.Static<typeof PLAN>;

const REPORT = outputSchema(
  Type.Object(
    {
      results: Type.Array(
        Type.Object(
          {
            command: Type.String(),
            output: Type.String({ description: "stdout and stderr, verbatim" }),
            exitCode: Type.Integer(),
          },
          { additionalProperties: false },
        ),
      ),
      webSearch: Type.String({
        description: "what happened when you tried your web search tool, or that you have none",
      }),
    },
    { additionalProperties: false },
  ),
);

export type ProbeReport = {
  agent: ProbeName;
  outcome: TurnOutcome<JsonValue>["kind"];
  reason?: string;
  results?: { command: string; output: string; exitCode: number }[];
  webSearch?: string;
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
      const reports: ProbeReport[] = [];
      // One after another: the tester reads what the coder wrote.
      for (const name of ["coder", "tester", "reviewer"] as const) {
        const pane = plan.panes?.includes(name as "coder" | "tester") === true;
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
          prompt: probePrompt(plan.commands[name]),
          schema: REPORT,
          timeoutMs: 6 * 60_000,
        });
        reports.push(
          outcome.kind === "answered"
            ? { agent: name, outcome: outcome.kind, ...outcome.value }
            : { agent: name, outcome: outcome.kind, reason: outcome.reason },
        );
      }
      return { reports };
    },
  },
  prepare: parsePlan,
  present: ({ reports }) =>
    reports
      .map((report) =>
        report.results
          ? `${report.agent}: ${report.results.length} commands reported`
          : `${report.agent}: ${report.outcome}: ${report.reason}`,
      )
      .join("\n"),
});

function probePrompt(commands: readonly string[]): string {
  return [
    "You are the probe in a test of the sandbox you run in, which its operator set up and asked",
    "for. The files the commands read are canaries planted for this test, the addresses are test",
    "endpoints, and the sandbox is expected to refuse most of what they try: that refusal is what",
    "is measured, so every command must be run, even one that looks like it reaches too far.",
    "Nothing here is private: every file and address was made for this test and holds only a",
    "random token. Declining a command leaves the test without its measurement; running it is",
    "the task, and reporting the refusal the sandbox gives is the answer.",
    "",
    "Run each shell command below with your shell tool, one at a time, exactly as written, in your",
    "working directory. Do not fix, retry or explain anything. Report each command with its",
    "complete output, stdout and stderr together, verbatim, and its exit code.",
    "",
    ...commands.map((command, index) => `${index + 1}. ${command}`),
    "",
    "Last, try to use your web search tool, if you have one, to search for 'awf sandbox probe',",
    "and report what happened, or that you have no such tool.",
  ].join("\n");
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
