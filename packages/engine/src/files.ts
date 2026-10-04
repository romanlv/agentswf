import { randomBytes } from "node:crypto";
import { link, lstat, open, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * Writes `value` to `path` whole: a temp file beside it, synced, then renamed into place. A crash
 * leaves the old file or the new one, never half of either.
 */
export async function writeJson(path: string, value: unknown): Promise<void> {
  await writeWhole(path, jsonText(value));
}

/** As `writeJson`, for text. */
export async function writeWhole(path: string, text: string): Promise<void> {
  const temporary = temporaryBeside(path);
  try {
    await writeSynced(temporary, text);
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

/**
 * Links a complete file holding `value` to `path`, which fails when `path` exists: the first to
 * link holds it. False when it was taken.
 */
export async function linkNew(path: string, value: unknown): Promise<boolean> {
  const temporary = temporaryBeside(path);
  try {
    await writeSynced(temporary, jsonText(value));
    await link(temporary, path);
    return true;
  } catch (error) {
    if (isCode(error, "EEXIST")) return false;
    throw error;
  } finally {
    // The linked inode remains; one left behind is a private temp file a sweep removes.
    await unlink(temporary).catch(() => undefined);
  }
}

/** Creates `path`, which must not exist, holding `text`, synced. */
export async function writeSynced(path: string, text: string): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(text);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Whether `path` names anything, a dangling link included. */
export async function exists(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    () => false,
  );
}

/** Whether `error` is a system error with one of `codes`, such as `ENOENT`. */
export function isCode(error: unknown, ...codes: string[]): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    codes.includes(String((error as { code: unknown }).code))
  );
}

function jsonText(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function temporaryBeside(path: string): string {
  return join(dirname(path), `.tmp-${randomBytes(6).toString("hex")}`);
}
