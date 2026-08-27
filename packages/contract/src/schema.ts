/**
 * A JSON Schema subset, small on purpose: enough shape for a workflow step's return value,
 * and no keyword whose failure a model could not act on.
 */
export type JsonSchema =
  | { type: "string"; enum?: string[]; minLength?: number; description?: string }
  | { type: "number" | "integer"; minimum?: number; maximum?: number; description?: string }
  | { type: "boolean"; description?: string }
  | { type: "array"; items: JsonSchema; minItems?: number; description?: string }
  | {
      type: "object";
      properties: Record<string, JsonSchema>;
      required?: string[];
      additionalProperties?: boolean;
      description?: string;
    };

export type SchemaError = { path: string; message: string };

const ROOT = "value";

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

function check(schema: JsonSchema, value: unknown, path: string): SchemaError[] {
  switch (schema.type) {
    case "string": {
      if (typeof value !== "string") return [wrongType(path, "a string", value)];
      const errors: SchemaError[] = [];
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
      return typeof value === "boolean" ? [] : [wrongType(path, "a boolean", value)];
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

/** A one-line rendering of a schema, used inside the prompt and inside error messages. */
export function describe(schema: JsonSchema): string {
  switch (schema.type) {
    case "string":
      return schema.enum ? `one of ${schema.enum.map(quote).join(", ")}` : "string";
    case "number":
    case "integer":
    case "boolean":
      return schema.type;
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
