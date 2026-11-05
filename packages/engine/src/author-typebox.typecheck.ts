// Checked by `tsc --noEmit`, never run.
import Type from "typebox";
import { typed } from "./author-typebox";

const json = typed(Type.Object({ value: Type.String() }));
const value: { value: string } = null as unknown as NonNullable<(typeof json)["~output"]>;

// @ts-expect-error A workflow's values must be JSON.
const notJson = typed(Type.BigInt());

void [value, notJson];
