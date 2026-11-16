import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CaseInfo } from "./dataset";
import { buildCase, keepFiles, searchFolder } from "./folders";

const top = realpathSync(mkdtempSync(join(tmpdir(), "awf-lab-folders-")));
afterAll(() => rmSync(top, { recursive: true, force: true }));

const MARKER = "harbor-violet-pepper-anvil";
let count = 0;
function folder(): string {
  const dir = join(top, String(++count));
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("symlinks", () => {
  test("buildCase refuses a case file that is a symlink, as to the case's own key", () => {
    const dir = folder();
    const caseDir = join(dir, "ds/cases/c1");
    mkdirSync(join(caseDir, "files"), { recursive: true });
    writeFileSync(join(caseDir, "key.md"), `marker: ${MARKER}`);
    symlinkSync(join(caseDir, "key.md"), join(caseDir, "files/notes.md"));
    const info = { name: "c1", dir: caseDir } as CaseInfo;
    expect(() => buildCase(join(dir, "ds"), info, join(dir, "target"))).toThrow("a symlink");
    expect(existsSync(join(dir, "target/notes.md"))).toBe(false);
  });

  test("the marker search reads through a file symlink, and a folder link that loops ends", () => {
    const dir = folder();
    const key = join(dir, "key.md");
    writeFileSync(key, `marker: ${MARKER}`);
    const scratch = join(dir, "scratch");
    mkdirSync(join(scratch, "sub"), { recursive: true });
    symlinkSync(key, join(scratch, "notes.md"));
    symlinkSync(scratch, join(scratch, "sub/loop"));
    const found = searchFolder(scratch, { marker: MARKER, keyFiles: [] }, "scratch");
    expect(found).toContain("the marker in scratch/notes.md");
  });

  test("keep copies a symlink's file, and never a path outside the scratch folder", () => {
    const dir = folder();
    const scratch = join(dir, "scratch");
    mkdirSync(scratch);
    writeFileSync(join(dir, "outside.txt"), "outside");
    writeFileSync(join(dir, "target.txt"), "the file itself");
    symlinkSync(join(dir, "target.txt"), join(scratch, "report.md"));
    const target = join(dir, "kept");
    const kept = keepFiles(scratch, ["*.md", "../outside.txt"], target);
    expect(kept).toEqual(["report.md"]);
    expect(lstatSync(join(target, "report.md")).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(target, "report.md"), "utf8")).toBe("the file itself");
  });
});
