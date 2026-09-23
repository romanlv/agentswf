import { SEVERITY_ORDER } from "./schema";
import type { CatalogueResult, ReviewedFinding } from "./workflow";

const WIDTH = 100;

type Numbered = { number: number; finding: ReviewedFinding };

/** The terminal summary: one entry per finding to act on. The report has the rest. */
export function presentCatalogueResult(result: CatalogueResult): string {
  const { confirmed, unchecked, refuted } = sections(result);
  const lines = [
    ...wrap(
      `Reviewed ${result.range} through ${result.lenses.length} lenses: ${result.lenses.join(", ")}`,
      "  ",
    ),
    ...(result.skipped.length > 0
      ? wrap(`Skipped, no matching files changed: ${result.skipped.join(", ")}`, "  ")
      : []),
    counts(result, confirmed, unchecked, refuted),
  ];
  if (confirmed.length === 0 && unchecked.length === 0) lines.push("", "Nothing to act on.");
  if (confirmed.length > 0) lines.push("", "CONFIRMED", ...summaryByFile(confirmed));
  if (unchecked.length > 0) {
    lines.push("", "NOT CHECKED: over the verification limit", ...summaryByFile(unchecked));
  }
  if (result.failures.length > 0) {
    lines.push("", "FAILED");
    for (const failure of result.failures) {
      lines.push(...wrap(`- ${failure.stage} ${failure.subject}: ${failure.reason}`, "  "));
    }
  }
  return lines.join("\n");
}

/** The handoff to the implementer: every finding with its evidence, and what was dropped and why. */
export function reportCatalogueResult(result: CatalogueResult): string {
  const { confirmed, unchecked, refuted } = sections(result);
  const skipped =
    result.skipped.length > 0
      ? ` Skipped, no matching files changed: ${result.skipped.join(", ")}.`
      : "";
  const lines = [
    `# Review of \`${result.range}\``,
    "",
    `Lenses: ${result.lenses.join(", ")}.${skipped}`,
    "",
    `${counts(result, confirmed, unchecked, refuted)}.`,
  ];
  if (confirmed.length > 0) {
    lines.push(
      "",
      "## Confirmed",
      "",
      "Each of these survived a separate attempt to refute it. Fix it, or say why it does not hold.",
      ...reportByFile(confirmed),
    );
  }
  if (unchecked.length > 0) {
    lines.push(
      "",
      "## Not checked",
      "",
      "Over the verification limit, so nobody has tried to refute these. Check each before acting.",
      ...reportByFile(unchecked),
    );
  }
  if (refuted.length > 0) {
    lines.push(
      "",
      "## Refuted",
      "",
      "Raised and then disproved; listed so they are not chased again.",
      "",
    );
    for (const finding of refuted) {
      lines.push(
        `- \`${location(finding)}\` (${attribution(finding)}): ${finding.claim}`,
        `  - Why not: ${reason(finding)}`,
      );
    }
  }
  if (result.failures.length > 0) {
    lines.push("", "## Did not complete", "");
    for (const failure of result.failures) {
      lines.push(`- ${failure.stage} \`${failure.subject}\`: ${failure.reason}`);
    }
  }
  return lines.join("\n");
}

// The summary and the report number findings alike, so "fix 2 and 4" means the same in both.
function sections(result: CatalogueResult): {
  confirmed: Numbered[];
  unchecked: Numbered[];
  refuted: ReviewedFinding[];
} {
  const ofKind = (kind: ReviewedFinding["verification"]["kind"]) =>
    groupByFile(result.findings.filter((finding) => finding.verification.kind === kind));
  const confirmed = ofKind("confirmed");
  const unchecked = ofKind("not-checked");
  return {
    confirmed: confirmed.map((finding, index) => ({ number: index + 1, finding })),
    unchecked: unchecked.map((finding, index) => ({
      number: confirmed.length + index + 1,
      finding,
    })),
    refuted: ofKind("refuted"),
  };
}

// Files in order of their most severe finding; several lenses often land on the same file.
function groupByFile(findings: ReviewedFinding[]): ReviewedFinding[] {
  const files = new Map<string, ReviewedFinding[]>();
  for (const finding of findings.toSorted(bySeverity)) {
    files.set(finding.file, [...(files.get(finding.file) ?? []), finding]);
  }
  return [...files.values()].flatMap((inFile) => inFile.toSorted(bySeverityThenLine));
}

function summaryByFile(findings: Numbered[]): string[] {
  const lines: string[] = [];
  let file: string | undefined;
  for (const { number, finding } of findings) {
    if (finding.file !== file) {
      file = finding.file;
      lines.push("", file);
    }
    const marker = `  ${number}. [${finding.severity}]${finding.line ? ` line ${finding.line}` : ""}`;
    lines.push(...wrap(`${marker} ${finding.claim}`, " ".repeat(`  ${number}. `.length)));
  }
  return lines;
}

function reportByFile(findings: Numbered[]): string[] {
  const lines: string[] = [];
  let file: string | undefined;
  for (const { number, finding } of findings) {
    if (finding.file !== file) {
      file = finding.file;
      lines.push("", `### \`${file}\``);
    }
    const where = finding.line ? `, line ${finding.line}` : "";
    lines.push(
      "",
      `**${number}. ${finding.severity}${where}** · ${attribution(finding)}`,
      "",
      finding.claim,
      "",
      `- Evidence: ${finding.evidence}`,
      ...(finding.suggestion ? [`- Suggestion: ${finding.suggestion}`] : []),
      ...(finding.verification.kind === "confirmed"
        ? [`- Verifier: ${finding.verification.reason}`]
        : []),
    );
  }
  return lines;
}

function counts(
  result: CatalogueResult,
  confirmed: Numbered[],
  unchecked: Numbered[],
  refuted: ReviewedFinding[],
): string {
  return [
    count(confirmed.length, "confirmed finding"),
    `${refuted.length} refuted`,
    `${unchecked.length} not checked`,
    count(result.failures.length, "failed agent"),
  ].join(" · ");
}

function location(finding: ReviewedFinding): string {
  return `${finding.file}${finding.line ? `:${finding.line}` : ""}`;
}

function attribution(finding: ReviewedFinding): string {
  const rule = finding.source === "catalogue" && finding.rule ? finding.rule : "general";
  return `${finding.lens} · ${rule}`;
}

function reason(finding: ReviewedFinding): string {
  return finding.verification.kind === "not-checked" ? "" : finding.verification.reason;
}

function bySeverity(left: ReviewedFinding, right: ReviewedFinding): number {
  return SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity];
}

function bySeverityThenLine(left: ReviewedFinding, right: ReviewedFinding): number {
  return bySeverity(left, right) || (left.line ?? 0) - (right.line ?? 0);
}

function count(amount: number, noun: string): string {
  return `${amount} ${noun}${amount === 1 ? "" : "s"}`;
}

// Soft-wrapped terminal lines lose their indent, so long text is wrapped here with a hanging one.
function wrap(text: string, hanging: string): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/(?<=\S) +/)) {
    if (line !== "" && line.length + 1 + word.trimStart().length > WIDTH) {
      lines.push(line);
      line = hanging + word.trimStart();
    } else {
      line = line === "" ? word : `${line} ${word}`;
    }
  }
  if (line !== "") lines.push(line);
  return lines;
}
