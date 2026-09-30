// Checked by `tsc --noEmit`, never run: each wrong answer is refused where it is written.
import type { OutputSchema } from "@agentswf/contract/workflow";
import Type from "typebox";
import { answer, reply, type Script } from ".";

const VERDICT = Type.Union([
  Type.Object({ kind: Type.Literal("ready"), summary: Type.String() }),
  Type.Object({ kind: Type.Literal("changes-requested"), feedback: Type.Array(Type.String()) }),
]);
/** A schema from another library, typed by the author surface's carrier. */
const CARRIED = { type: "object" } as OutputSchema<{ count: number }>;

export const valid: Script[] = [
  answer(VERDICT, { kind: "ready", summary: "ok" }),
  answer(VERDICT, (turn) =>
    turn.n === 1
      ? { kind: "changes-requested", feedback: ["more"] }
      : { kind: "ready", summary: "ok" },
  ),
  answer(VERDICT, async (turn) => (turn.nudge ? reply.failed() : { kind: "ready", summary: "" })),
  answer(CARRIED, { count: 1 }),
  answer(CARRIED, () => ({ count: 2 })),
  answer("text"),
  answer((turn) => `turn ${turn.n}`),
  reply.silent(),
  [answer(VERDICT, { kind: "ready", summary: "ok" }), reply.hang(), answer("done")],
];

export const invalid: Script[] = [
  // @ts-expect-error a missing field
  answer(VERDICT, { kind: "ready" }),
  // @ts-expect-error a kind the union doesn't have
  answer(VERDICT, { kind: "approved", summary: "ok" }),
  // @ts-expect-error an extra field
  answer(VERDICT, { kind: "ready", summary: "ok", extra: 1 }),
  // @ts-expect-error a function's literal must be one of the union's
  answer(VERDICT, () => ({ kind: "approved", summary: "ok" })),
  // @ts-expect-error the carrier's type
  answer(CARRIED, { count: "one" }),
  // @ts-expect-error a reply is a script entry of its own, not an answer's value
  answer(VERDICT, reply.silent()),
  // @ts-expect-error text answers a turn with no schema
  answer(42),
];

// @ts-expect-error raw JSON where a script expects answer(…)
export const raw: Script = { kind: "ready", summary: "ok" };
