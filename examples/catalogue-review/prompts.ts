import type { RawFinding } from "./schema";

export function catalogueLensPrompt(
  project: string,
  iid: number,
  range: string,
  page: string,
): string {
  return [
    `Read ${range} for ${project}!${iid}.`,
    `Read ${page}, follow it exactly, and review the diff.`,
  ].join("\n");
}

export function verificationPrompt(
  range: string,
  finding: RawFinding & { page: string },
): string {
  return [
    "Try to refute this finding. Default to refuted=true when uncertain.",
    `Diff: ${range}`,
    `File: ${finding.file}${finding.line ? `:${finding.line}` : ""}`,
    `Claim: ${finding.claim}`,
    `Evidence: ${finding.evidence}`,
    `Catalogue page: ${finding.page}`,
    `Attribution: ${finding.source}${finding.rule ? ` / ${finding.rule}` : ""}`,
    "For a catalogue finding, attribution=valid only when the named rule's trigger matches.",
  ].join("\n");
}
