import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostReasoningEffort } from "./execute";

const dir = mkdtempSync(join(tmpdir(), "awf-effort-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("a contained trial takes codex's top-level reasoning effort, not a profile's", () => {
  expect(hostReasoningEffort(dir)).toBeUndefined();
  writeFileSync(
    join(dir, "config.toml"),
    'model = "gpt-6.1-sol"\nmodel_reasoning_effort = "medium"\n\n[profiles.fast]\nmodel_reasoning_effort = "low"\n',
  );
  expect(hostReasoningEffort(dir)).toBe("medium");
  writeFileSync(join(dir, "config.toml"), '[profiles.fast]\nmodel_reasoning_effort = "low"\n');
  expect(hostReasoningEffort(dir)).toBeUndefined();
});
