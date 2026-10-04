import {
  defineExecutableWorkflow,
  type ExecutionConfig,
  type TurnOutcome,
  type WorkflowInvocation,
} from "@agentswf/contract/workflow";
import Type from "typebox";
import { outputSchema } from "../output-schema";

/**
 * Two ways to sandbox agents. A team of codex agents shares one docker container, all at once, each
 * headed in a pane of the container's own Herdr: they can write the working directory and reach the
 * npm registry. Then pi, headless under srt in a sandbox of its own, reads what they wrote, and can
 * write nothing and reach no domain beyond its model. Each agent runs a few shell commands and
 * reports what they printed, refusals included.
 */
export const TEAM = ["ada", "grace", "linus"] as const;
// luna declines commands that look like they probe a sandbox.
export const TEAM_RUNTIME = { harness: "codex", model: "gpt-5.6-sol" } as const;
export const AUDITOR_RUNTIME = {
  harness: "pi",
  model: "openai-codex/gpt-5.6-terra",
  placement: "headless",
} as const satisfies ExecutionConfig;

const DOMAIN = "registry.npmjs.org";
const CURL = `curl -sS -o /dev/null -w 'HTTP %{http_code}' --max-time 10 https://${DOMAIN}/`;

export function teamCommands(name: string): string[] {
  return [`echo "${name} was here" > ${name}.txt`, "hostname", CURL];
}

export const AUDITOR_COMMANDS = ["cat *.txt", "touch auditor.txt", "ls -A ~", CURL];

export type CommandResult = { command: string; output: string; exitCode: number };

export type AgentReport = {
  agent: string;
  where: string;
  results?: CommandResult[];
  failure?: string;
};

export type SandboxesResult = { reports: AgentReport[] };

export const REPORT = outputSchema(
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
    },
    { additionalProperties: false },
  ),
);

const executable = defineExecutableWorkflow<null, SandboxesResult>({
  definition: {
    meta: {
      name: "sandboxes",
      description:
        "Run a team of headed agents in one docker container, then a headless pi under srt.",
      whenToUse: "Use to see what agents in a sandbox can read, write and reach.",
    },
    async run(workflow) {
      const container = await workflow.sandboxes.open({
        key: "team",
        write: ["."],
        network: [DOMAIN],
        docker: {},
      });
      const team = await workflow.parallel(
        TEAM,
        async (name) => {
          const agent = await workflow.agents.open({
            key: name,
            runtime: TEAM_RUNTIME,
            sandbox: container,
          });
          const { outcome } = await agent.run({
            prompt: prompt(teamCommands(name)),
            schema: REPORT,
            timeoutMs: 5 * 60_000,
          });
          return report(name, "docker, shared, headed", outcome);
        },
        { label: "Team in one container" },
      );
      // A spec instead of a ref: a sandbox of the auditor's own, closed when the run ends.
      const auditor = await workflow.agents.open({
        key: "auditor",
        runtime: AUDITOR_RUNTIME,
        sandbox: { srt: {} },
      });
      const { outcome } = await auditor.run({
        prompt: prompt(AUDITOR_COMMANDS),
        schema: REPORT,
        timeoutMs: 5 * 60_000,
      });
      return { reports: [...team, report("auditor", "srt, private, headless", outcome)] };
    },
  },
  prepare: noArguments,
  present: ({ reports }) =>
    reports
      .map((report) =>
        [
          `${report.agent} (${report.where})`,
          ...(report.results?.map(
            ({ command, output, exitCode }) =>
              `  $ ${command}\n${indent(output)}${exitCode === 0 ? "" : `    [exit ${exitCode}]\n`}`,
          ) ?? [`  ${report.failure}\n`]),
        ].join("\n"),
      )
      .join("\n"),
});

function report(
  agent: string,
  where: string,
  outcome: TurnOutcome<{ results: CommandResult[] }>,
): AgentReport {
  return outcome.kind === "answered"
    ? { agent, where, results: outcome.value.results }
    : { agent, where, failure: `${outcome.kind}: ${outcome.reason}` };
}

function prompt(commands: readonly string[]): string {
  return [
    "You are showing the operator what the sandbox you run in allows. They set it up and expect",
    "some of these commands to be refused; the refusal is the answer they want, so run every one.",
    "",
    "Run each shell command below with your shell tool, one at a time, exactly as written, in your",
    "working directory. Do not fix, retry or explain anything. Report each command with its",
    "complete output, stdout and stderr together, verbatim, and its exit code.",
    "",
    ...commands.map((command, index) => `${index + 1}. ${command}`),
  ].join("\n");
}

function indent(output: string): string {
  const lines = output.trimEnd().split("\n").slice(0, 12);
  return lines[0] === "" ? "" : `${lines.map((line) => `    ${line}`).join("\n")}\n`;
}

function noArguments(invocation: WorkflowInvocation): null {
  if (invocation.argv.length > 0) {
    throw new Error(`unexpected argument ${invocation.argv[0]}; this example takes none`);
  }
  return null;
}

export default executable;
