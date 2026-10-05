import type { OperationLivenessRecord } from "./records";

// @ts-expect-error Version 1 diagnostics admit only defined event kinds.
const unknown: OperationLivenessRecord["kind"] = "arbitrary-event";
void unknown;
