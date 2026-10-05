import type { JsonObject, JsonValue } from "./json";
import type { AbsoluteDeadline } from "./timing";

/** Instructions, an option's description or a level: text, or structured text, as Jev allows. */
export type DecisionText = string | JsonObject;

/** An option's name and its description, or `null` when the name says enough. */
export type DecisionOptions = Record<string, DecisionText | null>;
export type DecisionLevels = readonly DecisionText[];

export interface ChoiceQuestion<O extends DecisionOptions = DecisionOptions> {
  readonly type: "choice";
  readonly instructions: DecisionText;
  readonly options: O;
}

export interface ScoreQuestion<L extends DecisionLevels = DecisionLevels> {
  readonly type: "score";
  readonly instructions: DecisionText;
  /** Ordered, lowest first. */
  readonly levels: L;
}

export interface YesNoQuestion {
  readonly type: "yes-no";
  readonly instructions: DecisionText;
  readonly criteria?: { readonly yes: DecisionText; readonly no: DecisionText };
}

export type Question = ChoiceQuestion | ScoreQuestion | YesNoQuestion;

/** Picks one of `options`. Its answer is typed by their names. */
export function choice<const O extends DecisionOptions>(
  instructions: DecisionText,
  options: O,
): ChoiceQuestion<O> {
  assertInstructions(instructions);
  if (Object.keys(options).length === 0) throw new Error("a choice needs at least one option");
  return { type: "choice", instructions, options };
}

/** Places the state on `levels`, lowest first. Its answer is typed by their indices. */
export function score<const L extends DecisionLevels>(
  instructions: DecisionText,
  levels: L,
): ScoreQuestion<L> {
  assertInstructions(instructions);
  if (levels.length === 0) throw new Error("a score needs at least one level");
  return { type: "score", instructions, levels };
}

/** The probability that the answer is yes. */
export function yesNo(
  instructions: DecisionText,
  criteria?: { yes: DecisionText; no: DecisionText },
): YesNoQuestion {
  assertInstructions(instructions);
  return criteria ? { type: "yes-no", instructions, criteria } : { type: "yes-no", instructions };
}

function assertInstructions(instructions: DecisionText): void {
  if (typeof instructions === "string" && instructions.trim() === "") {
    throw new Error("a question needs instructions");
  }
}

/** A tuple's indices as numbers, or `number` for levels only known at run time. */
type LevelOf<L extends DecisionLevels> = number extends L["length"]
  ? number
  : Extract<keyof L, `${number}`> extends `${infer N extends number}`
    ? N
    : never;

type ChoiceAnswer<O extends DecisionOptions = DecisionOptions> = {
  readonly type: "choice";
  /** The most likely option; the first of them on a tie. */
  readonly choice: keyof O & string;
  readonly probabilities: { readonly [K in keyof O & string]: number };
};

type ScoreAnswer<L extends DecisionLevels = DecisionLevels> = {
  readonly type: "score";
  /** The most likely level; the lowest of them on a tie. */
  readonly level: LevelOf<L>;
  /** The probability-weighted level. */
  readonly expected: number;
  /** One per level, lowest first. */
  readonly probabilities: readonly number[];
};

type YesNoAnswer = { readonly type: "yes-no"; readonly yes: number };

/**
 * Every answer carries its whole distribution, as the provider gave it: rounded, and not
 * renormalised. The top pick is a convenience.
 */
export type Answer<Q extends Question> =
  Q extends ChoiceQuestion<infer O>
    ? ChoiceAnswer<O>
    : Q extends ScoreQuestion<infer L>
      ? ScoreAnswer<L>
      : YesNoAnswer;

export type Answers<Q extends Record<string, Question>> = { readonly [K in keyof Q]: Answer<Q[K]> };

/** A decision model alias the operator configured, such as `jev`. */
export type DecisionAliasName = string;

export interface DecisionSpec<Q extends Record<string, Question> = Record<string, Question>> {
  /** Names the call in its record, and its prefix before `:` is its accounting stage. Not unique. */
  key: string;
  model: DecisionAliasName;
  /** What every question is asked about. The provider bills it once per call, however many questions. */
  state: string | JsonObject | JsonValue[];
  /** At least one. They are answered independently and do not see each other's answers. */
  questions: Q;
  /** Defaults to the current scope's deadline, and can only be earlier. */
  deadline?: AbsoluteDeadline;
}

/** One `decide` call, as the run keeps it in `output.json`. */
export type DecisionRecord = {
  callPath: string[];
  key: string;
  /** The workflow stage it was asked in; absent between stages. */
  stage?: string;
  /** The alias the workflow asked for. */
  alias: DecisionAliasName;
  provider: string;
  /** As the alias resolved it. */
  model: string;
  /** The versioned model that answered; absent when none did. A fitted threshold holds only for it. */
  snapshot?: string;
  startedAt: string;
  settledAt: string;
  questions: { id: string; type: Question["type"] }[];
  /**
   * SHA-256 of the questions: types, instructions, options, levels and criteria. With `snapshot`,
   * it is what a fitted threshold binds to.
   */
  questionsDigest: string;
  outcome: "answered" | "failed" | "timed-out" | "cancelled";
  error?: string;
  /** Requests sent, retries included; each may have been billed. */
  attempts: number;
  /** Summed over attempts, as far as the provider reported them. */
  tokens?: { input: number; output: number };
  requestId?: string;
  /** The request and its answers, relative to the run's artifacts, for fitting thresholds offline. */
  artifact: string;
};

export interface DecisionDirectory {
  /**
   * One request: the state once, every question about it. Once sent, a call is recorded whatever
   * its outcome, and rejects with `DeadlineExceededError` past its deadline or `DecisionError`
   * otherwise. A spec the engine refuses (an unknown alias, no questions) rejects with an `Error`
   * before anything is sent, and leaves no record.
   */
  decide<const Q extends Record<string, Question>>(
    spec: DecisionSpec<Q>,
  ): Promise<{ answers: Answers<Q>; record: DecisionRecord }>;
}

/** A decision that was asked and did not answer. Its record is in the run's too. */
export class DecisionError extends Error {
  readonly code = "decision-failed" as const;

  constructor(
    message: string,
    readonly record: DecisionRecord,
  ) {
    super(message);
    this.name = "DecisionError";
  }
}
