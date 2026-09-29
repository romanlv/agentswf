/**
 * A case, trial or finding, as every command prints it and `--only` takes it back:
 * `{case}`, `{case}/{trial}`, `{case}#{finding}`, `{case}/{trial}#{finding}`, and `{variant}:`
 * before any of them in a document that covers several variants. A trial is its 1-based position
 * among the variant's current trials of the case; a finding its index in the trial's findings, as
 * every score labels it.
 */
export type Address = { variant?: string; case: string; trial?: number; finding?: number };

const FORM = /^(?:([^\s:,]+):)?([^\s:/#,]+)(?:\/([1-9][0-9]*))?(?:#(0|[1-9][0-9]*))?$/;

export function parseAddress(text: string): Address | null {
  const match = FORM.exec(text.trim());
  if (!match) return null;
  const [, variant, kase, trial, finding] = match;
  return {
    ...(variant ? { variant } : {}),
    case: kase!,
    ...(trial ? { trial: Number(trial) } : {}),
    ...(finding ? { finding: Number(finding) } : {}),
  };
}

export function formatAddress(address: Address): string {
  const variant = address.variant ? `${address.variant}:` : "";
  const trial = address.trial === undefined ? "" : `/${address.trial}`;
  const finding = address.finding === undefined ? "" : `#${address.finding}`;
  return `${variant}${address.case}${trial}${finding}`;
}

/** An address's printer for one document: with the variant only where the document covers several. */
export function addresser(several: boolean) {
  return (variant: string, rest: Omit<Address, "variant">) =>
    formatAddress(several ? { variant, ...rest } : rest);
}
