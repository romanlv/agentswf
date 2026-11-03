import { describe, expect, test } from "bun:test";
import type { PaneSpec } from "@agentswf/contract/workflow";
import {
  checkPaneOptions,
  keepsPane,
  paneAsked,
  parseWorkspace,
  storedLayout,
} from "./pane-layout";

const pane = { headless: false, sandboxed: false };
const refusal = (spec: { pane?: unknown; layout?: unknown; keepPane?: unknown }, agent = pane) => {
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

describe("pane", () => {
  test("takes a tab or a neighbour, and front", () => {
    for (const pane of [
      {},
      { tab: "review" },
      { front: true },
      { tab: "review", front: false },
      { beside: "other", side: "right", front: true },
      { beside: "other", side: "below", share: 0.4 },
    ]) {
      expect(refusal({ pane })).toBeUndefined();
    }
  });

  test("refuses the operator's choices, layout beside it, and what a layout refuses", () => {
    expect(refusal({ pane: { workspace: "origin" } })).toContain(
      "not workspace: the workspace is the operator's, awf run --workspace",
    );
    expect(refusal({ pane: { session: "work" } })).toContain("not session");
    expect(refusal({ pane: { tab: "a" }, layout: { tab: "b" } })).toContain(
      "give pane, not layout beside it",
    );
    expect(refusal({ pane: { front: "yes" } })).toContain("front is true or false");
    expect(refusal({ pane: { beside: "lead", side: "right" } })).toContain("beside itself");
    expect(refusal({ pane: { beside: "a", side: "right", tab: "x" } })).toContain("not tab");
    expect(refusal({ pane: { tab: "" } })).toContain("tab is a label");
    expect(refusal({ pane: "review" })).toContain("a pane is an object");
    expect(refusal({ pane: { tab: "a" } }, { headless: true, sandboxed: false })).toContain(
      "pane places a pane, and a headless agent has none",
    );
    expect(refusal({ pane: { tab: "a" } }, { headless: false, sandboxed: true })).toContain(
      "pane is not yet for an agent in a sandbox",
    );
  });

  test("is kept without what is absent, front: false included", () => {
    expect(storedLayout<PaneSpec>({ tab: "a", front: false })).toEqual({ tab: "a" });
    expect(storedLayout<PaneSpec>({ beside: "a", side: "right", share: undefined })).toEqual({
      beside: "a",
      side: "right",
    });
  });
});

describe("paneAsked", () => {
  const named = { name: "review" };
  test("the workflow's tab and front, in the operator's workspace, kept as the operator says", () => {
    expect(paneAsked({ pane: { tab: "t", front: true } }, undefined, true)).toEqual({
      layout: { tab: "t" },
      front: true,
    });
    expect(
      paneAsked({ pane: { tab: "t" } }, { workspace: named, keep: "on-failure" }, true),
    ).toEqual({ layout: { workspace: named, tab: "t" }, keepPane: "on-failure" });
    expect(paneAsked({}, { workspace: "origin" }, true)).toEqual({
      layout: { workspace: "origin" },
    });
    expect(paneAsked({}, undefined, true)).toEqual({});
  });

  test("a neighbour goes beside its target; with no target pane, to the operator's workspace", () => {
    expect(
      paneAsked(
        { pane: { beside: "lead", side: "below", share: 0.3, front: true } },
        { workspace: named },
        true,
      ),
    ).toEqual({
      layout: { beside: "lead", side: "below", share: 0.3 },
      front: true,
      fallbackWorkspace: named,
    });
    expect(paneAsked({ pane: { beside: "lead", side: "right" } }, undefined, true)).toEqual({
      layout: { beside: "lead", side: "right" },
    });
  });

  test("the operator's flags win over a deprecated layout and keepPane, which apply without them", () => {
    const layout = { session: "work", workspace: named, tab: "t" };
    expect(paneAsked({ layout, keepPane: "always" }, undefined, true)).toEqual({
      layout,
      keepPane: "always",
    });
    expect(
      paneAsked({ layout, keepPane: "always" }, { workspace: "origin", keep: "never" }, true),
    ).toEqual({ layout: { workspace: "origin", tab: "t" }, keepPane: "never" });
    expect(paneAsked({ keepPane: "on-failure" }, { workspace: "run" }, true)).toEqual({
      layout: { workspace: "run" },
      keepPane: "on-failure",
    });
  });

  test("an agent with no pane of awf's is asked nothing", () => {
    expect(
      paneAsked({ pane: { tab: "t" } }, { workspace: "origin", keep: "always" }, false),
    ).toEqual({});
  });

  test("--workspace: run and origin are keywords, any other word a workspace's name", () => {
    expect(parseWorkspace("run")).toBe("run");
    expect(parseWorkspace("origin")).toBe("origin");
    expect(parseWorkspace("review")).toEqual({ name: "review" });
  });
});
