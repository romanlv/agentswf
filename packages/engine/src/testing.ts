import { onTestFinished } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function createTempRunDirs(): {
  tempRunDir(): string;
  cleanup(): void;
} {
  const paths = new Set<string>();
  return {
    tempRunDir() {
      const path = mkdtempSync(join(tmpdir(), "wf-"));
      paths.add(path);
      return path;
    },
    cleanup() {
      for (const path of paths) rmSync(path, { recursive: true, force: true });
      paths.clear();
    },
  };
}

/** Compatibility helper for frozen tests; current suites should own a tracker per file. */
export function tempRunDir(): string {
  const path = mkdtempSync(join(tmpdir(), "wf-"));
  onTestFinished(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

export { COUNT_SCHEMA } from "@wf/contract/testing";
