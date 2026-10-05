import type { JsonSchema } from "@agentswf/contract/schema";
import type { JsonValue } from "@agentswf/contract/workflow";

/**
 * A schema as a person reads a type: `{iid: integer, url: string}`. A top-level `anyOf` is a line
 * per branch, the rest one line.
 */
export function schemaLines(schema: JsonSchema): string[] {
  return "anyOf" in schema ? schema.anyOf.map(typeText) : [typeText(schema)];
}

function typeText(schema: JsonSchema): string {
  if ("anyOf" in schema) return schema.anyOf.map(typeText).join(" | ");
  if (!("type" in schema)) return schema.enum.map((value) => JSON.stringify(value)).join(" | ");
  switch (schema.type) {
    case "string":
      if (schema.const !== undefined) return JSON.stringify(schema.const);
      return schema.enum ? schema.enum.map((value) => JSON.stringify(value)).join(" | ") : "string";
    case "number":
    case "integer":
      if (schema.const !== undefined) return String(schema.const);
      return [
        schema.type,
        ...(schema.minimum === undefined ? [] : [`≥ ${schema.minimum}`]),
        ...(schema.maximum === undefined ? [] : [`≤ ${schema.maximum}`]),
      ].join(" ");
    case "boolean":
      return schema.const === undefined ? "boolean" : String(schema.const);
    case "null":
      return "null";
    case "array": {
      const items = typeText(schema.items);
      const list = `${/^[\w"]+$/.test(items) || items.startsWith("{") ? items : `(${items})`}[]`;
      return schema.minItems ? `${list} (${schema.minItems}+)` : list;
    }
    case "object": {
      const required = new Set(schema.required ?? []);
      const fields = Object.entries(schema.properties).map(
        ([key, property]) => `${key}${required.has(key) ? "" : "?"}: ${typeText(property)}`,
      );
      return `{${fields.join(", ")}}`;
    }
  }
}

/**
 * A value its schema accepts, standing in for one not given while an attempt looks on for the
 * others it needs: the first branch, the least of each bound, required fields only.
 */
export function placeholderOf(schema: JsonSchema): JsonValue {
  if ("anyOf" in schema) return placeholderOf(schema.anyOf[0]!);
  if (!("type" in schema)) return schema.enum[0]!;
  switch (schema.type) {
    case "string": {
      const least = schema.minLength ?? 0;
      return (
        schema.const ??
        schema.enum?.find((value) => value.length >= least) ??
        schema.enum?.[0] ??
        "x".repeat(least)
      );
    }
    case "number":
      return schema.const ?? schema.minimum ?? schema.maximum ?? 0;
    case "integer":
      return (
        schema.const ??
        (schema.minimum !== undefined
          ? Math.ceil(schema.minimum)
          : schema.maximum !== undefined
            ? Math.floor(schema.maximum)
            : 0)
      );
    case "boolean":
      return schema.const ?? false;
    case "null":
      return null;
    case "array":
      return Array.from({ length: schema.minItems ?? 0 }, () => placeholderOf(schema.items));
    case "object":
      return Object.fromEntries(
        (schema.required ?? []).flatMap((key) => {
          const property = schema.properties[key];
          return [[key, property ? placeholderOf(property) : null]];
        }),
      );
  }
}
