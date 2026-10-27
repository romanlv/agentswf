import type { JsonValue } from "./json";
import type { PeerKey, PeerRef } from "./participants";
import type { AbsoluteDeadline } from "./timing";
import type { WorkflowDefinition } from "./workflow";

export type WorkflowCallId = string;

export interface WorkflowCallSpec<Args extends JsonValue, Result extends JsonValue> {
  /** Idempotency key scoped to the caller. */
  id: WorkflowCallId;
  definition: WorkflowDefinition<Args, Result>;
  args: Args;
  /** Defaults to the current workflow scope deadline. */
  deadline?: AbsoluteDeadline;
  /** The parent's peers exposed under child-local keys; a reserved key such as `operator` rejects. */
  peers?: Readonly<Record<PeerKey, PeerRef>>;
  label?: string;
}
