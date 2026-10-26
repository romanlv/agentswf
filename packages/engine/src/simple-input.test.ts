import { describe, expect, test } from "bun:test";
import { type JsonSchema, parseJsonSchema } from "@agentswf/contract/schema";
import Type from "typebox";
import { evaluateGiven } from "./result-validation";
import { readFlags, simpleInput, usageLine } from "./simple-input";

const schema = (value: unknown): JsonSchema => parseJsonSchema(JSON.parse(JSON.stringify(value)));
const object = (properties: Record<string, unknown>, required = Object.keys(properties)) =>
  schema({ type: "object", properties, required });

const VERDICT = schema(
  Type.Object({
    verdict: Type.Union([Type.Literal("noise"), Type.Literal("real")]),
    confidence: Type.Integer({ minimum: 1, maximum: 5 }),
    summary: Type.String({ minLength: 1 }),
    note: Type.Optional(Type.String()),
  }),
);

describe("the simple-input rule", () => {
  test("up to 6 properties of the allowed kinds and bounds are simple, and 7 aren't", () => {
    const six = Object.fromEntries(
      ["a", "b", "c", "d", "e", "f"].map((name) => [name, { type: "string" }]),
    );
    expect(simpleInput(object(six))).toHaveLength(6);
    expect(simpleInput(object({ ...six, g: { type: "boolean" } }))).toBeUndefined();
    expect(
      simpleInput(
        object({
          s: { type: "string", minLength: 3, description: "shown nowhere", title: "t" },
          n: { type: "number", maximum: 0.5, default: 0.1 },
          i: { type: "integer", minimum: 1 },
          b: { type: "boolean" },
          e: { type: "string", enum: ["x", "y"] },
          c: { type: "string", const: "only" },
        }),
      ),
    ).toHaveLength(6);
  });

  test("a union of string literals is an enum, and so is a typeless enum of strings", () => {
    expect(simpleInput(VERDICT)?.[0]).toEqual({
      name: "verdict",
      required: true,
      kind: { type: "enum", values: ["noise", "real"] },
    });
    expect(simpleInput(object({ e: { enum: ["a", "b"] } }))?.[0]?.kind).toEqual({
      type: "enum",
      values: ["a", "b"],
    });
    expect(simpleInput(object({ e: { enum: ["a", 1] } }))).toBeUndefined();
    // A value the usage line can't show between |s, or the agent can't type bare, is taught as JSON.
    for (const value of ["needs work", "a|b", "", "it's"])
      expect(simpleInput(object({ e: { enum: ["ok", value] } }))).toBeUndefined();
  });

  test("a nested object, an array, another union, a null, a non-flag name or a non-object isn't", () => {
    for (const property of [
      { type: "object", properties: {} },
      { type: "array", items: { type: "string" } },
      { anyOf: [{ type: "string" }, { type: "number" }] },
      {
        anyOf: [
          { type: "string", const: "a" },
          { type: "number", const: 1 },
        ],
      },
      { type: "null" },
      { type: "number", const: 1 },
      { type: "boolean", const: true },
    ]) {
      expect(simpleInput(object({ p: property }))).toBeUndefined();
    }
    expect(simpleInput(object({ Upper: { type: "string" } }))).toBeUndefined();
    expect(simpleInput(object({ "with-dash": { type: "string" } }))).toBeUndefined();
    expect(simpleInput(schema({ type: "string" }))).toBeUndefined();
    expect(simpleInput(object({}))).toBeUndefined();
    expect(
      simpleInput(
        schema({ type: "object", properties: { a: { type: "string" } }, required: ["a", "b"] }),
      ),
    ).toBeUndefined();
  });
});

describe("the usage line", () => {
  test("shows every property, its enum's values and every bound; an optional one in brackets", () => {
    expect(usageLine(simpleInput(VERDICT)!)).toBe(
      "--verdict noise|real --confidence <integer, 1 to 5> --summary <text, at least 1 character> [--note <text>]",
    );
    expect(
      usageLine(
        simpleInput(
          object({
            a: { type: "integer", minimum: 1 },
            b: { type: "number", maximum: 0.5 },
            c: { type: "string", minLength: 3 },
            d: { type: "boolean" },
            e: { type: "number" },
          }),
        )!,
      ),
    ).toBe(
      "--a <integer, at least 1> --b <number, at most 0.5> --c <text, at least 3 characters> --d true|false --e <number>",
    );
  });
});

describe("reading flags", () => {
  test("--name 'value' and --name=value set the input as JSON would, converted by type", () => {
    const read = readFlags(VERDICT, [
      "--verdict",
      "noise",
      "--confidence=4",
      "--summary",
      "it's $HOME, `cron` and a \\ backslash",
    ]);
    expect(read).toEqual({
      ok: true,
      value: {
        verdict: "noise",
        confidence: 4,
        summary: "it's $HOME, `cron` and a \\ backslash",
      },
    });
    const flags = object({ d: { type: "boolean" }, n: { type: "number" } });
    expect(readFlags(flags, ["--d", "false", "--n", "-0.25"])).toEqual({
      ok: true,
      value: { d: false, n: -0.25 },
    });
  });

  test("the word after a flag is its value, even one starting with --", () => {
    expect(readFlags(VERDICT, ["--summary", "--force was used"])).toEqual({
      ok: true,
      value: { summary: "--force was used" },
    });
  });

  test("a stray word, an unknown or repeated flag, and a value its type can't take are refused with the usage line", () => {
    for (const [args, problem] of [
      [["noise"], '"noise" is not a flag'],
      [["--summary", "split", "words"], '"words" is not a flag'],
      [["--colour", "red"], "--colour is not a flag this takes"],
      [["--summary", "a", "--summary", "b"], "--summary is given twice"],
      [["--confidence", "high"], '--confidence takes <integer, 1 to 5>; got "high"'],
      [["--confidence", "2.5"], "--confidence takes <integer, 1 to 5>"],
      [["--confidence", "9"], "--confidence takes <integer, 1 to 5>"],
      [["--verdict", "maybe"], "--verdict takes noise|real"],
      [["--summary", ""], "--summary takes <text, at least 1 character>"],
      [["--summary"], "--summary needs a value"],
      [["[--note", "x]"], "leave out the brackets around an optional flag"],
    ] as const) {
      const read = readFlags(VERDICT, args);
      expect(read.ok).toBe(false);
      if (read.ok) continue;
      expect(read.error).toContain(problem);
      expect(read.error).toContain("expected: --verdict noise|real --confidence");
      expect(read.error).toContain("Put every value in single quotes");
    }
  });

  test("flags for a schema that isn't simple are refused with the schema", () => {
    const nested = object({ items: { type: "array", items: { type: "string" } } });
    const read = readFlags(nested, ["--items", "a"]);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.error).toContain(JSON.stringify(nested));
  });
});

describe("a result as wf sent it", () => {
  const call = { question: "q", schema: VERDICT };

  test("no input is {}: taken by optional properties, refused by a required one", async () => {
    const optional = { question: "q", schema: object({ note: { type: "string" } }, []) };
    expect(await evaluateGiven(optional, {})).toEqual({ kind: "accepted", value: {} });
    const refused = await evaluateGiven(call, {});
    expect(refused).toMatchObject({ kind: "rejected" });
    if (refused.kind === "rejected") expect(refused.error).toContain("value.verdict: required");
  });

  test("a missing required flag is refused as a missing property is, with the usage line", async () => {
    const refused = await evaluateGiven(call, { args: ["--verdict", "real"] });
    if (refused.kind !== "rejected") throw new Error("accepted");
    expect(refused.error).toContain("value.confidence: required property is missing");
    expect(refused.error).toContain("expected: --verdict noise|real --confidence");
  });

  test("no input to an object that takes JSON only is refused with how to send it", async () => {
    const list = object({ items: { type: "array", items: { type: "string" } } });
    const refused = await evaluateGiven({ question: "q", schema: list }, {});
    if (refused.kind !== "rejected") throw new Error("accepted");
    expect(refused.error).toContain("value.items: required property is missing");
    expect(refused.error).toContain(
      `in a quoted heredoc (<<'WF_JSON' … WF_JSON), matching this schema:\n${JSON.stringify(list)}`,
    );
  });

  test("no input to a text answer is refused with how to send it, not as an object", async () => {
    const refused = await evaluateGiven({ question: "q", schema: schema({ type: "string" }) }, {});
    expect(refused).toEqual({
      kind: "rejected",
      error: expect.stringContaining(
        "nothing was given; send it as JSON on standard input, in a quoted heredoc",
      ),
    });
  });

  test("flags for a schema that isn't simple say how to send JSON", async () => {
    const nested = {
      question: "q",
      schema: object({ items: { type: "array", items: { type: "string" } } }),
    };
    const refused = await evaluateGiven(nested, { args: ['{"items":[]}'] });
    if (refused.kind !== "rejected") throw new Error("accepted");
    expect(refused.error).toContain("in a quoted heredoc (<<'WF_JSON' … WF_JSON)");
  });

  test("JSON on standard input for a simple schema is still accepted", async () => {
    const value = { verdict: "real", confidence: 2, summary: "s" };
    expect(await evaluateGiven(call, { raw: JSON.stringify(value) })).toEqual({
      kind: "accepted",
      value,
    });
  });
});
