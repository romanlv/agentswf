import {
  defineWorkflow,
  type ExecutionConfig,
  isAnswered,
  type OutputSchema,
  type WorkflowInvocation,
} from "@agentswf/contract/workflow";

// An implementer writes slugify() in a fresh folder; a reviewer who knows the house style it was
// not told runs the code, asks for the fix by message, and checks again. Nothing to set up:
//
//   awf run examples/messaging/workflow.ts [-- codex | claude | pi | claude-pane]
//
// Both agents run the runtime named, codex when none is; each is one that can wait for a reply.

export const RUNTIMES = {
  codex: { harness: "codex", model: "gpt-6-luna", placement: "headless" },
  pi: {
    harness: "pi",
    model: "openrouter/deepseek/deepseek-v4.1-flash-1017",
    placement: "headless",
  },
  claude: { harness: "claude", model: "claude-sonnet-5-5", placement: "headless", metered: true },
  "claude-pane": { harness: "claude", model: "claude-sonnet-5-5" },
} as const satisfies Record<string, ExecutionConfig>;
export type RuntimeName = keyof typeof RUNTIMES;

/** What the house style makes of each title; the implementer is told none of it. */
export const CASES = [
  { title: "Hello, World!", slug: "hello_world" },
  { title: "  Crème Brûlée Recipes ", slug: "creme_brulee_recipes" },
  { title: "awf 2.0: Agents Talk", slug: "awf_2_0_agents_talk" },
] as const;

export const BUILT: OutputSchema<{ file: string }> = {
  type: "object",
  properties: { file: { type: "string" } },
  required: ["file"],
  additionalProperties: false,
};

export const REVIEW: OutputSchema<{
  approved: boolean;
  outputs: { title: string; slug: string }[];
}> = {
  type: "object",
  properties: {
    approved: { type: "boolean" },
    outputs: {
      type: "array",
      items: {
        type: "object",
        properties: { title: { type: "string" }, slug: { type: "string" } },
        required: ["title", "slug"],
        additionalProperties: false,
      },
    },
  },
  required: ["approved", "outputs"],
  additionalProperties: false,
};

export type MessagingResult = {
  folder: string;
  approved: boolean;
  /** Each slug the reviewer got by running the code, beside the house style's. */
  checks: { title: string; expected: string; got?: string }[];
  /** The implementer's turns that a message started. */
  revisions: number;
};

export const messaging = defineWorkflow<{ runtime: RuntimeName }, MessagingResult>({
  meta: {
    name: "messaging",
    description: "A reviewer asks an implementer for a fix by message and waits for it.",
    whenToUse: "Use to see agent messaging work end to end, for a few cents.",
  },
  async run(workflow, { runtime }) {
    const execution = RUNTIMES[runtime];
    const folder = `/tmp/awf-messaging/${workflow.runId}`;
    const implementer = await workflow.agents.open({ key: "implementer", runtime: execution });
    const reviewer = await workflow.agents.open({
      key: "reviewer",
      runtime: execution,
      instructions: [
        "You review code against the house style for slugs: lowercase ASCII, accents dropped,",
        "every run of other characters one underscore, none at either end.",
        ...CASES.map(({ title, slug }) => `${JSON.stringify(title)} -> ${slug}`),
      ].join("\n"),
    });
    await workflow.messages.allow({
      from: reviewer,
      to: implementer,
      purpose: "Ask the implementer to fix slugify() until it meets the house style.",
      maxMessages: 4,
    });

    const built = await implementer.run({
      label: "Implement",
      prompt: [
        `Create the folder ${folder} and write ${folder}/slug.mjs in it, exporting`,
        "slugify(title), which turns a title into a URL slug. Plain JavaScript, no dependencies.",
        "Work only in that folder.",
      ].join(" "),
      schema: BUILT,
    });
    if (!isAnswered(built.outcome)) return workflow.stop(`implementer: ${built.outcome.reason}`);

    const review = await reviewer.run({
      label: "Review",
      prompt: [
        `Review ${built.outcome.value.file}. Run slugify() on each title in your instructions`,
        "with node. If any slug is wrong, ask the implementer to fix it by message and wait for",
        "its reply, then run them again. Return the slugs you got on your last run.",
      ].join(" "),
      schema: REVIEW,
    });
    if (!isAnswered(review.outcome)) return workflow.stop(`reviewer: ${review.outcome.reason}`);

    const { approved, outputs } = review.outcome.value;
    return {
      folder,
      approved,
      checks: CASES.map(({ title, slug }) => {
        const got = outputs.find((output) => output.title === title)?.slug;
        return got === undefined ? { title, expected: slug } : { title, expected: slug, got };
      }),
      revisions: workflow
        .usage()
        .filter((operation) => operation.agent === "implementer" && operation.cause).length,
    };
  },
  prepare: parseRuntime,
  present: ({ folder, approved, checks, revisions }) =>
    [
      `${approved ? "approved" : "not approved"} after ${revisions} revision${revisions === 1 ? "" : "s"} by message; code in ${folder}`,
      ...checks.map(
        ({ title, expected, got }) =>
          `${got === expected ? "right" : "wrong"}  ${JSON.stringify(title)} -> ${got ?? "(not run)"}`,
      ),
    ].join("\n"),
});

function parseRuntime({ argv }: WorkflowInvocation): { runtime: RuntimeName } {
  const [runtime = "codex", ...rest] = argv;
  if (!Object.hasOwn(RUNTIMES, runtime) || rest.length > 0) {
    throw new Error(`messaging: -- [${Object.keys(RUNTIMES).join(" | ")}]`);
  }
  return { runtime: runtime as RuntimeName };
}

export default messaging;
