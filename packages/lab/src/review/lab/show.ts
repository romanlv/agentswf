import { SHOW_FORMAT, type ShowDocument } from "../format/output";
import { PARTIAL_SCORE_FORMAT, type PartialScore, type Score } from "../format/records";
import { categoryOf } from "../judge/panel";
import { formatAddress } from "./address";
import type { CaseInfo } from "./execute";
import type { Stored } from "./plan";
import { duration } from "./report";
import { DEFAULT_VERSION } from "./version";

type Ref = { name: string; version: string; hash: string };

/**
 * One case, trial or finding in full: the case and its key, the trial and its run, and each
 * scorer's latest score of it on the current key, with every finding's label, votes and reasons.
 * A scorer with only partial scores shows its latest, labelling the findings it asked. `findings`
 * limits which findings are shown; absent, all are.
 */
export function buildShow(options: {
  id: string;
  dataset: string;
  variant: Ref;
  info: CaseInfo;
  title: string;
  trial?: Stored;
  trialRunDir: string | null;
  scorers: readonly { scorer: Ref; score?: Score | PartialScore; runDir: string | null }[];
  findings?: readonly number[];
}): ShowDocument {
  const { info, trial } = options;
  const issues = new Map(info.key.issues.map((issue) => [issue.id, issue]));
  const findings = (trial?.trial.findings ?? []).flatMap((finding, index) => {
    if (options.findings && !options.findings.includes(index)) return [];
    return [
      {
        id: formatAddress({ case: info.id, finding: index }),
        text: finding.text,
        ...(finding.path ? { path: finding.path } : {}),
        ...(finding.line ? { line: finding.line } : {}),
        ...(finding.severity !== undefined ? { severity: finding.severity } : {}),
        labels: options.scorers.flatMap(({ scorer, score }) => {
          if (score?.result.status !== "scored") return [];
          const { labels, votes = [] } = score.result.judgement;
          const label = labels.find((l) => l.finding === index);
          if (!label) return [];
          if (score.format === PARTIAL_SCORE_FORMAT && !score.asked.includes(index)) return [];
          const issue = label.label === "hit" ? issues.get(label.issue) : undefined;
          return [
            {
              scorer: scorer.name,
              category: categoryOf(label),
              label,
              ...(issue ? { issue: { id: issue.id, mechanism: issue.mechanism } } : {}),
              votes: votes.flatMap((vote) => {
                const said = vote.labels.find((l) => l.finding === index);
                return said ? [{ by: vote.by, role: vote.role, label: said }] : [];
              }),
            },
          ];
        }),
      },
    ];
  });
  return {
    format: SHOW_FORMAT,
    id: options.id,
    dataset: options.dataset,
    variant: options.variant,
    case: {
      id: info.id,
      digest: info.digest,
      dir: info.dir,
      title: options.title,
      key: {
        revision: info.key.revision,
        procedure: info.key.procedure,
        issues: info.key.issues.map((issue) => ({
          id: issue.id,
          severity: issue.severity,
          category: issue.category,
          scope: issue.scope,
          mechanism: issue.mechanism,
        })),
      },
    },
    trial: trial
      ? {
          id: formatAddress({ case: info.id, trial: 1 }),
          trial: trial.trial.id,
          at: trial.trial.at,
          run: trial.trial.run,
          runDir: options.trialRunDir,
          ...(trial.trial.failure ? { failure: trial.trial.failure } : {}),
          findings: trial.trial.findings.length,
        }
      : null,
    scores: options.scorers.map(({ scorer, score, runDir }) => {
      if (!score) return { scorer, status: "none" as const };
      const common = {
        scorer,
        at: score.at,
        ...(score.agreement !== undefined ? { agreement: score.agreement } : {}),
        ...(score.run ? { run: score.run, runDir } : {}),
      };
      if (score.format === PARTIAL_SCORE_FORMAT && score.result.status === "scored") {
        return {
          ...common,
          status: "partial" as const,
          asked: score.asked,
          restFrom: {
            name: score.restFrom.scorer.name,
            version: score.restFrom.scorer.version ?? DEFAULT_VERSION,
            hash: score.restFrom.scorer.hash,
          },
        };
      }
      return score.result.status === "scored"
        ? { ...common, status: "scored" as const, missed: score.result.judgement.missed }
        : {
            ...common,
            status: "failed" as const,
            reason: score.result.reason,
            problems: score.result.problems,
          };
    }),
    findings,
  };
}

const usd = (value: number | undefined) => (value === undefined ? "$?" : `$${value.toFixed(2)}`);

const indent = (text: string, by = "    ") =>
  text
    .split("\n")
    .map((line) => `${by}${line}`)
    .join("\n");

/** The document as a person reads it. */
export function renderShow(doc: ShowDocument): string {
  const lines = [
    `${doc.variant.name}:${doc.id}    dataset ${doc.dataset}, variant ${doc.variant.version} ${doc.variant.hash}`,
    `case      ${doc.case.id}  ${doc.case.title}`,
    `          ${doc.case.dir}`,
    `key       r${doc.case.key.revision} (${doc.case.key.procedure}), ${doc.case.key.issues.length} issues`,
    ...doc.case.key.issues.map(
      (issue) => `  ${issue.id.padEnd(4)} ${issue.severity.padEnd(11)} ${issue.mechanism}`,
    ),
  ];
  if (!doc.trial) lines.push("trial     none on file");
  else {
    const { run } = doc.trial;
    lines.push(
      `trial     ${doc.trial.id} ${doc.trial.trial}, ${run.outcome}, ${doc.trial.findings} findings, ${duration(run.ms)} ${usd(run.estimate)}${doc.trial.failure ? ` — ${doc.trial.failure}` : ""}`,
      `          ${doc.trial.runDir ?? "run directory gone"}`,
    );
  }
  for (const score of doc.scores) {
    const what =
      score.status === "none"
        ? "no score on this key"
        : score.status === "failed"
          ? `failed, ${score.reason}${score.problems?.[0] ? `: ${score.problems[0]}` : ""}`
          : score.status === "partial"
            ? `partial: #${score.asked?.join(", #")}, the rest from ${score.restFrom?.name}`
            : `scored${score.agreement !== undefined ? `, voters' κ ${score.agreement.toFixed(2)}` : ""}`;
    const run = score.run ? `, ${duration(score.run.ms)} ${usd(score.run.estimate)}` : "";
    lines.push(`scorer    ${score.scorer.name} ${score.scorer.version}: ${what}${run}`);
    if (score.runDir) lines.push(`          ${score.runDir}`);
    if (score.missed) lines.push(indent(`missed: ${score.missed}`, "          "));
  }
  for (const finding of doc.findings) {
    const where = finding.path ? `  ${finding.path}${finding.line ? `:${finding.line}` : ""}` : "";
    lines.push("", `${finding.id}${where}${finding.severity ? `  (${finding.severity})` : ""}`);
    lines.push(indent(finding.text));
    for (const label of finding.labels) {
      lines.push(
        `  ${label.scorer}: ${label.category}${label.issue ? ` — ${label.issue.mechanism}` : ""}`,
      );
      lines.push(indent(label.label.why, "      "));
      for (const vote of label.votes) {
        lines.push(`      ${vote.role} ${vote.by}: ${categoryOf(vote.label)} — ${vote.label.why}`);
      }
    }
  }
  return lines.join("\n");
}
