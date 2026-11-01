// #region first
import { defineWorkflow, isAnswered } from "@agentswf/contract/workflow";
import Type from "typebox";

export const SCOPE = Type.Object(
  {
    files: Type.Array(Type.String(), { description: "Every file the fix would change." }),
    risk: Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")]),
  },
  { additionalProperties: false },
);

export default defineWorkflow({
  meta: { name: "scope-issue", description: "Ask an agent what fixing ISSUE.md would touch." },
  async run(wf) {
    const scoper = await wf.agents.open({
      key: "scoper",
      runtime: "claude",
      instructions: "You read code to answer questions about it. You never change it.",
    });
    const { outcome } = await scoper.run<Type.Static<typeof SCOPE>>({
      prompt: "Read ISSUE.md. Which files would its fix change, and how risky is it?",
      schema: SCOPE,
    });
    if (!isAnswered(outcome)) return wf.stop(`${outcome.kind}: ${outcome.reason}`);
    return outcome.value; // { files: string[]; risk: "low" | "medium" | "high" }
  },
});
// #endregion first

export const PLAN = Type.Object(
  {
    steps: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
    files: Type.Array(Type.String()),
  },
  { additionalProperties: false },
);
export type Plan = Type.Static<typeof PLAN>;

export const planAndReview = defineWorkflow({
  meta: { name: "plan-and-review", description: "Plan a fix, then review the plan twice over." },
  async run(wf) {
    // #region turns
    const planner = await wf.agents.open({
      key: "planner",
      runtime: { alias: "codex", effort: "high" },
    });
    const first = await planner.run<Plan>({
      prompt: "Read ISSUE.md and plan its fix.",
      schema: PLAN,
    });
    if (!isAnswered(first.outcome)) return wf.stop(`no plan: ${first.outcome.reason}`);
    // The same session: it remembers the issue and the plan it just made.
    const cut = await planner.run<Plan>({
      prompt: "Cut your plan down to the smallest change that fixes the issue.",
      schema: PLAN,
    });
    if (!isAnswered(cut.outcome)) return wf.stop(`no smaller plan: ${cut.outcome.reason}`);
    // #endregion turns

    // #region compact
    const compacted = await planner.compact({
      prompt: "Keep the final plan and the files it names. Drop the files' contents.",
    });
    if (!isAnswered(compacted)) wf.log("compaction didn't finish", { reason: compacted.reason });
    // #endregion compact

    // #region fork
    const reviewers = await Promise.all([
      planner.fork({ key: "security", instructions: "You look for security problems." }),
      planner.fork({ key: "tests", instructions: "You decide what tests a change needs." }),
    ]);
    const reviews = await Promise.all(
      reviewers.map(async (reviewer) => {
        const { outcome } = await reviewer.run({
          prompt: "Review your plan. One line per problem.",
        });
        return isAnswered(outcome) ? outcome.value : `${reviewer.key}: ${outcome.kind}`;
      }),
    );
    // #endregion fork

    // #region set
    await planner.set({ effort: "low" });
    const title = await planner.run({ prompt: "Write a pull request title for the plan." });
    // #endregion set

    return {
      plan: cut.outcome.value,
      reviews,
      title: isAnswered(title.outcome) ? title.outcome.value : null,
    };
  },
});

export const changelog = defineWorkflow({
  meta: { name: "changelog", description: "Write the changelog entry for this branch." },
  async run(wf) {
    // #region skills
    const writer = await wf.agents.open({
      key: "writer",
      runtime: "claude",
      skills: [{ path: new URL("./agents-skills/changelog", import.meta.url) }],
    });
    // #endregion skills
    const { outcome } = await writer.run({ prompt: "Write the changelog entry for this branch." });
    // #region login
    if (outcome.kind === "failed" && outcome.login) wf.stop(outcome.reason);
    // outcome.login.run: "run `claude`, then /login; …"
    // #endregion login
    return isAnswered(outcome) ? outcome.value : wf.stop(`${outcome.kind}: ${outcome.reason}`);
  },
});
