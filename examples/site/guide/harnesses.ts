import {
  type AgentExecution,
  defineWorkflow,
  isAnswered,
  type RuntimeSelection,
} from "@agentswf/contract/workflow";
import Type from "typebox";

// #region runtimes
export const RUNTIMES = {
  // an alias: claude's sonnet, at its default effort
  alias: "claude",
  // an alias at another effort
  thorough: { alias: "codex", effort: "high" },
  // spelled out: the harness, its model in its own words, an effort it lists
  pi: {
    harness: "pi",
    model: "openrouter/deepseek/deepseek-v4.1-flash",
    effort: "low",
  },
  // cursor takes no effort: the variant is the model
  cursor: { harness: "cursor", model: "gpt-5.6-luna-high" },
  // headless: a process per turn, nothing to watch
  quiet: { harness: "codex", model: "gpt-5.6-sol", placement: "headless" },
  // headless claude is per token, and says so
  meteredClaude: {
    harness: "claude",
    model: "sonnet",
    placement: "headless",
    metered: true,
  },
} satisfies Record<string, RuntimeSelection>;
// #endregion runtimes

/** Opens one agent on each of `RUNTIMES`, and returns what each runs on. */
export const eachRuntime = defineWorkflow({
  meta: {
    name: "each-runtime",
    description: "Open an agent on each runtime shape.",
  },
  async run(wf) {
    const opened: Record<string, AgentExecution> = {};
    for (const [key, runtime] of Object.entries(RUNTIMES)) {
      opened[key] = (await wf.agents.open({ key, runtime })).execution;
    }
    return opened;
  },
});

export const PLAN = Type.Object(
  { steps: Type.Array(Type.String()) },
  { additionalProperties: false },
);

export default defineWorkflow({
  meta: {
    name: "plan-and-list",
    description: "Plan in a watched pane, then list the files headless.",
  },
  async run(wf) {
    // #region workflow
    const planner = await wf.agents.open({
      key: "planner",
      runtime: { alias: "claude", effort: "high" }, // a pane, on your Claude plan
      keepPane: "on-failure",
    });
    const lister = await wf.agents.open({
      key: "lister",
      runtime: {
        harness: "codex",
        model: "gpt-5.6-sol",
        effort: "low",
        placement: "headless",
      },
    });
    // #endregion workflow
    const plan = await planner.run<Type.Static<typeof PLAN>>({
      prompt:
        "Plan how to add a --verbose flag to the CLI. Don't edit anything.",
      schema: PLAN,
    });
    if (!isAnswered(plan.outcome))
      return wf.stop(`${plan.outcome.kind}: ${plan.outcome.reason}`);
    const files = await lister.run({
      prompt: [
        "List the files this plan touches, one per line:",
        ...plan.outcome.value.steps,
      ].join("\n"),
    });
    return {
      steps: plan.outcome.value.steps,
      files: isAnswered(files.outcome) ? files.outcome.value : "",
    };
  },
});

// #region unmetered
export const unmetered = defineWorkflow({
  meta: {
    name: "unmetered",
    description: "A headless claude agent without metered: true.",
  },
  async run(wf) {
    // rejects: headless claude is billed per token even on a subscription login; set metered: true to run it
    await wf.agents.open({
      key: "summarizer",
      runtime: { harness: "claude", model: "sonnet", placement: "headless" },
    });
    return null;
  },
});
// #endregion unmetered

export const unlisted = defineWorkflow({
  meta: {
    name: "unlisted",
    description: "A claude agent at an effort claude doesn't list.",
  },
  async run(wf) {
    await wf.agents.open({
      key: "planner",
      runtime: { alias: "claude", effort: "ultra" },
    });
    return null;
  },
});

export const reviewers = defineWorkflow({
  meta: {
    name: "reviewers",
    description: "A lead and two reviewers in one tab where you typed awf run.",
  },
  async run(wf) {
    // #region layout
    const lead = await wf.agents.open({
      key: "lead",
      runtime: "claude",
      layout: { workspace: "origin", tab: "review" }, // a new tab where you typed `awf run`
      keepPane: "on-failure",
    });
    await lead.run({
      prompt: "Read the change on this branch and plan the review.",
    });
    const security = await lead.fork({
      key: "security",
      layout: { beside: "lead", side: "right" },
    });
    const style = await lead.fork({
      key: "style",
      layout: { beside: "security", side: "below" },
    });
    // #endregion layout
    const notes = await wf.parallel([security, style], (agent) =>
      agent.run({ prompt: "Review the change in your area." }),
    );
    return notes.map(({ outcome }) =>
      isAnswered(outcome) ? outcome.value : outcome.kind,
    );
  },
});
