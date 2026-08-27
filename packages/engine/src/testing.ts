import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function tempRunDir(): string {
  return mkdtempSync(join(tmpdir(), "wf-"));
}

export { COUNT_SCHEMA } from "@wf/contract/testing";
