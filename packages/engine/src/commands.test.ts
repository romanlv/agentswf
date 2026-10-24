import { describe, expect, test } from "bun:test";
import { suggest, usageLines } from "./commands";

describe("suggest", () => {
  test("names every command the word starts, before any near one", () => {
    expect(suggest("ru")).toEqual(["run", "runs"]);
    expect(suggest("all")).toEqual(["allowance"]);
  });

  test("else the closest within two edits, every one tied", () => {
    expect(suggest("inbx")).toEqual(["inbox"]);
    expect(suggest("runx")).toEqual(["run", "runs"]);
    expect(suggest("Logs")).toEqual(["logs"]);
    expect(suggest("lgos")).toEqual(["logs"]);
  });

  test("names none past two edits, or for no word", () => {
    expect(suggest("zzzz")).toEqual([]);
    expect(suggest("")).toEqual([]);
  });
});

test("a command's usage lines end at its first blank line", () => {
  expect(usageLines("usage: a\n       b\n\nprose\n\nmore")).toEqual(["usage: a", "       b"]);
  expect(usageLines("usage: a")).toEqual(["usage: a"]);
});
