import {
  defineExecutableWorkflow,
  type ExecutionConfig,
  isAnswered,
  type SkillSource,
  type WorkflowInvocation,
} from "@wf/contract/workflow";
import Type from "typebox";
import { outputSchema } from "../output-schema";

/**
 * One agent reviews a change in one turn, with a public review skill or none: the baseline every
 * richer review workflow is compared with (story 008). The prompt is the same either way, so a
 * skill is the only difference between the two.
 */

type PublicSkill = Extract<SkillSource, { repo: string }>;

const SEVERITIES = ["must-fix", "should-fix", "could-fix", "nit"] as const;

const FINDINGS_SCHEMA = outputSchema(
  Type.Object(
    {
      findings: Type.Array(
        Type.Object(
          {
            file: Type.String({ minLength: 1 }),
            line: Type.Optional(Type.Integer({ minimum: 1 })),
            severity: Type.Enum([...SEVERITIES]),
            claim: Type.String({ minLength: 1, description: "What is wrong, in a sentence." }),
            evidence: Type.String({
              minLength: 1,
              description: "The code that shows it, and when it goes wrong.",
            }),
          },
          { additionalProperties: false },
        ),
      ),
    },
    { additionalProperties: false },
  ),
);

export type SingleFinding = Type.Static<typeof FINDINGS_SCHEMA>["findings"][number];

export type SingleReviewArgs = {
  range: string;
  /** The author's title and description, when the caller has them. */
  request?: string;
  skill?: PublicSkill;
  runtime: ExecutionConfig;
};

export type SingleReviewResult = {
  range: string;
  skill: string | null;
  findings: SingleFinding[];
};

/** Claude, headless and so billed per token; a pane needs the operator's Herdr. */
const DEFAULT_RUNTIME: ExecutionConfig = {
  harness: "claude",
  model: "claude-sonnet-5",
  placement: "headless",
  metered: true,
};

function reviewPrompt(args: SingleReviewArgs): string {
  return `Review the change \`git diff ${args.range}\` in this repository, as a careful senior reviewer would before it merges.
${args.request ? `\nThe author's title and description are in ${args.request}; read them first.\n` : ""}
Read the changed code and whatever it calls or is called by, as far as you need. Report each problem you find in the change: what goes wrong, when, and what it costs. Say which code shows it. Leave out praise, summaries and matters of taste.

Severity: \`must-fix\` when merging causes harm with today's code and data; \`should-fix\` when a likely next change or input triggers it; \`could-fix\` when it is real but unlikely; \`nit\` when it changes no behaviour.

Don't change anything in the repository. Answer with every finding; an empty list if you found none.`;
}

const executable = defineExecutableWorkflow<SingleReviewArgs, SingleReviewResult>({
  definition: {
    meta: {
      name: "single-agent-review",
      description: "One agent reviews a change in one turn, with a public review skill or none.",
      whenToUse: "Use as a baseline review, or to measure what a review skill adds.",
    },
    async run(workflow, args) {
      const agent = await workflow.agents.open({
        key: "reviewer",
        runtime: args.runtime,
        // Exactly the skill named, or none: what the agent has is the variable measured.
        skills: args.skill ? [args.skill] : [],
      });
      const { outcome } = await agent.run({ prompt: reviewPrompt(args), schema: FINDINGS_SCHEMA });
      if (!isAnswered(outcome)) throw new Error(`no review: ${outcome.kind}: ${outcome.reason}`);
      return {
        range: args.range,
        skill: args.skill
          ? `${args.skill.repo}/${args.skill.skill}${args.skill.ref ? `@${args.skill.ref}` : ""}`
          : null,
        findings: outcome.value.findings,
      };
    },
  },
  prepare: parseArgs,
  present: ({ findings }) =>
    findings.length === 0
      ? "no findings"
      : findings
          .map((f) => `${f.severity} ${f.file}${f.line ? `:${f.line}` : ""} — ${f.claim}`)
          .join("\n"),
});

/**
 * `--range A...B` (default `origin/main...HEAD`), `--request {file}`, `--skill owner/repo/skill@ref`
 * (a public skill, pinned), `--runtime harness/model` (headless).
 */
function parseArgs(invocation: WorkflowInvocation): SingleReviewArgs {
  const values = new Map<string, string>();
  const argv = [...invocation.argv];
  while (argv.length > 0) {
    const flag = argv.shift()!;
    const value = argv.shift();
    const name = flag.slice(2);
    if (!flag.startsWith("--") || value === undefined) {
      throw new Error(`expected --flag value, got ${flag}`);
    }
    if (!["range", "request", "skill", "runtime"].includes(name)) {
      throw new Error(`unknown flag --${name}`);
    }
    if (values.has(name)) throw new Error(`--${name} is given twice`);
    values.set(name, value);
  }
  const args: SingleReviewArgs = {
    range: values.get("range") ?? "origin/main...HEAD",
    runtime: DEFAULT_RUNTIME,
  };
  const request = values.get("request");
  if (request) args.request = request.startsWith("/") ? request : `${invocation.cwd}/${request}`;
  const skill = values.get("skill");
  if (skill) args.skill = skillOf(skill);
  const runtime = values.get("runtime");
  if (runtime) {
    const [harness, model] = runtime.split("/", 2);
    if (!harness || !model) throw new Error("--runtime is harness/model");
    args.runtime = {
      harness,
      model,
      placement: "headless",
      ...(harness === "claude" ? { metered: true as const } : {}),
    };
  }
  return args;
}

/** `owner/repo/skill@ref`: the repository on GitHub, the skill's name in it, and the ref it is pinned to. */
function skillOf(spec: string): PublicSkill {
  // Pinned, so the skill cannot change under a variant whose hash only covers this argument.
  const matched = /^([^/@\s]+\/[^/@\s]+)\/([^/@\s]+)@(\S+)$/.exec(spec);
  if (!matched) throw new Error("--skill is owner/repo/skill@ref, pinned to a ref");
  const [, repo, skill, ref] = matched;
  return { repo: repo!, skill: skill!, ref: ref! };
}

export default executable;
