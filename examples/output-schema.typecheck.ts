import Type from "typebox";
import { outputSchema } from "./output-schema";

const jsonOutput = outputSchema(Type.Object({ value: Type.String() }));

// @ts-expect-error Workflow outputs must be JSON values.
const nonJsonOutput = outputSchema(Type.BigInt());

void [jsonOutput, nonJsonOutput];
