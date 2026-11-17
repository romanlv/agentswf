import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TRIAL_ENV } from "../format/trial-env";
import { writeGradeFolder } from "../lab/workflow-graders";
import { gradeCase } from "./grade-case";

const was = process.env[TRIAL_ENV.grade];
afterEach(() => {
  if (was === undefined) delete process.env[TRIAL_ENV.grade];
  else process.env[TRIAL_ENV.grade] = was;
});

test("gradeCase() outside the lab says how a grader is run", () => {
  delete process.env[TRIAL_ENV.grade];
  expect(() => gradeCase()).toThrow("run this grader through awf-lab run or score");
});

test("gradeCase() reads back what the lab wrote, facts only for a grader that reads them", () => {
  const root = mkdtempSync(join(tmpdir(), "grade-case-"));
  try {
    const call = {
      case: {
        name: "one",
        dir: join(root, "nowhere"),
        input: {},
        key: { kind: "awf.case-key/0" as const },
      },
      facts: { ok: true },
      stages: { read: 1 },
      result: { done: true },
      scratch: null,
      kept: join(root, "no-kept"),
      work: root,
      env: {},
      params: { model: "haiku" },
      previous: { key: "a".repeat(64), parts: [{ about: "finding 0", label: "hit" }] },
    };
    mkdirSync(call.case.dir);
    writeFileSync(join(call.case.dir, "input.json"), '{"today":"2026-11-17"}');
    for (const readsFacts of [true, false]) {
      const dir = join(root, `grade-${readsFacts}`);
      writeGradeFolder(dir, call, readsFacts);
      process.env[TRIAL_ENV.grade] = dir;
      const read = gradeCase();
      expect(read.case).toMatchObject({
        name: "one",
        input: { today: "2026-11-17" },
        key: call.case.key,
      });
      expect(read.case.keyDir).toBeUndefined();
      expect(read.result).toEqual({ done: true });
      expect(read.scratch).toBeNull();
      expect(read.params).toEqual({ model: "haiku" });
      expect(read.previous).toEqual(call.previous);
      expect(read.facts).toEqual(readsFacts ? { ok: true } : undefined);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
