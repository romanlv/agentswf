/** Only `answered` carries a value: a turn that produced nothing cannot be read as data. */
export type CallResult =
  | { kind: "answered"; value: unknown }
  | { kind: "finished"; reason: string }
  | { kind: "blocked"; reason: string }
  | { kind: "failed"; reason: string };
