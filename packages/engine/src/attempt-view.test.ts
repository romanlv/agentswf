import { describe, expect, test } from "bun:test";
import { paneRows } from "./attempt-view";

describe("the closing block's pane rows", () => {
  test("each fallback and kept pane once, with where to find a kept one; the rest unsaid", () => {
    expect(
      paneRows(
        [
          {
            callPath: [],
            agent: "plain",
            placed: { session: "awf", workspace: "run", tab: "plain" },
          },
          {
            callPath: [],
            agent: "security",
            layout: { beside: "lead", side: "right" },
            placed: {
              session: "awf",
              workspace: "run",
              tab: "security",
              fallback: "lead is headless",
            },
          },
          {
            callPath: [],
            agent: "lead",
            keepPane: "always",
            placed: { session: "default", workspace: "origin", tab: "review · r1", kept: true },
          },
          {
            callPath: [],
            agent: "style",
            keepPane: "on-failure",
            placed: {
              session: "awf-review",
              workspace: { name: "review" },
              beside: "lead",
              kept: true,
            },
          },
          {
            callPath: [],
            agent: "mine",
            keepPane: "always",
            placed: { session: "work", workspace: "run", tab: "mine", kept: true },
          },
          {
            callPath: [],
            agent: "stuck",
            keepPane: "always",
            placed: {
              session: "awf",
              workspace: "run",
              tab: "stuck",
              notKept: "its harness did not settle after an interrupt",
            },
          },
        ],
        "awf review r1 #1",
      ),
    ).toEqual([
      ["pane", "security in a tab of its own: lead is headless"],
      ["kept", 'lead · tab "review · r1", where awf run was typed'],
      ["kept", 'style · beside lead in workspace "review" · herdr session attach awf-review'],
      ["kept", 'mine · tab "mine" in workspace "awf review r1 #1" of herdr session work'],
      ["pane", "stuck closed, not kept: its harness did not settle after an interrupt"],
    ]);
  });
});
