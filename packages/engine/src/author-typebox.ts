// `agentswf/typebox`: a TypeBox schema carrying its type to `run()`, a tool's `input` and an
// event's `data`. Here rather than in the contract, which imports no schema library.
import type { JsonValue, OutputSchema } from "@agentswf/contract/workflow";
import type Type from "typebox";

type Typed<Schema extends Type.TSchema> = Extract<Type.Static<Schema>, JsonValue>;

/** The schema itself, typed so awf infers its value; a schema of a non-JSON value is a type error. */
export function typed<Schema extends Type.TSchema>(
  schema: Schema & (Type.Static<Schema> extends JsonValue ? unknown : never),
): Schema & OutputSchema<Typed<Schema>> {
  return schema;
}
