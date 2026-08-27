import type { JsonSchema } from "../schema";

export const COUNT_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    count: { type: "integer", minimum: 0 },
    even: { type: "boolean" },
  },
  required: ["count", "even"],
  additionalProperties: false,
};
