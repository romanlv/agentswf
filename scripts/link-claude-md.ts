/**
 * `CLAUDE.md` -> `AGENTS.md`, one symlink per directory that has an `AGENTS.md`.
 *
 * The repository writes agent instructions once, as `AGENTS.md` (`docs/foundation.md` §6). Claude
 * Code reads `CLAUDE.md`. A symlink is what keeps that one file rather than two that drift.
 *
 * Idempotent: an existing `CLAUDE.md` is never replaced, whatever it is.
 */

import { lstat, readlink, symlink } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { Glob } from "bun";

const ROOT = join(import.meta.dir, "..");

async function lstatOrNull(path: string) {
  try {
    return await lstat(path);
  } catch {
    return null;
  }
}

let linked = 0;
let skipped = 0;

const sources = new Glob("**/AGENTS.md").scan({ cwd: ROOT, followSymlinks: false });

for await (const source of sources) {
  if (source.split("/").includes("node_modules")) continue;

  const dir = join(ROOT, dirname(source));
  const target = join(dir, "CLAUDE.md");
  const existing = await lstatOrNull(target);

  if (existing) {
    const where = existing.isSymbolicLink() ? ` -> ${await readlink(target)}` : "";
    console.log(`skip  ${relative(ROOT, target) || "CLAUDE.md"}${where} (exists)`);
    skipped += 1;
    continue;
  }

  await symlink("AGENTS.md", target);
  console.log(`link  ${relative(ROOT, target)} -> AGENTS.md`);
  linked += 1;
}

console.log(`\n${linked} linked, ${skipped} left alone.`);
