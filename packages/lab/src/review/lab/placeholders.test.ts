import { expect, test } from "bun:test";
import { fill } from "./placeholders";
import { selectCases } from "./selection";

const values = { base: "b1", head: "h1", request: "/tmp/request.md" };

test("placeholders fill anywhere in an argument, braces escape, and an unknown one is refused", () => {
  expect(fill(["--range", "{base}...HEAD", "{request}", "plain"], values)).toEqual([
    "--range",
    "b1...HEAD",
    "/tmp/request.md",
    "plain",
  ]);
  expect(fill(["{{base}}", "a}}b{{"], values)).toEqual(["{base}", "a}b{"]);
  expect(() => fill(["{sha}"], values)).toThrow("{sha} is not a placeholder");
  expect(() => fill(["a{b"], values)).toThrow("{ is not a placeholder");
});

test("--cases takes the first n of a seeded order, the same every time, or ids and globs in it", () => {
  const ids = ["a", "b", "c", "d", "ab"];
  const rank = (id: string) => ({ a: "3", b: "1", c: "4", d: "2", ab: "5" })[id]!;
  expect(selectCases(ids, "2", rank)).toEqual(["b", "d"]);
  expect(selectCases(ids, "3", rank)).toEqual(["b", "d", "a"]);
  expect(selectCases(ids, undefined, rank)).toEqual(["b", "d", "a", "c", "ab"]);
  expect(selectCases(ids, "c,a,c", rank)).toEqual(["a", "c"]);
  expect(selectCases(ids, "a*", rank)).toEqual(["a", "ab"]);
  expect(selectCases(ids, "?,ab", rank)).toEqual(["b", "d", "a", "c", "ab"]);
  expect(() => selectCases(ids, "z", rank)).toThrow("not in the dataset: z");
  expect(() => selectCases(ids, "x*", rank)).toThrow("not in the dataset: x*");
  expect(() => selectCases(ids, "0", rank)).toThrow("a positive count");
});
