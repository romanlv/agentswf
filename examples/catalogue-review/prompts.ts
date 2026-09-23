import type { RawFinding } from "./schema";

export type LensSource = {
  page: string;
  /** The page's text, when the caller has it: an agent then has nothing outside the diff to open. */
  rules?: string;
};

// Lens and verifier must agree on it, or a verifier refutes what the lens was asked to report.
const SCOPE =
  "Report what this diff introduces or changes, and anything it makes wrong. A comment the diff edits is in scope as a whole. Code the diff leaves unchanged is out of scope even beside an edit: a problem that was already there is not this change's finding.";

const REACHABLE =
  "A caller or consumer counts only when it is reachable: trace it to an entry point such as a route, a rendered page or an exported command. Code nothing imports is not a consumer.";

export function catalogueLensPrompt(
  range: string,
  lens: LensSource,
  request?: { project: string; iid: number },
): string {
  return [
    `Review the changes in \`git diff ${range}\`${request ? ` for ${request.project}!${request.iid}` : ""}.`,
    intent(range),
    "",
    lens.rules
      ? `Apply these rules from ${lens.page}, exactly:\n\n${lens.rules}`
      : `Read ${lens.page}, follow it exactly, and review the diff.`,
    "",
    "Work through the rules one at a time. For each, go over every file the diff changes and note each",
    "place where its trigger could apply, then check each of those places. Report only after all",
    "rules are done.",
    "",
    "How to report:",
    `- ${SCOPE}`,
    "- A catalogue finding names the rule whose trigger the diff actually meets. Anything else is",
    "  `general`, and only when it is a real defect.",
    `- Verify each claim before reporting it: find the caller, consumer or test it depends on, and${base(range)}`,
    "  Drop anything you could not confirm in the code.",
    `- ${REACHABLE}`,
    "- When a rule depends on what exists elsewhere, such as a helper or a convention, search the",
    "  repository for it: the places and examples a rule names are not the whole list.",
    "- Behaviour the commits say is intended is not a defect in itself. Report it only when a rule",
    "  asks for something the change does not do.",
    "- `line` is the line in the new version of the file. `evidence` is the code facts that prove the",
    "  claim, in at most three sentences.",
    "- severity: `issue` should block the merge, `minor` is worth fixing, `observation` needs no action.",
    "- No findings is a good answer when nothing applies.",
  ].join("\n");
}

export function verificationPrompt(
  range: string,
  finding: RawFinding & { page: string },
  rules?: string,
): string {
  return [
    "Try to refute this finding. Default to refuted=true when uncertain.",
    `Diff: git diff ${range}`,
    intent(range),
    `File: ${finding.file}${finding.line ? `:${finding.line}` : ""}`,
    `Claim: ${finding.claim}`,
    `Evidence: ${finding.evidence}`,
    rules ? `Catalogue rules, from ${finding.page}:\n\n${rules}` : `Catalogue page: ${finding.page}`,
    `Attribution: ${finding.source}${finding.rule ? ` / ${finding.rule}` : ""}`,
    "",
    "Check the claim in the code yourself; the evidence above is the reviewer's, not a fact.",
    "Refute it when it is false, when it is out of scope, or when it describes behaviour the commits",
    "say is intended and no rule asks for more.",
    `Scope: ${SCOPE}`,
    REACHABLE,
    "For a catalogue finding, attribution=valid only when the named rule's trigger matches.",
    "Give the reason in at most two sentences: the fact that decided it.",
  ].join("\n");
}

function intent(range: string): string {
  return `The commits' messages (\`git log --format=%B ${range.replace("...", "..")}\`) say what the change intends.`;
}

// The left side of the range is the version before the change, when the range has one.
function base(range: string): string {
  const left = range.split(/\.{2,3}/)[0];
  return left && left !== range
    ? `\n  compare with the version before the change (\`git show ${left}:<path>\`).`
    : "\n  compare with the version before the change.";
}
