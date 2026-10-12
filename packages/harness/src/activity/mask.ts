/**
 * Values shaped like credentials, best effort: tool arguments come from command lines, which can
 * hold tokens. The real protection is that only a short cut of an argument is shown.
 */
const CREDENTIALS: readonly [RegExp, string][] = [
  [
    /((?:proxy-)?authorization|x-api-key|api[_-]key|private-token|x-auth[\w-]{0,40}|x-[\w-]{0,40}?(?:token|key|secret))(\s*[:=]\s*)(?:(?:bearer|basic|token)\s+)?[^\s'"]+/gi,
    "$1$2***",
  ],
  [/(\b(?:set-)?cookie\s*:\s*)[^'"\n]+/gi, "$1***"],
  [/\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer ***"],
  // An environment variable's name, as it is written: upper case.
  [
    /\b([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|_PWD|_PASS)[A-Z0-9_]*\s*=\s*)("[^"]*"|'[^']*'|[^\s'"]+)/g,
    "$1***",
  ],
  // In lower case, only names that are credentials whole: `max_tokens=` is not one.
  [
    /((?:^|[\s;&|'"/:?])[\w.-]*?(?:password|passwd|secret|secret[_-]?key|api[_-]?key|access[_-]?key|auth[_-]?token|_token|token)\s*=\s*)("[^"]*"|'[^']*'|[^\s'"]+)/gi,
    "$1***",
  ],
  [
    /(--(?:password|passwd|pass|token|secret|api-key|apikey|auth-token|access-token|client-secret|passphrase|secret-key|secret-access-key)(?:=|\s+))("[^"]*"|'[^']*'|[^\s'"]+)/gi,
    "$1***",
  ],
  // A setting named for a credential, given as the next word.
  [
    /(\bconfig(?:ure)?[ \t]+set\b[^|;&\n]{0,200}?[ \t]\S{0,100}?(?:password|passwd|secret|token|key)\S{0,100}[ \t]+)("[^"]*"|'[^']*'|\S+)/gi,
    "$1***",
  ],
  [/(\b(?:login|sshpass)\b[^|;&\n]{0,200}?\s-p\s*)("[^"]*"|'[^']*'|[^\s'"-][^\s'"]*)/g, "$1***"],
  [/(\bmysql\w*\b[^|;&\n]{0,200}?\s-p)(\s*)([^\s'"-][^\s'"]*)/g, "$1$2***"],
  [/(\bredis-cli\b[^|;&\n]{0,200}?\s-a\s+)(\S+)/g, "$1***"],
  [/(\bopenssl\b[^|;&\n]{0,200}?\s-(?:k|pass|passin|passout)\s+)(\S+)/g, "$1***"],
  [/(["']?(?:api[_-]?key|token|secret|password)["']?\s*:\s*)("[^"]*"|'[^']*')/gi, '$1"***"'],
  [/(:\/\/)[^\s/:@]+:[^\s/@]+@/g, "$1***@"],
  [/(\s(?:-u|-U|--user|--proxy-user)(?:\s+|=))[^\s:]+:\S+/g, "$1***"],
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

/**
 * About `limit` characters of one line, with `…` where it was cut, masked. Only its start is
 * masked, and before its lines are joined, so a rule never reads on into the next command.
 */
export function cut(text: string, limit = 120): string {
  const line = maskCredentials(text.slice(0, limit * 8))
    .replace(/\s+/g, " ")
    .trim();
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
}
