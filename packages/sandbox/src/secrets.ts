import { constants } from "node:fs";
import { lstat, mkdir, open, rm } from "node:fs/promises";
import { join } from "node:path";
import type { SandboxContext } from "./seam";

/** `value` as one word to a POSIX shell, whatever it holds. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** `values` as lines a shell sources with `set -a`, each name checked as a variable's. */
export function secretsText(values: Readonly<Record<string, string>>): string {
  return Object.entries(values)
    .map(([key, value]) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        throw new Error(`not an environment variable name: ${key}`);
      }
      return `${key}=${shellQuote(value)}\n`;
    })
    .join("");
}

/**
 * Where a sandbox's pane shells find their secrets: beside the sandbox's directory, not in it,
 * as every agent in the sandbox reads that directory, and inside the run root, which each of them
 * is denied.
 */
export function secretsDirectory(context: SandboxContext): string {
  return `${context.directory}.secrets`;
}

/**
 * Writes `values` as a file a shell sources and then deletes, so no token is on a command line
 * (H5). The file is new, by its own name, and the operator's alone: nothing an agent planted is
 * followed or reused.
 */
export async function writeSecrets(
  context: SandboxContext,
  name: string,
  values: Readonly<Record<string, string>>,
): Promise<string> {
  const directory = secretsDirectory(context);
  await mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  const found = await lstat(directory);
  if (!found.isDirectory() || (found.mode & 0o077) !== 0) {
    throw new Error(`${directory} is not a private directory`);
  }
  const path = join(directory, name);
  const handle = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(secretsText(values));
  } finally {
    await handle.close();
  }
  return path;
}

/** Forgets every secret a sandbox's panes did not read. */
export async function removeSecrets(context: SandboxContext): Promise<void> {
  await rm(secretsDirectory(context), { recursive: true, force: true });
}
