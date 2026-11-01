import { defineWorkflow, isAnswered } from "@agentswf/contract/workflow";
import Type from "typebox";

export const DONE = Type.Object({ summary: Type.String() }, { additionalProperties: false });
export const VERDICT = Type.Object(
  { verdict: Type.Union([Type.Literal("approve"), Type.Literal("revise")]) },
  { additionalProperties: false },
);

export default defineWorkflow({
  meta: {
    name: "fix-tests",
    description: "A coder and a tester share a sandbox; a reviewer reads in one of its own.",
  },
  async run(wf) {
    // #region shared
    const box = await wf.sandboxes.open({
      key: "work",
      write: ["."], // the working directory; everything else stays read-only
      network: ["registry.npmjs.org"], // beyond each harness's own model API
    });
    const coder = await wf.agents.open({ key: "coder", runtime: "codex", sandbox: box });
    const tester = await wf.agents.open({ key: "tester", runtime: "codex", sandbox: box });
    // #endregion shared

    const fixed = await coder.run<Type.Static<typeof DONE>>({
      prompt: "Make `bun test` pass.",
      schema: DONE,
    });
    if (!isAnswered(fixed.outcome)) return wf.stop(`coder: ${fixed.outcome.reason}`);
    const tested = await tester.run<Type.Static<typeof DONE>>({
      prompt: "Run `bun test` and say what fails, if anything.",
      schema: DONE,
    });
    if (!isAnswered(tested.outcome)) return wf.stop(`tester: ${tested.outcome.reason}`);

    // #region private
    // An inline spec: a sandbox of the reviewer's own. It reads the working directory, writes
    // nothing, and reaches only its model.
    const reviewer = await wf.agents.open({ key: "reviewer", runtime: "codex", sandbox: {} });
    // #endregion private
    const review = await reviewer.run<Type.Static<typeof VERDICT>>({
      prompt: "Review the uncommitted change in this repository.",
      schema: VERDICT,
    });
    if (!isAnswered(review.outcome)) return wf.stop(`reviewer: ${review.outcome.reason}`);
    return { tests: tested.outcome.value.summary, verdict: review.outcome.value.verdict };
  },
});

export const pinned = defineWorkflow({
  meta: { name: "build-and-lint", description: "Each sandbox pinned to a provider." },
  async run(wf) {
    // #region providers
    await wf.sandboxes.open({ key: "build", write: ["."], docker: {} });
    await wf.sandboxes.open({ key: "lint", write: ["."], srt: {} });
    // #endregion providers
    return null;
  },
});
