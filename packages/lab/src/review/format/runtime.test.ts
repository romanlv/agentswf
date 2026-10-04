import { describe, expect, test } from "bun:test";
import { runtimeName, runtimeOf } from "./runtime";

describe("runtimeOf", () => {
  test("reads a harness and model, and an effort after the last colon", () => {
    expect(runtimeOf("codex/gpt-6.1-sol")).toEqual({
      harness: "codex",
      model: "gpt-6.1-sol",
      placement: "headless",
    });
    expect(runtimeOf("codex/gpt-6.1-sol:high")).toEqual({
      harness: "codex",
      model: "gpt-6.1-sol",
      effort: "high",
      placement: "headless",
    });
    expect(runtimeOf("claude/claude-sonnet-5-5:max")).toEqual({
      harness: "claude",
      model: "claude-sonnet-5-5",
      effort: "max",
      placement: "headless",
      metered: true,
    });
  });

  test("a suffix that names no level stays part of the model, a slash in it too", () => {
    expect(runtimeOf("pi/openrouter/some-model:free")).toMatchObject({
      harness: "pi",
      model: "openrouter/some-model:free",
    });
    expect(runtimeOf("pi/openrouter/some-model:free:low")).toMatchObject({
      model: "openrouter/some-model:free",
      effort: "low",
    });
  });

  test("refuses what names no harness or no model", () => {
    expect(() => runtimeOf("gpt-6.1-sol")).toThrow("expected harness/model");
    expect(() => runtimeOf("codex/:high")).toThrow("expected harness/model");
  });

  test("runtimeName prints back what runtimeOf reads, and an effortless runtime as it always was", () => {
    for (const spec of ["codex/gpt-6.1-sol", "codex/gpt-6.1-sol:high", "pi/a/b:free:low"]) {
      expect(runtimeName(runtimeOf(spec))).toBe(spec);
    }
  });
});
