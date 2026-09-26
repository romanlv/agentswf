import type Type from "typebox";
import { Check, Errors } from "typebox/value";
import {
  type AnswerKey,
  AnswerKeySchema,
  type CollectRecord,
  CollectRecordSchema,
  type Fixture,
  FixtureSchema,
  type FixtureSet,
  FixtureSetSchema,
  type Source,
  type Votes,
  VotesSchema,
} from "./format";
import { majority, settleSeverity } from "./grading";

export type Problem = { path: string; message: string };

export type Checked<T> = { ok: true; value: T } | { ok: false; problems: Problem[] };

function checkSchema<S extends Type.TSchema>(schema: S, value: unknown): Checked<Type.Static<S>> {
  if (Check(schema, value)) return { ok: true, value };
  const seen = new Set<string>();
  const problems: Problem[] = [];
  for (const error of Errors(schema, value)) {
    const problem = { path: error.instancePath || "/", message: error.message };
    const key = `${problem.path} ${problem.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    problems.push(problem);
  }
  return { ok: false, problems };
}

export function checkFixture(value: unknown): Checked<Fixture> {
  return checkSchema(FixtureSchema, value);
}

export function checkCollectRecord(value: unknown): Checked<CollectRecord> {
  return checkSchema(CollectRecordSchema, value);
}

export function checkVotes(value: unknown): Checked<Votes> {
  return checkSchema(VotesSchema, value);
}

export function checkFixtureSet(value: unknown): Checked<FixtureSet> {
  const checked = checkSchema(FixtureSetSchema, value);
  if (!checked.ok) return checked;
  const problems = repeated(
    checked.value.fixtures.map((fixture) => fixture.id),
    "/fixtures",
  );
  return problems.length === 0 ? checked : { ok: false, problems };
}

/** Shape, plus what a schema cannot say: unique ids and sane ranges. */
export function checkAnswerKey(value: unknown): Checked<AnswerKey> {
  const checked = checkSchema(AnswerKeySchema, value);
  if (!checked.ok) return checked;
  const key = checked.value;
  const problems = repeated(
    [...key.issues.map((issue) => issue.id), ...key.refuted.map((claim) => claim.id)],
    "",
  );
  key.issues.forEach((issue, index) => {
    issue.locations.forEach((location, which) => {
      if (location.end < location.start) {
        problems.push({
          path: `/issues/${index}/locations/${which}`,
          message: "end is before start",
        });
      }
    });
  });
  return problems.length === 0 ? checked : { ok: false, problems };
}

/** What a key is checked against: the fixture's comments, its frozen code and its later pushes. */
export type KeyFacts = {
  /** Every note id, by discussion id. */
  notes: ReadonlyMap<string, ReadonlySet<number>>;
  /** Discussions the key must say something about. */
  mustAccount: readonly string[];
  snapshotVersion: number;
  /** Line counts at the frozen head, for each path the key names; null when there is no such file. */
  lines: ReadonlyMap<string, number | null>;
  /** The commits each later version added on top of the frozen head. */
  later: ReadonlyMap<number, ReadonlySet<string>>;
};

/** A valid key that doesn't match its fixture: comments that don't exist, lines past a file's end. */
export function keyProblems(key: AnswerKey, facts: KeyFacts): Problem[] {
  const problems: Problem[] = [];
  const mentioned = new Set<string>();
  const pushed = new Set([...facts.later.values()].flatMap((added) => [...added]));
  const source = (path: string, ref: Source) => {
    if ("commit" in ref && !pushed.has(ref.commit)) {
      problems.push({ path, message: `${ref.commit} is not a commit a later push added` });
    }
    if (!("discussion" in ref)) return;
    mentioned.add(ref.discussion);
    if (!facts.notes.get(ref.discussion)?.has(ref.note)) {
      problems.push({ path, message: `no note ${ref.note} in discussion ${ref.discussion}` });
    }
  };
  const sources = (path: string, refs: readonly Source[]) => {
    refs.forEach((ref, index) => {
      source(`${path}/sources/${index}`, ref);
    });
  };

  key.issues.forEach((issue, index) => {
    const at = `/issues/${index}`;
    sources(at, issue.sources);
    issue.locations.forEach((location, which) => {
      const lines = facts.lines.get(location.path);
      const path = `${at}/locations/${which}`;
      if (lines === null || lines === undefined) {
        problems.push({ path, message: `${location.path} is not in the frozen code` });
      } else if (location.end > lines) {
        problems.push({
          path,
          message: `${location.path} has ${lines} lines, not ${location.end}`,
        });
      }
    });
    const confirmation = issue.confirmation;
    if (confirmation.basis === "accepted") source(`${at}/confirmation/note`, confirmation.note);
    if (confirmation.basis === "fixed") {
      const added = facts.later.get(confirmation.version);
      if (confirmation.version <= facts.snapshotVersion || !added) {
        problems.push({
          path: `${at}/confirmation/version`,
          message: `version ${confirmation.version} is not a push after the frozen version ${facts.snapshotVersion}`,
        });
      } else if (!added.has(confirmation.commit)) {
        problems.push({
          path: `${at}/confirmation/commit`,
          message: `${confirmation.commit} is not a commit version ${confirmation.version} added after the frozen head`,
        });
      }
    }
  });
  key.refuted.forEach((claim, index) => {
    sources(`/refuted/${index}`, claim.sources);
  });
  key.excluded.forEach((exclusion, index) => {
    sources(`/excluded/${index}`, exclusion.sources);
  });

  for (const discussion of facts.mustAccount) {
    if (!mentioned.has(discussion)) {
      problems.push({
        path: "/",
        message: `discussion ${discussion} is in no issue, claim or exclusion`,
      });
    }
  }
  return problems;
}

/**
 * A key must be what its recorded votes settle to: an issue is kept only if most voters found it
 * real, with the median severity, and a refuted claim only if most found it wrong.
 */
export function votesProblems(key: AnswerKey, votes: Votes): Problem[] {
  const problems: Problem[] = [];
  const add = (message: string) => problems.push({ path: "/", message });
  if (votes.procedure !== key.procedure) add("the votes were cast under another procedure");
  problems.push(
    ...repeated(
      [...votes.issues, ...votes.refuted].map((entry) => entry.id),
      "",
    ),
  );
  for (const entry of [...votes.issues, ...votes.refuted]) {
    if (entry.votes.map((v) => v.by).join() !== votes.voters.join()) {
      add(`${entry.id} doesn't have one vote from each voter`);
    }
  }
  const issues = new Map(key.issues.map((issue) => [issue.id, issue]));
  for (const entry of votes.issues) {
    const real = majority(entry.votes.map((v) => v.real));
    const severity = settleSeverity(entry.votes.map((v) => v.severity));
    const issue = issues.get(entry.id);
    if (entry.real !== real || entry.severity !== severity) {
      add(`${entry.id}'s settled vote doesn't follow from its votes`);
    } else if (real !== (issue !== undefined)) {
      add(`${entry.id} is ${real ? "missing from" : "still in"} the key`);
    } else if (issue && issue.severity !== severity) {
      add(`${entry.id}'s severity isn't the median of its votes`);
    }
  }
  for (const id of issues.keys()) {
    if (!votes.issues.some((entry) => entry.id === id)) add(`${id} has no votes`);
  }
  const refuted = new Set(key.refuted.map((claim) => claim.id));
  for (const entry of votes.refuted) {
    const wrong = majority(entry.votes.map((v) => v.wrong));
    if (entry.wrong !== wrong) add(`${entry.id}'s settled vote doesn't follow from its votes`);
    else if (wrong !== refuted.has(entry.id)) {
      add(`${entry.id} is ${wrong ? "missing from" : "still in"} the refuted claims`);
    }
  }
  for (const id of refuted) {
    if (!votes.refuted.some((entry) => entry.id === id)) add(`${id} has no votes`);
  }
  return problems;
}

function repeated(ids: string[], path: string): Problem[] {
  const seen = new Set<string>();
  const problems: Problem[] = [];
  for (const id of ids) {
    if (seen.has(id)) problems.push({ path: path || "/", message: `id ${id} is used twice` });
    seen.add(id);
  }
  return problems;
}

export function describeProblems(file: string, problems: Problem[]): string {
  return [`${file} is not valid:`, ...problems.map((p) => `  ${p.path}: ${p.message}`)].join("\n");
}
