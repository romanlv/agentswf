import { defineWorkflow, isAnswered } from "@agentswf/contract/workflow";
import Type from "typebox";

export const CHANGED = Type.Object(
  {
    files: Type.Array(Type.String(), { minItems: 1 }),
    summary: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

export const TESTED = Type.Object(
  {
    failing: Type.Array(Type.String(), {
      description: "Each failing test's name.",
    }),
  },
  { additionalProperties: false },
);

// #region caller
export default defineWorkflow({
  meta: {
    name: "test-my-change",
    description:
      "A fresh agent tests the change this session made; the session fixes what fails.",
  },
  async run(wf) {
    const author = await wf.agents.caller({ key: "author" });
    if (!author)
      return wf.stop(
        "start this workflow with awf run --here from a coding session",
      );

    const changed = await author.run<Type.Static<typeof CHANGED>>({
      prompt:
        "List the files you changed in this session, and say in two sentences what changed.",
      schema: CHANGED,
    });
    if (!isAnswered(changed.outcome))
      return wf.stop(`no change: ${changed.outcome.reason}`);
    const { files, summary } = changed.outcome.value;

    const tester = await wf.agents.open({ key: "tester", runtime: "codex" });
    const tested = await tester.run<Type.Static<typeof TESTED>>({
      prompt: `${summary}\nTest this change in ${files.join(", ")}; list the failing tests.`,
      schema: TESTED,
    });
    if (!isAnswered(tested.outcome))
      return wf.stop(`no tests: ${tested.outcome.reason}`);
    const { failing } = tested.outcome.value;

    if (failing.length > 0) {
      await author.run({
        prompt:
          `These tests of your change fail: ${failing.join(", ")}. ` +
          "Fix the code, not the tests.",
      });
    }
    return { files, failing };
  },
});
// #endregion caller
