import type { AgentStateJson, OperationLivenessRecord, StageStateJson } from "./records";
import type { TurnOutcome } from "./workflow/agents";
import type { JsonValue } from "./workflow/json";
import type { StageOutcome } from "./workflow/workflow";

// @ts-expect-error Version 1 diagnostics admit only defined event kinds.
const unknown: OperationLivenessRecord["kind"] = "arbitrary-event";
void unknown;

type Exactly<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

// An agent's states are its turn's outcome kinds and the lifecycle words, nothing more or less.
const agentStates: Exactly<
  AgentStateJson,
  | TurnOutcome<JsonValue>["kind"]
  | "idle"
  | "working"
  | "waiting"
  | "awaiting-reply"
  | "stopped"
  | "interrupted"
> = true;
void agentStates;

const stageStates: Exactly<
  StageStateJson,
  StageOutcome | "running" | "interrupted" | "reused" | "provided"
> = true;
void stageStates;
