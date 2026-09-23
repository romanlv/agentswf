/**
 * Whether a repository-relative path matches any of the globs. `**` spans directories, `*` and `?`
 * stay within one path segment.
 */
export function matchesAny(path: string, globs: readonly string[]): boolean {
  return globs.some((glob) => globToRegExp(glob).test(path));
}

function globToRegExp(glob: string): RegExp {
  let pattern = "";
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index]!;
    if (glob.startsWith("**/", index)) {
      pattern += "(?:.*/)?";
      index += 2;
    } else if (glob.startsWith("**", index)) {
      pattern += ".*";
      index += 1;
    } else if (char === "*") {
      pattern += "[^/]*";
    } else if (char === "?") {
      pattern += "[^/]";
    } else {
      pattern += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${pattern}$`);
}
