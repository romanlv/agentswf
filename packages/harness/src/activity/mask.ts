/**
 * Values shaped like credentials, best effort: tool arguments come from command lines, which can
 * hold tokens. The real protection is that only a short cut of an argument is shown.
 */
const CREDENTIALS: readonly [RegExp, string][] = [
  [
    /((?:authorization|x-api-key|api-key)\s*[:=]\s*)(?:(?:bearer|basic|token)\s+)?[^\s'"]+/gi,
    "$1***",
  ],
  [/\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer ***"],
  // An environment variable's name, as it is written: upper case.
  [
    /\b([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)[A-Z0-9_]*\s*=\s*)("[^"]*"|'[^']*'|[^\s'"]+)/g,
    "$1***",
  ],
  [/(["']?(?:api[_-]?key|token|secret|password)["']?\s*:\s*)("[^"]*"|'[^']*')/gi, '$1"***"'],
  [/(:\/\/)[^\s/:@]+:[^\s/@]+@/g, "$1***@"],
  [/(\s-u\s+)[^\s:]+:\S+/g, "$1***"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/g, "***"],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, "***"],
  [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g, "***"],
  [/\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{20,}/g, "***"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, "***"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "***"],
];

export function maskCredentials(text: string): string {
  return CREDENTIALS.reduce((masked, [shape, mask]) => masked.replace(shape, mask), text);
}

/** About `limit` characters of one line, with `…` where it was cut, masked. */
export function cut(text: string, limit = 120): string {
  const line = maskCredentials(text.replace(/\s+/g, " ").trim());
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
}
