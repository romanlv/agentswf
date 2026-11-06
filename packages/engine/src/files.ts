import { randomBytes } from "node:crypto";
import { realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { link, lstat, open, rename, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

/** `path` with its symlinks resolved, or only made absolute when it doesn't exist. */
export function realPath(path: string): string {
  try {
    return realpathSync(resolve(path));
  } catch {
    return resolve(path);
  }
}

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
 * `text` at `path` whole, synchronously, for a writer that must not wait between two steps: a temp
 * file renamed into place, mode `0600`. Not synced: it needs only to exist and be whole.
 */
export function writeWholeSync(path: string, text: string): void {
  const temporary = temporaryBeside(path);
  try {
    writeFileSync(temporary, text, { mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // Never made, or gone already.
    }
    throw error;
  }
}

/**
 * Links a complete file holding `value` to `path`, which fails when `path` exists: the first to
 * link holds it. False when it was taken.
 */
export function linkNew(path: string, value: unknown): Promise<boolean> {
  return linkNewText(path, jsonText(value));
}

/** As `linkNew`, for text. */
export async function linkNewText(path: string, text: string): Promise<boolean> {
  const temporary = temporaryBeside(path);
  try {
    await writeSynced(temporary, text);
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
async function writeSynced(path: string, text: string): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(text);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Makes the entries of folder `dir`, a rename or link into it, durable. */
export async function syncDir(dir: string): Promise<void> {
  const handle = await open(dir, "r");
  try {
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
