import { describe, expect, test } from "bun:test";
import { choice, score, yesNo } from "./decisions";

describe("question builders", () => {
  test("build the question each names", () => {
    expect(choice("Which team?", { payments: "Checkout", frontend: null })).toEqual({
      type: "choice",
      instructions: "Which team?",
      options: { payments: "Checkout", frontend: null },
    });
    expect(score("How urgent?", ["later", "now"])).toEqual({
      type: "score",
      instructions: "How urgent?",
      levels: ["later", "now"],
    });
    expect(yesNo("Broken?")).toEqual({ type: "yes-no", instructions: "Broken?" });
    expect(yesNo("Broken?", { yes: "it errors", no: "it works" }).criteria).toEqual({
      yes: "it errors",
      no: "it works",
    });
  });

  test("reject a question with nothing to pick, where it is written", () => {
    expect(() => choice("Which?", {})).toThrow("at least one option");
    expect(() => score("How much?", [])).toThrow("at least one level");
    expect(() => yesNo("  ")).toThrow("needs instructions");
  });
});
