import {
  ANNOTATION_KEYS,
  formatErrors,
  type JsonSchema,
  validate,
} from "@agentswf/contract/schema";
import type { GivenInput } from "@agentswf/contract/wire";
import type { JsonObject } from "@agentswf/contract/workflow";
import { messageOf } from "./errors";

/**
 * An input simple enough to give as flags, `--name 'value'`: an object of a few strings, numbers,
 * booleans and enums, constrained only by what the usage line can say. Any other is given as JSON.
 */
type Simple = { name: string; required: boolean; kind: Kind }[];
type Kind =
  | { type: "string"; minLength?: number }
  | { type: "number" | "integer"; minimum?: number; maximum?: number }
  | { type: "boolean" }
  | { type: "enum"; values: string[] };

/** Said once in a prompt, under the first block taught with flags, and with every refusal of them. */
export const QUOTING_RULE =
  "Put every value in single quotes; a ' inside a value is written '\\''.";

const MAX_PROPERTIES = 6;
const NAME = /^[a-z][a-z0-9_]*$/;
/** An enum value the usage line can show between `|`s and the agent can type as it stands. */
const WORD = /^[A-Za-z0-9_.:-]+$/;
const HEREDOC = "send it as JSON on standard input, in a quoted heredoc (<<'WF_JSON' … WF_JSON)";
const ANNOTATIONS = new Set<string>(ANNOTATION_KEYS);

export function simpleInput(schema: JsonSchema): Simple | undefined {
  if (!("type" in schema) || schema.type !== "object") return undefined;
  const entries = Object.entries(schema.properties);
  // No properties is an open object or nothing at all; neither reads as flags.
  if (entries.length === 0 || entries.length > MAX_PROPERTIES) return undefined;
  const required = new Set(schema.required ?? []);
  if ([...required].some((name) => !Object.hasOwn(schema.properties, name))) return undefined;
  const simple: Simple = [];
  for (const [name, property] of entries) {
    const kind = NAME.test(name) ? kindOf(property) : undefined;
    if (!kind) return undefined;
    simple.push({ name, required: required.has(name), kind });
  }
  return simple;
}

function kindOf(schema: JsonSchema): Kind | undefined {
  const kind = anyKindOf(schema);
  return kind?.type === "enum" && !kind.values.every((value) => WORD.test(value))
    ? undefined
    : kind;
}

function anyKindOf(schema: JsonSchema): Kind | undefined {
  const keys = Object.keys(schema).filter((key) => !ANNOTATIONS.has(key));
  const only = (...allowed: string[]) => keys.every((key) => allowed.includes(key));
  if ("anyOf" in schema) {
    if (!only("anyOf")) return undefined;
    const values = schema.anyOf.map((each) =>
      "type" in each && each.type === "string" ? stringConst(each) : undefined,
    );
    return values.every((value) => value !== undefined)
      ? { type: "enum", values: values as string[] }
      : undefined;
  }
  if (!("type" in schema)) {
    return only("enum") && schema.enum.every((value) => typeof value === "string")
      ? { type: "enum", values: schema.enum as string[] }
      : undefined;
  }
  switch (schema.type) {
    case "string": {
      const constant = stringConst(schema);
      if (constant !== undefined) return { type: "enum", values: [constant] };
      if (schema.enum)
        return only("type", "enum") ? { type: "enum", values: schema.enum } : undefined;
      if (!only("type", "minLength")) return undefined;
      return { type: "string", ...(schema.minLength ? { minLength: schema.minLength } : {}) };
    }
    case "number":
    case "integer":
      if (!only("type", "minimum", "maximum")) return undefined;
      return {
        type: schema.type,
        ...(schema.minimum === undefined ? {} : { minimum: schema.minimum }),
        ...(schema.maximum === undefined ? {} : { maximum: schema.maximum }),
      };
    case "boolean":
      return only("type") ? { type: "boolean" } : undefined;
    default:
      return undefined;
  }
}

/** A string schema that is one constant and nothing else, as TypeBox writes a literal. */
function stringConst(schema: JsonSchema): string | undefined {
  if (!("type" in schema) || schema.type !== "string" || schema.const === undefined) return;
  const keys = Object.keys(schema).filter((key) => !ANNOTATIONS.has(key));
  return keys.every((key) => key === "type" || key === "const") ? schema.const : undefined;
}

/** The flags as the prompt teaches them: `--verdict noise|real --confidence <integer, 1 to 5>`. */
export function usageLine(simple: Simple): string {
  return simple
    .map(({ name, required, kind }) => {
      const flag = `--${name} ${placeholder(kind)}`;
      return required ? flag : `[${flag}]`;
    })
    .join(" ");
}

function placeholder(kind: Kind): string {
  switch (kind.type) {
    case "enum":
      return kind.values.join("|");
    case "boolean":
      return "true|false";
    case "string":
      return kind.minLength
        ? `<text, at least ${kind.minLength} character${kind.minLength === 1 ? "" : "s"}>`
        : "<text>";
    case "number":
    case "integer": {
      const { minimum, maximum } = kind;
      if (minimum !== undefined && maximum !== undefined)
        return `<${kind.type}, ${minimum} to ${maximum}>`;
      if (minimum !== undefined) return `<${kind.type}, at least ${minimum}>`;
      if (maximum !== undefined) return `<${kind.type}, at most ${maximum}>`;
      return `<${kind.type}>`;
    }
  }
}

export type ReadFlags = { ok: true; value: JsonObject } | { ok: false; error: string };
export type ReadGiven = { ok: true; value: unknown } | { ok: false; error: string };

/**
 * An input as `wf` sent it, as a value: JSON parsed, flags read by the schema, nothing as `{}`.
 * The schema's own check comes after, in `checkGiven`.
 */
export function readGiven(schema: JsonSchema | undefined, given: GivenInput): ReadGiven {
  if (given.raw !== undefined) {
    try {
      return { ok: true, value: JSON.parse(given.raw) };
    } catch (error) {
      const shape = schema ? JSON.stringify(schema) : "any JSON value";
      return {
        ok: false,
        error: `the value is not valid JSON: ${messageOf(error)}\nexpected: ${shape}`,
      };
    }
  }
  if (given.args === undefined) {
    // Nothing given is `{}` only where an object is wanted, so a text answer isn't told it's one.
    return schema && "type" in schema && schema.type === "object"
      ? { ok: true, value: {} }
      : { ok: false, error: `nothing was given; ${HEREDOC}` };
  }
  if (!schema) return { ok: false, error: `this isn't taken as flags; ${HEREDOC}` };
  return readFlags(schema, given.args);
}

/**
 * The schema's errors on a value `readGiven` returned, with the usage line when it came as flags or
 * as nothing and could have come as flags: a missing required flag names its property.
 */
export function checkGiven(
  schema: JsonSchema,
  given: GivenInput,
  value: unknown,
): string | undefined {
  const errors = validate(schema, value);
  if (errors.length === 0) return undefined;
  if (given.raw !== undefined) return formatErrors(errors);
  const simple = simpleInput(schema);
  if (simple) return `${formatErrors(errors)}\n${expected(simple)}`;
  // Nothing given to a schema that takes JSON only: a lost heredoc, as likely as not.
  return `${formatErrors(errors)}\n${HEREDOC}, matching this schema:\n${JSON.stringify(schema)}`;
}

function expected(simple: Simple): string {
  return `expected: ${usageLine(simple)}\n${QUOTING_RULE}`;
}

/**
 * Reads `--name 'value'` and `--name=value` by the schema, a number or boolean converted by its
 * type. The word after a flag is always its value, so a value may start with `--`. A value the
 * usage line rules out is refused with it; a missing required flag is left to the schema's check,
 * which names the property.
 */
export function readFlags(schema: JsonSchema, args: readonly string[]): ReadFlags {
  const simple = simpleInput(schema);
  if (!simple) {
    return {
      ok: false,
      error: `this isn't taken as flags; ${HEREDOC}, matching this schema:\n${JSON.stringify(schema)}`,
    };
  }
  const refuse = (problem: string): ReadFlags => ({
    ok: false,
    error: `${problem}\n${expected(simple)}`,
  });
  const value: JsonObject = {};
  for (let i = 0; i < args.length; i++) {
    const word = args[i]!;
    if (!word.startsWith("--")) {
      const brackets = word.startsWith("[") || word.endsWith("]");
      return refuse(
        brackets
          ? `${JSON.stringify(word)} is not a flag: leave out the brackets around an optional flag`
          : `${JSON.stringify(word)} is not a flag: each value goes right after its flag, in single quotes`,
      );
    }
    const equals = word.indexOf("=");
    const name = equals === -1 ? word.slice(2) : word.slice(2, equals);
    const property = simple.find((each) => each.name === name);
    if (!property) return refuse(`--${name} is not a flag this takes`);
    if (Object.hasOwn(value, name)) return refuse(`--${name} is given twice`);
    let text: string;
    if (equals !== -1) text = word.slice(equals + 1);
    else {
      const next = args[i + 1];
      if (next === undefined) return refuse(`--${name} needs a value`);
      text = next;
      i++;
    }
    const converted = convert(property.kind, text);
    if (converted === undefined)
      return refuse(`--${name} takes ${placeholder(property.kind)}; got ${JSON.stringify(text)}`);
    value[name] = converted;
  }
  return { ok: true, value };
}

/** The value, or undefined when the usage line says it can't be, bounds included. */
function convert(kind: Kind, text: string): string | number | boolean | undefined {
  switch (kind.type) {
    case "string":
      return text.length >= (kind.minLength ?? 0) ? text : undefined;
    case "enum":
      return kind.values.includes(text) ? text : undefined;
    case "boolean":
      return text === "true" ? true : text === "false" ? false : undefined;
    case "number":
    case "integer": {
      const trimmed = text.trim();
      if (!/^-?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(trimmed)) return undefined;
      const number = Number(trimmed);
      if (!Number.isFinite(number) || (kind.type === "integer" && !Number.isInteger(number)))
        return undefined;
      if (kind.minimum !== undefined && number < kind.minimum) return undefined;
      if (kind.maximum !== undefined && number > kind.maximum) return undefined;
      return number;
    }
  }
}
