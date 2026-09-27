import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Refused: past these, a skill is not instructions and a few scripts. */
export const MAX_BYTES = 10 * 1024 * 1024;
export const MAX_FILES = 2_000;

/**
 * A skill's files, copied: never a link, which could carry what it points at, `~/.ssh` say, into
 * a sandbox, nor anything but files and directories, and within the size caps.
 */
export async function copySkillTree(from: string, to: string): Promise<void> {
  const budget = { bytes: 0, files: 0 };
  await mkdir(to, { recursive: true, mode: 0o755 });
  const walk = async (at: string) => {
    for (const entry of await readdir(join(from, at))) {
      const path = join(at, entry);
      const found = await lstat(join(from, path));
      if (found.isSymbolicLink()) throw new Error(`skill ${from}: ${path} is a link`);
      if (found.isDirectory()) {
        await mkdir(join(to, path), { mode: 0o755 });
        await walk(path);
        continue;
      }
      if (!found.isFile()) throw new Error(`skill ${from}: ${path} is not a file`);
      budget.bytes += found.size;
      budget.files += 1;
      if (budget.bytes > MAX_BYTES || budget.files > MAX_FILES) {
        throw new Error(`skill ${from} is over ${MAX_FILES} files or ${MAX_BYTES} bytes`);
      }
      await writeFile(join(to, path), await readFile(join(from, path)), {
        mode: found.mode & 0o111 ? 0o755 : 0o644,
      });
    }
  };
  await walk("");
}

/** Over each file's path, executable bit and bytes, sorted: equal digests, equal skills. */
export async function digestTree(root: string): Promise<string> {
  const lines: string[] = [];
  const walk = async (at: string) => {
    for (const entry of await readdir(join(root, at))) {
      const path = join(at, entry);
      const found = await lstat(join(root, path));
      if (found.isDirectory()) {
        await walk(path);
        continue;
      }
      const bytes = await readFile(join(root, path));
      const hash = createHash("sha256").update(bytes).digest("hex");
      lines.push(`${path}\0${found.mode & 0o111 ? "x" : "-"}\0${hash}\n`);
    }
  };
  await walk("");
  const digest = createHash("sha256");
  for (const line of lines.sort()) digest.update(line);
  return `sha256:${digest.digest("hex")}`;
}
