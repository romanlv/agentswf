// The sanity bound above every reviewer (story 008): it finds exactly the key's issues, each once,
// in the key's own words. A variant file hands it the set's folder, and the fixture's head to find
// its fixture by: `argv: ["--set", setFolder, "--head", "{head}"]`. It reads the key, which no
// reviewer may: its score checks the scorer and the judge, never a workflow.
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { defineExecutableWorkflow, type WorkflowInvocation } from "@agentswf/contract/workflow";
import { oracleFindings } from "../format/sanity";
import type { ReviewFinding } from "../format/scoring";
import { checkAnswerKey, checkFixture, describeProblems } from "../format/validate";

type Args = { set: string; head: string };

const executable = defineExecutableWorkflow<Args, ReviewFinding[]>({
  definition: {
    meta: {
      name: "review-oracle",
      description: "Return the answer key's issues as findings: the full-recall sanity bound.",
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
        return oracleFindings(key.value);
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
