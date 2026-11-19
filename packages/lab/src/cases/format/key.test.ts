import { describe, expect, test } from "bun:test";
import { criteriaOf, parseKey } from "./key";

const key = (front: string, note = "Why.") =>
  `---\nkind: awf.case-key/0\nmarker: lantern-copper-walrus\n${front}---\n\n${note}\n`;

describe("parseKey", () => {
  test("reads expect, criteria and the note", () => {
    const read = parseKey(
      key(
        'expect:\n  relevant: true\n  children: "Daniel"\n  reply: null\nmust:\n  - a\n  - b\nmust-not:\n  - c\n',
      ),
    );
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.key.expect).toEqual({ relevant: true, children: "Daniel", reply: null });
    expect(read.value.note).toBe("Why.");
    expect(criteriaOf(read.value.key).map((c) => c.name)).toEqual([
      "must 1",
      "must 2",
      "must-not 1",
    ]);
  });

  test("refuses an unquoted string in expect, so no is never read as false", () => {
    const read = parseKey(key("expect:\n  replied: no\n"));
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.problems[0]?.message).toContain('quote "no"');
  });

  test("refuses an unknown field, a reserved fact and a criterion given twice", () => {
    expect(parseKey(key("expects:\n  a: true\n")).ok).toBe(false);
    expect(parseKey(key('expect:\n  error: ""\n')).ok).toBe(false);
    expect(parseKey(key("must:\n  - a\n  - a\n")).ok).toBe(false);
  });

  test("says a schema's problems in words: an unknown field, the kind, a missing marker, a pattern", () => {
    const said = (text: string) => {
      const read = parseKey(text);
      return read.ok ? [] : read.problems.map((p) => p.message);
    };
    expect(said(key("expekt:\n  a: true\n"))).toEqual([
      "unknown field expekt; a key's fields: kind, marker, expect, must, must-not, known-failing, pass, draft, tags, captured",
    ]);
    expect(said("---\nkind: awf.case-key/1\nmarker: lantern-copper-walrus\n---\n")).toEqual([
      "kind must be awf.case-key/0",
    ]);
    expect(said("---\nkind: awf.case-key/0\n---\n")).toEqual([
      "no marker: case new writes one; copy one from another key, or remake the case",
    ]);
    expect(said(key("pass: half\n"))).toEqual([
      'pass is all, or the share of trials that must pass, such as 2/3, not "half"',
    ]);
  });

  test("a YAML error gives its line and column in key.md", () => {
    const read = parseKey(key("expect:\n  a: true\n  a: false\n"));
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.problems[0]?.message).toMatch(/^line 6:3: /);
  });

  test("refuses a key without frontmatter, or with a field given twice", () => {
    expect(parseKey("just a note").ok).toBe(false);
    expect(parseKey(key("pass: all\npass: 2/3\n")).ok).toBe(false);
  });
});
