import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * The project's `.env`, the nearest from `cwd` up to its repository's root, into `environment`
 * where a name is not already set: what the shell exports wins, as with dotenv. A run's tokens and
 * keys come from the project it runs in. Returns the file read, if any.
 */
export function loadProjectEnv(
  cwd: string,
  environment: Record<string, string | undefined> = process.env,
): string | undefined {
  for (let dir = cwd; ; dir = dirname(dir)) {
    const file = join(dir, ".env");
    if (existsSync(file)) {
      for (const [name, value] of envEntries(readFileSync(file, "utf8")))
        environment[name] ??= value;
      return file;
    }
    if (existsSync(join(dir, ".git")) || dirname(dir) === dir) return undefined;
  }
}

/** `NAME=value` lines; `export ` and one pair of matching quotes dropped, `#` lines skipped. */
export function envEntries(text: string): [string, string][] {
  const entries: [string, string][] = [];
  for (const line of text.split("\n")) {
    const found = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (found) entries.push([found[1]!, found[2]!.replace(/^(["'])(.*)\1$/, "$2")]);
  }
  return entries;
}
