import type { JsonValue, OutputSchema } from "@agentswf/contract/workflow";
import type Type from "typebox";

type OutputOf<Schema extends Type.TSchema> = Extract<Type.Static<Schema>, JsonValue>;

export function outputSchema<Schema extends Type.TSchema>(
  schema: Schema & (Type.Static<Schema> extends JsonValue ? unknown : never),
): Schema & OutputSchema<OutputOf<Schema>> {
  return schema;
}
