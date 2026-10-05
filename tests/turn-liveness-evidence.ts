import type { OperationLivenessRecord, OutputRecord } from "../packages/contract/src/records";

export const MODES = ["host", "srt", "silent", "timeout", "cancel", "lost-route"] as const;
export type Mode = (typeof MODES)[number];
export type Evidence = { events: OperationLivenessRecord[]; incomplete: boolean }[];

export function problems(
  mode: Mode,
  code: number,
  record: OutputRecord | undefined,
  evidence: Evidence,
  route?: { removed: boolean; status: string; error: string },
): string[] {
  const errors: string[] = [];
  if (!record) return ["output record missing"];
  if (mode === "cancel") {
    if (code === 0 || record.outcome !== "cancelled") errors.push("expected operator cancellation");
  } else if (code !== 0 || record.outcome !== "completed") errors.push("workflow did not complete");
  if (!evidence.length || evidence.some((item) => item.incomplete))
    errors.push("complete liveness diagnostics missing");
  const first =
    [...evidence].sort((a, b) => (a.events[0]?.at ?? 0) - (b.events[0]?.at ?? 0))[0]?.events ?? [];
  const kinds = (kind: string) => first.filter((event) => event.kind === kind);
  if (!kinds("dispatched").length || first.at(-1)?.kind !== "terminal")
    errors.push("dispatch/terminal evidence missing");
  if (mode === "host" || mode === "srt") {
    if (
      record.outcome !== "completed" ||
      JSON.stringify(record.value) !== JSON.stringify({ first: "done", next: "follow-up" })
    )
      errors.push("both expected answers missing");
    if (kinds("waiting").length < 2) errors.push("two accepted waiting declarations missing");
    for (const sequence of [0, 1, 2]) {
      for (const kind of ["dispatched", "queue-accepted", "received"]) {
        if (!first.some((event) => event.sequence === sequence && event.kind === kind))
          errors.push(`${kind} missing for generation ${sequence}`);
      }
      if (
        sequence &&
        !first.some((event) => event.sequence === sequence && event.kind === "check-in-due")
      )
        errors.push(`check-in ${sequence} missing`);
    }
    const ordered = [...evidence].sort((a, b) => (a.events[0]?.at ?? 0) - (b.events[0]?.at ?? 0));
    if (ordered.length !== 2 || (ordered[1]?.events[0]?.at ?? 0) < (first.at(-1)?.at ?? Infinity))
      errors.push("follow-up did not begin after verified release");
    for (const item of evidence)
      if (
        !item.events.some((event) => event.kind === "admitted") ||
        !item.events.some((event) => event.kind === "releasing") ||
        item.events.at(-1)?.reason !== "answer saved"
      )
        errors.push("answer/release evidence missing");
  } else {
    if (kinds("admitted").length) errors.push("unexpected answer admitted");
    const expected =
      mode === "timeout" ? "timed-out" : mode === "cancel" ? "cancelled" : "unanswered";
    if (
      mode !== "cancel" &&
      (record.outcome !== "completed" || (record.value as { first?: string }).first !== expected)
    )
      errors.push(`expected ${expected} operation`);
    if (
      ["silent", "lost-route"].includes(mode) &&
      !first.some((event) => event.kind === "received" && event.sequence === 1)
    )
      errors.push("silent check-in receipt missing");
    if (mode === "lost-route") {
      if (kinds("waiting").length !== 1) errors.push("lost route renewed waiting");
      if (
        !route?.removed ||
        !/^[1-9]\d*$/.test(route.status.trim()) ||
        !/connect|ENOENT|socket|route/i.test(route.error)
      )
        errors.push("actual failed route command evidence missing");
    }
  }
  return errors;
}
