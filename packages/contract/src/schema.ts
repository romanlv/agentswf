/**
 * A JSON Schema subset, small on purpose: enough shape for a workflow step's return value,
 * and no keyword whose failure a model could not act on.
 */
export type JsonSchema =
  | { enum: JsonPrimitive[]; description?: string }
  | { anyOf: JsonSchema[]; description?: string }
  | { type: "string"; const?: string; enum?: string[]; minLength?: number; description?: string }
  | {
      type: "number" | "integer";
      const?: number;
      minimum?: number;
      maximum?: number;
      description?: string;
    }
  | { type: "boolean"; const?: boolean; description?: string }
  | { type: "null"; description?: string }
  | { type: "array"; items: JsonSchema; minItems?: number; description?: string }
  | {
      type: "object";
      properties: Record<string, JsonSchema>;
      required?: string[];
      additionalProperties?: boolean;
      description?: string;
    };

type JsonPrimitive = string | number | boolean | null;

export type SchemaError = { path: string; message: string };

const ROOT = "value";
const ANNOTATION_KEYS = [
  "$id",
  "$schema",
  "title",
  "description",
  "default",
  "examples",
  "readOnly",
  "writeOnly",
] as const;

/** Checks an author-supplied JSON Schema before the engine relies on this module to validate it. */
export function parseJsonSchema(value: unknown): JsonSchema {
  if (!isRecord(value)) throw new Error("output schema must be an object");
  if ("anyOf" in value) {
    assertKeys(value, ["anyOf", ...ANNOTATION_KEYS]);
    if (!Array.isArray(value.anyOf) || value.anyOf.length === 0) {
      throw new Error("output schema anyOf must contain at least one schema");
    }
    value.anyOf.forEach(parseJsonSchema);
    return value as JsonSchema;
  }
  if (!("type" in value) && "enum" in value) {
    assertKeys(value, ["enum", ...ANNOTATION_KEYS]);
    assertPrimitiveEnum(value.enum);
    return value as JsonSchema;
  }
  switch (value.type) {
    case "string":
      assertKeys(value, ["type", "const", "enum", "minLength", ...ANNOTATION_KEYS]);
      if (value.const !== undefined && typeof value.const !== "string") invalid("string const");
      if (value.enum !== undefined) assertStringEnum(value.enum);
      if (value.minLength !== undefined) assertNonNegativeInteger(value.minLength, "minLength");
      break;
    case "number":
    case "integer":
      assertKeys(value, ["type", "const", "minimum", "maximum", ...ANNOTATION_KEYS]);
      for (const key of ["const", "minimum", "maximum"] as const) {
        if (value[key] !== undefined && !isFiniteNumber(value[key])) invalid(key);
      }
      break;
    case "boolean":
      assertKeys(value, ["type", "const", ...ANNOTATION_KEYS]);
      if (value.const !== undefined && typeof value.const !== "boolean") invalid("boolean const");
      break;
    case "null":
      assertKeys(value, ["type", ...ANNOTATION_KEYS]);
      break;
    case "array":
      assertKeys(value, ["type", "items", "minItems", ...ANNOTATION_KEYS]);
      parseJsonSchema(value.items);
      if (value.minItems !== undefined) assertNonNegativeInteger(value.minItems, "minItems");
      break;
    case "object": {
      assertKeys(value, ["type", "properties", "required", "additionalProperties", ...ANNOTATION_KEYS]);
      if (!isRecord(value.properties)) invalid("object properties");
      Object.values(value.properties).forEach(parseJsonSchema);
      if (value.required !== undefined && !isStringArray(value.required)) invalid("required");
      if (
        value.additionalProperties !== undefined &&
        typeof value.additionalProperties !== "boolean"
      ) invalid("additionalProperties");
      break;
    }
    default:
      throw new Error("output schema uses an unsupported shape");
  }
  return value as JsonSchema;
}

export function validate(schema: JsonSchema, value: unknown): SchemaError[] {
  return check(schema, value, ROOT);
}

/**
 * The text an agent reads on its own terminal and is expected to correct from, so every line
 * names one location, what was wanted there, and what arrived.
 */
export function formatErrors(errors: readonly SchemaError[]): string {
  if (errors.length === 0) return "";
  const lines = errors.map((error) => `  ${error.path}: ${error.message}`);
  return [`the value does not match the schema for this call:`, ...lines].join("\n");
}

/** Whether every constant-valued property this branch declares is present and equal in the value. */
function tagMatches(candidate: JsonSchema, value: unknown): boolean {
  if (!("type" in candidate) || candidate.type !== "object" || !isRecord(value)) return false;
  const tags = Object.entries(candidate.properties).filter(
    ([, property]) => "const" in property && property.const !== undefined,
  );
  return (
    tags.length > 0 &&
    tags.every(([key, property]) => value[key] === (property as { const: unknown }).const)
  );
}

function check(schema: JsonSchema, value: unknown, path: string): SchemaError[] {
  if ("anyOf" in schema) {
    if (schema.anyOf.some((candidate) => check(candidate, value, path).length === 0)) return [];
    // A tagged union fails inside one branch, for one reason. Reporting only that the value
    // matched none of three shapes names neither the branch nor the field, and re-states as
    // "wanted" the very thing that was supplied. E5 is what that costs in correction attempts.
    const tagged = schema.anyOf.filter((candidate) => tagMatches(candidate, value));
    if (tagged.length === 1) return check(tagged[0]!, value, path);
    return [{ path, message: `expected one of ${schema.anyOf.map(describe).join(", ")}; got ${preview(value)}` }];
  }
  if (!("type" in schema)) {
    return schema.enum.includes(value as JsonPrimitive)
      ? []
      : [{ path, message: `expected one of ${schema.enum.map(preview).join(", ")}; got ${preview(value)}` }];
  }
  switch (schema.type) {
    case "string": {
      if (typeof value !== "string") return [wrongType(path, "a string", value)];
      const errors: SchemaError[] = [];
      if (schema.const !== undefined && value !== schema.const) {
        errors.push({ path, message: `expected ${quote(schema.const)}; got ${quote(value)}` });
      }
      if (schema.enum && !schema.enum.includes(value)) {
        errors.push({
          path,
          message: `expected one of ${schema.enum.map(quote).join(", ")}; got ${quote(value)}`,
        });
      }
      if (schema.minLength !== undefined && value.length < schema.minLength) {
        errors.push({
          path,
          message: `expected at least ${schema.minLength} characters; got ${value.length}`,
        });
      }
      return errors;
    }
    case "number":
    case "integer": {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return [wrongType(path, schema.type === "integer" ? "an integer" : "a number", value)];
      }
      const errors: SchemaError[] = [];
      if (schema.const !== undefined && value !== schema.const) {
        errors.push({ path, message: `expected ${schema.const}; got ${value}` });
      }
      if (schema.type === "integer" && !Number.isInteger(value)) {
        errors.push({ path, message: `expected an integer; got ${value}` });
      }
      if (schema.minimum !== undefined && value < schema.minimum) {
        errors.push({ path, message: `expected at least ${schema.minimum}; got ${value}` });
      }
      if (schema.maximum !== undefined && value > schema.maximum) {
        errors.push({ path, message: `expected at most ${schema.maximum}; got ${value}` });
      }
      return errors;
    }
    case "boolean":
      if (typeof value !== "boolean") return [wrongType(path, "a boolean", value)];
      return schema.const === undefined || value === schema.const
        ? []
        : [{ path, message: `expected ${schema.const}; got ${value}` }];
    case "null":
      return value === null ? [] : [wrongType(path, "null", value)];
    case "array": {
      if (!Array.isArray(value)) return [wrongType(path, "an array", value)];
      const errors: SchemaError[] = [];
      if (schema.minItems !== undefined && value.length < schema.minItems) {
        errors.push({
          path,
          message: `expected at least ${schema.minItems} items; got ${value.length}`,
        });
      }
      value.forEach((item, index) => {
        errors.push(...check(schema.items, item, `${path}[${index}]`));
      });
      return errors;
    }
    case "object": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return [wrongType(path, "an object", value)];
      }
      const record = value as Record<string, unknown>;
      const errors: SchemaError[] = [];
      for (const key of schema.required ?? []) {
        // `in` reaches Object.prototype, so a property named `constructor` or `toString`
        // would read as present when it is absent.
        if (!Object.hasOwn(record, key)) {
          const expected = schema.properties[key];
          const shape = expected ? ` (${describe(expected)})` : "";
          errors.push({ path: `${path}.${key}`, message: `required property is missing${shape}` });
        }
      }
      for (const [key, item] of Object.entries(record)) {
        // Same reach, worse symptom: a value carrying a `toString` key would resolve to
        // Object.prototype.toString and be switched on as if it were a schema.
        const property = Object.hasOwn(schema.properties, key)
          ? schema.properties[key]
          : undefined;
        if (!property) {
          if (schema.additionalProperties === false) {
            const known = Object.keys(schema.properties).map(quote).join(", ");
            errors.push({
              path: `${path}.${key}`,
              message: `unexpected property; this call accepts only ${known}`,
            });
          }
          continue;
        }
        errors.push(...check(property, item, `${path}.${key}`));
      }
      return errors;
    }
  }
}

function wrongType(path: string, expected: string, value: unknown): SchemaError {
  return { path, message: `expected ${expected}; got ${typeName(value)} ${preview(value)}` };
}

function typeName(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return `a ${typeof value}`;
}

function preview(value: unknown): string {
  const text = JSON.stringify(value) ?? String(value);
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}

function quote(value: string): string {
  return JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const accepted = new Set(allowed);
  const unsupported = Object.keys(value).find((key) => !accepted.has(key));
  if (unsupported) throw new Error(`output schema keyword ${JSON.stringify(unsupported)} is unsupported`);
}

function assertPrimitiveEnum(value: unknown): asserts value is JsonPrimitive[] {
  if (!Array.isArray(value) || value.length === 0 || !value.every(isJsonPrimitive)) invalid("enum");
}

function assertStringEnum(value: unknown): asserts value is string[] {
  if (!Array.isArray(value) || value.length === 0 || !value.every((item) => typeof item === "string")) {
    invalid("string enum");
  }
}

function isJsonPrimitive(value: unknown): value is JsonPrimitive {
  return value === null || typeof value === "string" || typeof value === "boolean" || isFiniteNumber(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function assertNonNegativeInteger(value: unknown, field: string): void {
  if (!Number.isSafeInteger(value) || (value as number) < 0) invalid(field);
}

function invalid(field: string): never {
  throw new Error(`output schema has an invalid ${field}`);
}

/** A one-line rendering of a schema, used inside the prompt and inside error messages. */
export function describe(schema: JsonSchema): string {
  if ("anyOf" in schema) return `one of ${schema.anyOf.map(describe).join(", ")}`;
  if (!("type" in schema)) return `one of ${schema.enum.map(preview).join(", ")}`;
  switch (schema.type) {
    case "string":
      return schema.const !== undefined
        ? quote(schema.const)
        : schema.enum
          ? `one of ${schema.enum.map(quote).join(", ")}`
          : "string";
    case "number":
    case "integer":
      return schema.const === undefined ? schema.type : String(schema.const);
    case "boolean":
      return schema.const === undefined ? schema.type : String(schema.const);
    case "null":
      return "null";
    case "array":
      return `array of ${describe(schema.items)}`;
    case "object": {
      const required = new Set(schema.required ?? []);
      const fields = Object.entries(schema.properties).map(
        ([key, item]) => `${key}${required.has(key) ? "" : "?"}: ${describe(item)}`,
      );
      return `{ ${fields.join(", ")} }`;
    }
  }
}
