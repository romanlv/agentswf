import { describe, expect, test } from "bun:test";
import { descriptionAt, stripMarkedBlocks, textBeforeDiff, titleAt } from "./description";

const BOT_BLOCK =
  "<!-- CURSOR_SUMMARY -->\n---\n> [!NOTE]\n> Medium risk\n<!-- /CURSOR_SUMMARY -->";

describe("descriptionAt", () => {
  const current = { text: "final text", updatedAt: "2026-01-09T00:00:00Z" };
  const versions = [
    { createdAt: "2026-01-02T00:00:00Z", author: "bot", description: "second", diff: null },
    {
      createdAt: "2026-01-01T00:00:00Z",
      author: "bot",
      description: "first edit",
      diff: '<span class="idiff">Fix &lt;it&gt;</span><span class="idiff addition">↵\nmore</span>',
    },
  ];

  test("takes the last edit at or before the time", () => {
    expect(descriptionAt("2026-01-01T12:00:00Z", current, versions)).toEqual({
      text: "first edit",
      asOf: "2026-01-01T12:00:00Z",
    });
  });

  test("rebuilds the text from before the first edit out of that edit's diff", () => {
    expect(descriptionAt("2025-12-31T00:00:00Z", current, versions).text).toBe("Fix <it>");
  });

  test("a description never edited is the current one", () => {
    expect(descriptionAt("2026-01-01T00:00:00Z", current, []).text).toBe("final text");
  });

  test("says when it had to fall back to the latest text", () => {
    const noDiff = [{ ...versions[1]!, diff: null }];
    expect(descriptionAt("2025-12-31T00:00:00Z", current, noDiff).asOf).toBe(current.updatedAt);
  });
});

describe("textBeforeDiff", () => {
  test("keeps unchanged and deleted runs, drops additions, and undoes GitLab's markup", () => {
    const diff =
      '<span class="idiff">a &amp; b↵\n</span><span class="idiff deletion">gone</span><span class="idiff addition">new</span>';
    expect(textBeforeDiff(diff)).toBe("a & b\ngone");
  });
});

describe("titleAt", () => {
  const notes = [
    {
      created_at: "2026-01-03T00:00:00Z",
      body: "changed title from **Fix{- it-}** to **Fix{+ all+}**",
    },
    {
      created_at: "2026-01-02T00:00:00Z",
      body: "changed title from **{-Draft: -}Fix it** to **Fix it**",
    },
    { created_at: "2026-01-02T01:00:00Z", body: "requested review from @someone" },
  ];

  test("reads GitLab's HTML rename notes", () => {
    const html = [
      {
        created_at: "2026-01-03T00:00:00Z",
        body: '<p>changed title from <code class="idiff">fix(api): <span class="idiff left right deletion">accept &amp; keep</span> (T-1)</code> to <code class="idiff">fix(api): <span class="idiff left right addition">stop failing</span> (T-1)</code></p>',
      },
    ];
    expect(titleAt("2026-01-01T00:00:00Z", "fix(api): stop failing (T-1)", html)).toBe(
      "fix(api): accept & keep (T-1)",
    );
  });

  test("undoes every rename after the time", () => {
    expect(titleAt("2026-01-01T00:00:00Z", "Fix all", notes)).toBe("Draft: Fix it");
    expect(titleAt("2026-01-02T12:00:00Z", "Fix all", notes)).toBe("Fix it");
    expect(titleAt("2026-01-04T00:00:00Z", "Fix all", notes)).toBe("Fix all");
  });
});

describe("stripMarkedBlocks", () => {
  test("removes blocks bots mark with HTML comments, and records them", () => {
    const rabbit =
      "<!-- This is an auto-generated comment: release notes by coderabbit.ai -->\nnotes\n<!-- end of auto-generated comment: release notes by coderabbit.ai -->";
    const { text, removed } = stripMarkedBlocks(`Author text.\n\n${BOT_BLOCK}\n\n\n${rabbit}\n`);
    expect(text).toBe("Author text.");
    expect(removed.map((block) => block.by)).toEqual([
      "CURSOR_SUMMARY",
      "release notes by coderabbit.ai",
    ]);
  });

  test("leaves the author's own HTML comments alone", () => {
    expect(stripMarkedBlocks("<!-- todo: screenshots -->\nText").text).toBe(
      "<!-- todo: screenshots -->\nText",
    );
  });
});
