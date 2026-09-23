import Type from "typebox";
import { outputSchema } from "../output-schema";

const RAW_FINDING_SCHEMA = Type.Object(
  {
    source: Type.Enum(["catalogue", "general"]),
    rule: Type.Optional(Type.String()),
    severity: Type.Enum(["issue", "minor", "observation"]),
    file: Type.String(),
    line: Type.Optional(Type.Integer()),
    claim: Type.String(),
    evidence: Type.String(),
    suggestion: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const FINDINGS_SCHEMA = outputSchema(
  Type.Object(
    { findings: Type.Array(RAW_FINDING_SCHEMA) },
    { additionalProperties: false },
  ),
);

export const VERDICT_SCHEMA = outputSchema(
  Type.Object(
    {
      refuted: Type.Boolean(),
      reason: Type.String(),
      attribution: Type.Enum(["valid", "invalid", "not-applicable"]),
    },
    { additionalProperties: false },
  ),
);

export const SEVERITY_ORDER = { issue: 0, minor: 1, observation: 2 } as const;

export type RawFinding = Type.Static<typeof RAW_FINDING_SCHEMA>;
export type Verdict = Type.Static<typeof VERDICT_SCHEMA>;
