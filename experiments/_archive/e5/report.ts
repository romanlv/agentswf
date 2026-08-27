/**
 * E5's tables.
 *
 * `trials.jsonl` says how a trial ended; `calls/<id>/attempts.jsonl` says what the agent offered
 * on the way, which is the only place an in-turn correction is visible. A trial whose outcome is
 * `unprompted` never saw a second turn, so every attempt it logged happened inside the first one
 * — that is the population the correction rate is read from.
 *
 *   bun run e5/report.ts e5/results/e5-shipped [more run dirs...]
 */
import { readAttempts, readTrials, type Attempt } from "../deps";
import type { TrialRecord } from "../trial";

const dirs = process.argv.slice(2);
if (dirs.length === 0) throw new Error("usage: bun run e5/report.ts <run dir> [...]");

type Sample = TrialRecord & { arm: string; attempts: Attempt[] };

const samples: Sample[] = [];
for (const dir of dirs) {
  const arm = dir.split("/").filter(Boolean).at(-1)!.replace(/^e5-/, "");
  for (const trial of await readTrials<TrialRecord>(dir)) {
    samples.push({ ...trial, arm, attempts: await readAttempts(dir, trial.callId) });
  }
}

/** Which schema keyword the value broke first. The engine can only act on what it can name. */
function classify(error: string | undefined): string {
  if (!error) return "none";
  if (error.includes("not valid JSON")) return "not JSON";
  if (error.includes("expected one of")) return "enum";
  if (error.includes("expected at least") && error.includes("items")) return "minItems";
  if (error.includes("expected at least") && error.includes("characters")) return "minLength";
  if (error.includes("expected at most")) return "maximum";
  if (error.includes("expected at least")) return "minimum";
  if (error.includes("unexpected property")) return "additionalProperties";
  if (error.includes("required property is missing")) return "missing";
  if (error.includes("expected an integer")) return "integer";
  if (error.includes("expected")) return "type";
  return "other";
}

/** 1 for a value accepted first go. Only meaningful where no nudge intervened. */
function attemptsToAccept(sample: Sample): number | null {
  const index = sample.attempts.findIndex((attempt) => attempt.accepted);
  return index === -1 ? null : index + 1;
}

const table = (header: string[], body: string[][]) => {
  const widths = header.map((label, column) =>
    Math.max(label.length, ...body.map((row) => row[column]!.length)),
  );
  const render = (row: string[]) =>
    `| ${row.map((value, column) => value.padEnd(widths[column]!)).join(" | ")} |`;
  return [
    render(header),
    `|${widths.map((width) => "-".repeat(width + 2)).join("|")}|`,
    ...body.map(render),
  ].join("\n");
};

const key = (sample: Sample) => `${sample.arm}|${sample.harness}|${sample.backend}`;
const cells = new Map<string, Sample[]>();
for (const sample of samples) cells.set(key(sample), [...(cells.get(key(sample)) ?? []), sample]);

const pct = (part: number, whole: number) =>
  whole === 0 ? "—" : `${Math.round((part / whole) * 100)}%`;

console.log("## First attempt, and whether the agent fixed it inside the turn\n");
console.log(
  table(
    [
      "arm",
      "harness",
      "backend",
      "n",
      "valid 1st",
      "corrected",
      "still bad",
      "never tried",
      "in-turn fix rate",
      "delivered",
    ],
    [...cells.values()].map((group) => {
      const first = group[0]!;
      const count = (predicate: (sample: Sample) => boolean) => group.filter(predicate).length;
      const accepted = count((sample) => sample.firstAttempt === "accepted");
      const corrected = count((sample) => sample.firstAttempt === "corrected");
      const malformed = count((sample) => sample.firstAttempt === "malformed");
      return [
        first.arm,
        first.harness,
        first.backend,
        String(group.length),
        `${accepted} (${pct(accepted, group.length)})`,
        String(corrected),
        String(malformed),
        String(count((sample) => sample.firstAttempt === "absent")),
        // Of the turns that were refused at least once, how many ended the turn accepted.
        pct(corrected, corrected + malformed),
        `${count((sample) => sample.outcome !== "lost")}/${group.length}`,
      ];
    }),
  ),
);

console.log("\n## How many tries it took, for turns that were never nudged\n");
console.log(
  table(
    ["arm", "harness", "backend", "n clean turns", "1", "2", "3", "4+", "max"],
    [...cells.values()].map((group) => {
      const first = group[0]!;
      const clean = group.filter((sample) => sample.outcome === "unprompted");
      const tries = clean
        .map(attemptsToAccept)
        .filter((value): value is number => value !== null);
      const bucket = (predicate: (value: number) => boolean) =>
        String(tries.filter(predicate).length);
      return [
        first.arm,
        first.harness,
        first.backend,
        String(clean.length),
        bucket((value) => value === 1),
        bucket((value) => value === 2),
        bucket((value) => value === 3),
        bucket((value) => value >= 4),
        tries.length === 0 ? "—" : String(Math.max(...tries)),
      ];
    }),
  ),
);

console.log("\n## What the first rejection was about\n");
const reasons = new Map<string, Map<string, number>>();
for (const sample of samples) {
  const firstBad = sample.attempts.find((attempt) => !attempt.accepted);
  if (!firstBad) continue;
  const row = reasons.get(sample.arm) ?? new Map<string, number>();
  const kind = classify(firstBad.error);
  row.set(kind, (row.get(kind) ?? 0) + 1);
  reasons.set(sample.arm, row);
}
const kinds = [...new Set([...reasons.values()].flatMap((row) => [...row.keys()]))].sort();
console.log(
  table(
    ["arm", ...kinds, "total"],
    [...reasons.entries()].map(([arm, row]) => [
      arm,
      ...kinds.map((kind) => String(row.get(kind) ?? 0)),
      String([...row.values()].reduce((sum, value) => sum + value, 0)),
    ]),
  ),
);

console.log("\n## Turns that did not converge\n");
const stuck = samples.filter(
  (sample) => sample.outcome === "lost" || sample.firstAttempt === "malformed",
);
if (stuck.length === 0) {
  console.log("None: every turn that was refused ended the turn with an accepted value.");
} else {
  for (const sample of stuck) {
    console.log(
      `- ${sample.arm} ${sample.callId}: outcome=${sample.outcome} first=${sample.firstAttempt} ` +
        `attempts=${sample.attempts.length} settled=${sample.settled}`,
    );
    for (const attempt of sample.attempts) {
      console.log(
        `    ${attempt.accepted ? "ok " : "no "} ${attempt.raw.slice(0, 110).replace(/\s+/g, " ")}`,
      );
      if (attempt.error) console.log(`         ${attempt.error.replace(/\n/g, " / ")}`);
    }
  }
}

console.log("\n## Wall clock and cost of a corrected turn\n");
console.log(
  table(
    ["arm", "harness", "backend", "mean first-turn ms, clean", "mean first-turn ms, corrected"],
    [...cells.values()].map((group) => {
      const first = group[0]!;
      const mean = (values: number[]) =>
        values.length === 0
          ? "—"
          : String(Math.round(values.reduce((sum, value) => sum + value, 0) / values.length));
      return [
        first.arm,
        first.harness,
        first.backend,
        mean(
          group
            .filter((sample) => sample.firstAttempt === "accepted")
            .map((sample) => sample.firstTurnMs),
        ),
        mean(
          group
            .filter((sample) => sample.firstAttempt === "corrected")
            .map((sample) => sample.firstTurnMs),
        ),
      ];
    }),
  ),
);
