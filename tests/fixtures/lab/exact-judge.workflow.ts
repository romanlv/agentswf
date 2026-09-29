// A judge for awf-lab's tests: a finding whose text is a key issue's mechanism hits it, a repeat
// of an earlier finding's text is its duplicate, and anything else is noise. `--mode bad` answers
// with an issue the key lacks, so the judgement fails its check; `--settled {file}` keeps the labels
// in it and labels only the rest, which `--mode tamper` then relabels anyway, and `--mode noise`
// calls noise; `--mode split` adds two panel votes that split on every hit, the second calling it
// noise; any other mode changes nothing but the judge's identity.
import { join } from "node:path";
import { defineExecutableWorkflow, type WorkflowInvocation } from "../../../packages/contract/src/workflow";
import type { AnswerKey } from "../../../packages/autoresearch/src/review/format/format";
import type {
  FindingLabel,
  Judgement,
  ReviewFinding,
} from "../../../packages/autoresearch/src/review/format/scoring";

type Args = { fixture: string; findings: string; mode: string; settled?: string };

const executable = defineExecutableWorkflow<Args, Judgement>({
  definition: {
    meta: { name: "exact-judge", description: "Label findings by exact text." },
    async run(_workflow, args) {
      const key: AnswerKey = await Bun.file(join(args.fixture, "key", "key.json")).json();
      const findings: ReviewFinding[] = await Bun.file(args.findings).json();
      const settled: FindingLabel[] = args.settled ? await Bun.file(args.settled).json() : [];
      const kept = new Map(settled.map((label) => [label.finding, label]));
      const claimed = new Set(settled.flatMap((l) => (l.label === "hit" ? [l.issue] : [])));
      const labels = findings.map((finding, index): FindingLabel => {
        const read = [{ path: "src/app.ts", start: 1, end: 1 }];
        const given = kept.get(index);
        if (given && args.mode === "tamper") return { finding: index, label: "noise", why: "tampered", read };
        if (given) return given;
        if (args.mode === "noise") return { finding: index, label: "noise", why: "noise mode", read };
        const earlier = findings.findIndex((f) => f.text === finding.text);
        if (earlier < index) return { finding: index, label: "duplicate", of: earlier, why: "same", read: [] };
        if (args.mode === "bad") return { finding: index, label: "hit", issue: "K99", why: "bad", read };
        const issue = key.issues.find((i) => i.mechanism === finding.text && !claimed.has(i.id));
        if (issue) {
          claimed.add(issue.id);
          return { finding: index, label: "hit", issue: issue.id, why: "exact", read };
        }
        return { finding: index, label: "noise", why: "no match", read };
      });
      const votes =
        args.mode === "split"
          ? [
              { by: "a", role: "panel" as const, labels },
              {
                by: "b",
                role: "panel" as const,
                labels: labels.map((l): FindingLabel =>
                  l.label === "hit" ? { finding: l.finding, label: "noise", why: "b says noise", read: l.read } : l,
                ),
              },
            ]
          : undefined;
      return { format: "awf.review-judgement/1", labels, missed: `mode ${args.mode}`, ...(votes ? { votes } : {}) };
    },
  },
  prepare: (invocation: WorkflowInvocation) => {
    const values = new Map<string, string>();
    for (let i = 0; i < invocation.argv.length; i += 2) {
      values.set(invocation.argv[i]!.slice(2), invocation.argv[i + 1]!);
    }
    return {
      fixture: values.get("fixture")!,
      findings: values.get("findings")!,
      mode: values.get("mode") ?? "plain",
      ...(values.has("settled") ? { settled: values.get("settled")! } : {}),
    };
  },
});

export default executable;
