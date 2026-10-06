import { describe, expect, test } from "bun:test";
import { checkPaneOptions, keepsPane } from "./pane-layout";

const pane = { headless: false, sandboxed: false };
const refusal = (spec: { layout?: unknown; keepPane?: unknown }, agent = pane) => {
  try {
    checkPaneOptions("lead", spec, agent);
    return undefined;
  } catch (error) {
    return (error as Error).message;
  }
};

describe("checkPaneOptions", () => {
  test("takes each shape the design gives", () => {
    for (const layout of [
      {},
      { tab: "review" },
      { workspace: "run" },
      { workspace: "origin", tab: "review" },
      { workspace: { name: "review" } },
      { session: "awf-review", workspace: { name: "review" }, tab: "a" },
      { session: "work" },
      { beside: "other", side: "right" },
      { beside: "other", side: "below", share: 0.2 },
      { beside: "other", side: "below", share: 0.8 },
      { beside: "other", side: "right", share: undefined },
    ]) {
      expect(refusal({ layout })).toBeUndefined();
    }
    for (const keepPane of ["never", "on-failure", "always"]) {
      expect(refusal({ keepPane })).toBeUndefined();
    }
  });

  test("refuses what the spec fixes, with the reason", () => {
    expect(refusal({ layout: { beside: "lead", side: "right" } })).toContain("beside itself");
    expect(refusal({ layout: { beside: "a", side: "right", share: 0.9 } })).toContain(
      "share is from 0.2 to 0.8",
    );
    expect(refusal({ layout: { beside: "a", side: "right", share: 0.1 } })).toContain("share");
    expect(refusal({ layout: { beside: "a", side: "right", share: Number.NaN } })).toContain(
      "share",
    );
    expect(refusal({ layout: { beside: "a", side: "left" } })).toContain("side is right or below");
    expect(refusal({ layout: { beside: "a" } })).toContain("side is right or below");
    expect(refusal({ layout: { beside: "", side: "right" } })).toContain("beside names");
    expect(refusal({ layout: { tab: "" } })).toContain("tab is a label");
    expect(refusal({ layout: { tab: "  " } })).toContain("tab is a label");
    expect(refusal({ layout: { workspace: { name: "" } } })).toContain("workspace is");
    expect(refusal({ layout: { workspace: "review" } })).toContain("workspace is");
    expect(refusal({ layout: { session: "Work" } })).toContain("not a session name");
    expect(refusal({ layout: { session: "-x" } })).toContain("not a session name");
    expect(refusal({ layout: { session: "a".repeat(33) } })).toContain("not a session name");
    expect(refusal({ layout: { session: "work", workspace: "origin" } })).toContain(
      "takes no session",
    );
    expect(refusal({ layout: { beside: "a", side: "right", tab: "x" } })).toContain(
      "takes side and share, not tab",
    );
    expect(refusal({ layout: { tab: "x", side: "right" } })).toContain("not side");
    expect(refusal({ layout: { tabs: "x" } })).toContain("not tabs");
    expect(refusal({ layout: "origin" })).toContain("a layout is an object");
    expect(refusal({ keepPane: "failed" })).toContain("keepPane is never, on-failure or always");
  });

  test("refuses either option on an agent with no pane of awf's", () => {
    const headless = { headless: true, sandboxed: false };
    const sandboxed = { headless: false, sandboxed: true };
    expect(refusal({ layout: { tab: "a" } }, headless)).toContain("headless agent has none");
    expect(refusal({ keepPane: "always" }, headless)).toContain("headless agent has none");
    expect(refusal({ keepPane: "never" }, sandboxed)).toContain("in a sandbox");
    expect(refusal({}, headless)).toBeUndefined();
  });
});

describe("keepsPane", () => {
  test("never and absent close; always keeps; on-failure keeps what was not answered", () => {
    expect(keepsPane(undefined, "failed")).toBe(false);
    expect(keepsPane("never", "failed")).toBe(false);
    expect(keepsPane("always", "answered")).toBe(true);
    expect(keepsPane("on-failure", "answered")).toBe(false);
    for (const kind of ["unanswered", "blocked", "timed-out", "failed", "cancelled"] as const) {
      expect(keepsPane("on-failure", kind)).toBe(true);
    }
    expect(keepsPane("on-failure", undefined)).toBe(false);
  });
});
