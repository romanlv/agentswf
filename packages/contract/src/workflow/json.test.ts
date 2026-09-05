import { describe, expect, test } from "bun:test";
import { isJsonValue } from "./json";

describe("isJsonValue", () => {
  test("accepts nested plain JSON values", () => {
    expect(isJsonValue({ ok: true, nested: [null, 1, "two", { three: false }] })).toBe(true);
    expect(isJsonValue(Object.assign(Object.create(null), { value: 1 }))).toBe(true);
  });

  test("rejects values that JSON serialization would omit or transform", () => {
    expect(isJsonValue(undefined)).toBe(false);
    expect(isJsonValue(Number.NaN)).toBe(false);
    expect(isJsonValue(new Date())).toBe(false);
    expect(isJsonValue(new Map())).toBe(false);
    expect(isJsonValue([, "value"])).toBe(false);
    expect(isJsonValue({ value: undefined })).toBe(false);
  });

  test("rejects hidden and symbolic object state", () => {
    const hidden = {};
    Object.defineProperty(hidden, "value", { value: 1, enumerable: false });
    expect(isJsonValue(hidden)).toBe(false);
    expect(isJsonValue({ [Symbol("value")]: 1 })).toBe(false);
  });

  test("rejects array accessors and cyclic values", () => {
    const accessor = [1];
    Object.defineProperty(accessor, "0", { get: () => 1, enumerable: true });
    expect(isJsonValue(accessor)).toBe(false);

    const object: Record<string, unknown> = {};
    object.self = object;
    expect(isJsonValue(object)).toBe(false);
    const array: unknown[] = [];
    array.push(array);
    expect(isJsonValue(array)).toBe(false);
  });
});
