export type JsonPrimitive = string | number | boolean | null;

export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];

export type JsonObject = { [key: string]: JsonValue };

/** Carries a TypeScript output type beside the runtime JSON Schema. */
export interface OutputSchema<T extends JsonValue> {
  readonly jsonSchema: JsonObject;
  readonly "~output"?: T;
}
