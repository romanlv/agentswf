export type JsonPrimitive = string | number | boolean | null;

export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];

export type JsonObject = { [key: string]: JsonValue };

export function isJsonValue(value: unknown): value is JsonValue {
  return isJsonValueAt(value, new Set<object>());
}

function isJsonValueAt(value: unknown, ancestors: Set<object>): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
  if (ancestors.has(value)) return false;
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const keys = Reflect.ownKeys(value);
      if (keys.length !== value.length + 1 || !keys.includes("length")) return false;
      return keys.every((key) => {
        if (key === "length") return true;
        if (!isArrayIndex(key)) return false;
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return descriptor?.enumerable === true && "value" in descriptor &&
          isJsonValueAt(descriptor.value, ancestors);
      });
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    return Reflect.ownKeys(value).every((key) => {
      if (typeof key !== "string") return false;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor?.enumerable === true && "value" in descriptor &&
        isJsonValueAt(descriptor.value, ancestors);
    });
  } catch {
    return false;
  } finally {
    ancestors.delete(value);
  }
}

function isArrayIndex(key: PropertyKey): boolean {
  if (typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key)) return false;
  const index = Number(key);
  return Number.isSafeInteger(index) && index >= 0 && index < 4_294_967_295;
}

/** Carries a TypeScript output type beside the runtime JSON Schema. */
export interface OutputSchema<T extends JsonValue> {
  readonly jsonSchema: JsonObject;
  readonly "~output"?: T;
}
