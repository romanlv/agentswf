import { defineExecutableWorkflow, isAnswered } from "../../../packages/contract/src/workflow";

/**
 * Two agents that name no sandbox, for `tests/run-sandbox.eval.ts`: a prober runs fixed shell
 * commands and reports what each printed, and a reader reads the request. Under `awf run --sandbox`
 * both land in the run's one sandbox. codex luna declined the probe's commands (story 004), so the
 * prober runs on sol.
 */
type ProbeResult = {
  results: { command: string; output: string; exitCode: number }[];
  firstLine: string;
};

const REPORT = {
  type: "object",
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        properties: {
          command: { type: "string" },
          output: { type: "string", description: "stdout and stderr, verbatim, at most 400 characters" },
          exitCode: { type: "integer" },
        },
        required: ["command", "output", "exitCode"],
        additionalProperties: false,
      },
    },
  },
  required: ["results"],
  additionalProperties: false,
} as const;

const LINE = {
  type: "object",
  properties: { firstLine: { type: "string" } },
  required: ["firstLine"],
  additionalProperties: false,
} as const;

export default defineExecutableWorkflow({
  definition: {
    meta: { name: "run-sandbox-probe", description: "Probe the run's sandbox from two agents." },
    async run(workflow, args: { request: string; commands: string[] }): Promise<ProbeResult> {
      const prober = await workflow.agents.open({
        key: "prober",
        runtime: { harness: "codex", model: "gpt-5.6-sol", placement: "headless" },
      });
      const reader = await workflow.agents.open({
        key: "reader",
        runtime: { harness: "codex", model: "gpt-6-luna", placement: "headless" },
      });
      const [probed, read] = await Promise.all([
        prober.run<Pick<ProbeResult, "results">>({
          prompt: [
            "This is a sandbox test. Run each shell command below exactly as written, one at a",
            "time, and report each one's exit code and output verbatim. Do not retry, work around",
            "or explain a failure: a failure is an expected result.",
            ...args.commands.map((command, i) => `${i + 1}. ${command}`),
          ].join("\n"),
          schema: REPORT,
        }),
        reader.run<{ firstLine: string }>({
          prompt: `Run \`head -1 ${args.request}\` and report the line it prints.`,
          schema: LINE,
        }),
      ]);
      if (!isAnswered(probed.outcome)) throw new Error(`prober: ${probed.outcome.kind}`);
      if (!isAnswered(read.outcome)) throw new Error(`reader: ${read.outcome.kind}`);
      return { results: probed.outcome.value.results, firstLine: read.outcome.value.firstLine };
    },
  },
  prepare: ({ argv }) => {
    const [flag, request, ...commands] = argv;
    if (flag !== "--request" || !request) throw new Error("usage: --request {file} {command}...");
    return { request, commands };
  },
});
