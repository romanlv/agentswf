import { describe, expect, test } from "bun:test";
import { checkPaneOptions, keepsPane, paneAsked, parseWorkspace, storedPane } from "./pane-layout";

const pane = { headless: false, sandboxed: false };
const refusal = (given: unknown, agent = pane) => {
  try {
    checkPaneOptions("lead", { pane: given }, agent);
    return undefined;
  } catch (error) {
    return (error as Error).message;
  }
};

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

describe("pane", () => {
  test("takes a tab or a neighbour, and front", () => {
    for (const given of [
      undefined,
      {},
      { tab: "review" },
      { front: true },
      { tab: "review", front: false },
      { beside: "other", side: "right", front: true },
      { beside: "other", side: "below", share: 0.2 },
      { beside: "other", side: "below", share: 0.8 },
      { beside: "other", side: "right", share: undefined },
    ]) {
      expect(refusal(given)).toBeUndefined();
    }
  });

  test("refuses the operator's choices and a malformed value, with the reason", () => {
    expect(refusal({ workspace: "origin" })).toContain(
      "not workspace: the workspace is the operator's, awf run --workspace",
    );
    expect(refusal({ session: "work" })).toContain("not session");
    expect(refusal({ front: "yes" })).toContain("front is true or false");
    expect(refusal({ beside: "lead", side: "right" })).toContain("beside itself");
    expect(refusal({ beside: "a", side: "right", share: 0.9 })).toContain(
      "share is from 0.2 to 0.8",
    );
    expect(refusal({ beside: "a", side: "right", share: Number.NaN })).toContain("share");
    expect(refusal({ beside: "a", side: "left" })).toContain("side is right or below");
    expect(refusal({ beside: "", side: "right" })).toContain("beside names");
    expect(refusal({ beside: "a", side: "right", tab: "x" })).toContain("not tab");
    expect(refusal({ tab: "x", side: "right" })).toContain("not side");
    expect(refusal({ tab: "" })).toContain("tab is a label");
    expect(refusal({ tab: "  " })).toContain("tab is a label");
    expect(refusal("review")).toContain("a pane is an object");
  });

  test("is refused on an agent with no pane of awf's", () => {
    expect(refusal({ tab: "a" }, { headless: true, sandboxed: false })).toContain(
      "pane places a pane, and a headless agent has none",
    );
    expect(refusal({ tab: "a" }, { headless: false, sandboxed: true })).toContain(
      "pane is not yet for an agent in a sandbox",
    );
    expect(refusal(undefined, { headless: true, sandboxed: false })).toBeUndefined();
  });

  test("layout and keepPane, removed, are refused naming what replaced them", () => {
    const removed = (spec: object) => {
      try {
        checkPaneOptions("lead", spec, pane);
      } catch (error) {
        return (error as Error).message;
      }
    };
    expect(removed({ layout: { tab: "a" } })).toContain("give pane: { tab }");
    expect(removed({ keepPane: "always" })).toContain("awf run --keep-panes");
  });

  test("is kept without what is absent, front: false included", () => {
    expect(storedPane({ tab: "a", front: false })).toEqual({ tab: "a" });
    expect(storedPane({ beside: "a", side: "right", share: undefined })).toEqual({
      beside: "a",
      side: "right",
    });
  });
});

describe("paneAsked", () => {
  const named = { name: "review" };
  test("the workflow's tab and front, in the operator's workspace, kept as the operator says", () => {
    expect(paneAsked({ tab: "t", front: true }, undefined, true)).toEqual({
      layout: { tab: "t" },
      front: true,
    });
    expect(paneAsked({ tab: "t" }, { workspace: named, keep: "on-failure" }, true)).toEqual({
      layout: { workspace: named, tab: "t" },
      keepPane: "on-failure",
    });
    expect(paneAsked(undefined, { workspace: "origin" }, true)).toEqual({
      layout: { workspace: "origin" },
    });
    expect(paneAsked(undefined, { keep: "always" }, true)).toEqual({ keepPane: "always" });
    expect(paneAsked(undefined, undefined, true)).toEqual({});
  });

  test("a neighbour goes beside its target; with no target pane, to the operator's workspace", () => {
    expect(
      paneAsked(
        { beside: "lead", side: "below", share: 0.3, front: true },
        { workspace: named },
        true,
      ),
    ).toEqual({
      layout: { beside: "lead", side: "below", share: 0.3 },
      front: true,
      fallbackWorkspace: named,
    });
    expect(paneAsked({ beside: "lead", side: "right" }, undefined, true)).toEqual({
      layout: { beside: "lead", side: "right" },
    });
  });

  test("an agent with no pane of awf's is asked nothing", () => {
    expect(paneAsked({ tab: "t" }, { workspace: "origin", keep: "always" }, false)).toEqual({});
  });

  test("--workspace: run and origin are keywords, any other word a workspace's name", () => {
    expect(parseWorkspace("run")).toBe("run");
    expect(parseWorkspace("origin")).toBe("origin");
    expect(parseWorkspace("review")).toEqual({ name: "review" });
  });
});
