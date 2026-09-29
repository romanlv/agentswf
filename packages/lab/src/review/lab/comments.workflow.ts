// A judge's check (story 008): the review comments a fixture's key cites, as findings, so a judge
// is scored on inputs whose labels the key already gives. Like the oracle it reads the key and the
// fixture's GitLab evidence, which no reviewer may: `argv: ["--set", setFolder, "--head", "{head}"]`.
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { defineExecutableWorkflow, type WorkflowInvocation } from "@agentswf/contract/workflow";
import { citedComments } from "../format/sanity";
import type { ReviewFinding } from "../format/scoring";
import { checkAnswerKey, checkFixture, describeProblems } from "../format/validate";

type Args = { set: string; head: string };

const executable = defineExecutableWorkflow<Args, ReviewFinding[]>({
  definition: {
    meta: {
      name: "review-comments",
      description: "Return the review comments a fixture's key cites, as findings.",
    },
    async run(_workflow, { set, head }) {
      for (const entry of readdirSync(set, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const dir = join(set, entry.name);
        const fixture = checkFixture(
          await Bun.file(join(dir, "fixture.json"))
            .json()
            .catch(() => null),
        );
        if (!fixture.ok || fixture.value.snapshot.head !== head) continue;
        const key = checkAnswerKey(await Bun.file(join(dir, "key", "key.json")).json());
        if (!key.ok) throw new Error(describeProblems(join(dir, "key", "key.json"), key.problems));
        const discussions = await Bun.file(
          join(dir, "key", "evidence", "gitlab", "discussions.json"),
        ).json();
        return citedComments(key.value, discussions).map((cited) => cited.finding);
      }
      throw new Error(`no fixture in ${set} is frozen at ${head}`);
    },
  },
  prepare: (invocation: WorkflowInvocation) => {
    const [flagSet, set, flagHead, head, ...rest] = invocation.argv;
    if (flagSet !== "--set" || !set || flagHead !== "--head" || !head || rest.length > 0) {
      throw new Error("usage: --set {set folder} --head {head}");
    }
    return { set: resolve(invocation.cwd, set), head };
  },
});

export default executable;
