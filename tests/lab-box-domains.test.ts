import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MODEL_DOMAINS } from "../packages/lab/src/cases/lab/box";

// The lab imports contract only, so its box keeps its own copy of each harness's model domains.
// This fails when harness's table names a domain the lab's lacks, or the lab names one it doesn't.
test("the lab box's model domains are harness's", () => {
  const source = readFileSync(
    join(import.meta.dir, "../packages/harness/src/sandbox-needs.ts"),
    "utf8",
  );
  const theirs = new Set(
    [...source.matchAll(/"((?:\*\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+)"/g)]
      .map((m) => m[1]!)
      .filter((d) => /\.(com|sh|ai|dev)$/.test(d) && !d.includes("example")),
  );
  const ours = new Set(Object.values(MODEL_DOMAINS).flat());
  expect([...theirs].filter((d) => !ours.has(d))).toEqual([]);
  expect([...ours].filter((d) => !theirs.has(d))).toEqual([]);
});
