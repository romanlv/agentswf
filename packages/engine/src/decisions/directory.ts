import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DecisionArtifact, Money, SettledDecision } from "@wf/contract/records";
import {
  type AbsoluteDeadline,
  type Answers,
  DeadlineExceededError,
  DecisionError,
  type DecisionRecord,
  type DecisionSpec,
  type JsonObject,
  type JsonValue,
  type Question,
} from "@wf/contract/workflow";
import { assertDeadline, assertDeadlineValue, earlierDeadline, scheduleAt } from "../deadlines";
import {
  type DecisionInstallation,
  type DecisionProvider,
  DecisionProviderError,
  type ProviderAnswer,
  type ProviderResponse,
} from "./seam";

const MAX_ATTEMPTS = 3;
const FIRST_BACKOFF_MILLISECONDS = 500;

/** Where a call runs: its scope's deadline, and the scope's way of cancelling what it owns. */
export type DecisionScope = {
  deadline: AbsoluteDeadline;
  /** Returns the removal. */
  add?(cancel: (reason: string) => Promise<unknown>): () => void;
};

type PreparedCall = {
  spec: DecisionSpec;
  ids: string[];
  resolved: { provider: string; model: string };
  provider: DecisionProvider;
  deadline: AbsoluteDeadline;
  slot: number;
};

type Ending =
  | { outcome: "timed-out"; deadline: AbsoluteDeadline }
  | { outcome: "cancelled"; reason: string };

/**
 * Every decision one run asks: it resolves aliases, bounds each call by its deadline, retries what
 * the provider says is retryable, and keeps a record and an artifact of each, answered or not.
 */
export class RunDecisions {
  readonly #slots: (SettledDecision | undefined)[] = [];
  readonly #cancellers = new Set<(reason: string) => void>();
  readonly #inFlight = new Set<Promise<unknown>>();
  #closed = false;

  constructor(
    private readonly options: {
      installation?: DecisionInstallation;
      runDir: string;
      sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
    },
  ) {}

  decide<Q extends Record<string, Question>>(
    spec: DecisionSpec<Q>,
    scope: DecisionScope,
  ): Promise<{ answers: Answers<Q>; record: DecisionRecord }> {
    try {
      if (this.#closed) throw new Error("workflow context is closed");
      const call = this.#prepare(spec, scope);
      const running = this.#run(call, scope);
      this.#inFlight.add(running);
      running.finally(() => this.#inFlight.delete(running)).catch(() => undefined);
      return running as Promise<{ answers: Answers<Q>; record: DecisionRecord }>;
    } catch (error) {
      return Promise.reject(error);
    }
  }

  /** Every call that has settled, in the order they were asked. */
  records(): SettledDecision[] {
    return this.#slots.filter((record): record is SettledDecision => record !== undefined);
  }

  /** Cancels every call still in flight, and waits for each to be recorded. */
  async close(): Promise<void> {
    this.#closed = true;
    for (const cancel of this.#cancellers) cancel("workflow closed");
    await Promise.allSettled([...this.#inFlight]);
  }

  #prepare(spec: DecisionSpec, scope: DecisionScope): PreparedCall {
    if (typeof spec.key !== "string" || spec.key === "") {
      throw new Error("a decision needs a key");
    }
    const ids = Object.keys(spec.questions ?? {});
    if (ids.length === 0) throw new Error(`decision ${spec.key} asks no questions`);
    for (const id of ids) assertQuestion(spec.key, id, spec.questions[id]!);
    const installed = this.options.installation;
    const resolved =
      installed && Object.hasOwn(installed.aliases, spec.model)
        ? installed.aliases[spec.model]
        : undefined;
    if (!installed || !resolved) {
      const known = Object.keys(installed?.aliases ?? {});
      throw new Error(
        `no decision model alias "${spec.model}"; ${known.length === 0 ? "none is installed" : `installed: ${known.join(", ")}`}`,
      );
    }
    const provider = Object.hasOwn(installed.providers, resolved.provider)
      ? installed.providers[resolved.provider]
      : undefined;
    if (!provider) throw new Error(`decision provider "${resolved.provider}" is not installed`);
    if (spec.deadline) assertDeadlineValue(spec.deadline);
    const deadline = spec.deadline
      ? earlierDeadline(spec.deadline, scope.deadline)
      : scope.deadline;
    assertDeadline(deadline);
    const slot = this.#slots.length;
    this.#slots.push(undefined);
    return { spec, ids, resolved, provider, deadline, slot };
  }

  async #run(
    call: PreparedCall,
    scope: DecisionScope,
  ): Promise<{ answers: Record<string, unknown>; record: DecisionRecord }> {
    const { spec, ids, resolved, provider, deadline, slot } = call;
    const startedAt = new Date().toISOString();
    const controller = new AbortController();
    let ending: Ending | undefined;
    const end = (next: Ending) => {
      ending ??= next;
      controller.abort(next.outcome);
    };
    const cancel = (reason: string) => end({ outcome: "cancelled", reason });
    const cancelTimer = scheduleAt(deadline, () => end({ outcome: "timed-out", deadline }));
    this.#cancellers.add(cancel);
    const removeFromScope = scope.add?.(async (reason) => cancel(reason));

    let attempts = 0;
    let tokens: { input: number; output: number } | undefined;
    let charged: Money[] = [];
    let requestId: string | undefined;
    let response: ProviderResponse | undefined;
    let answers: Record<string, unknown> | undefined;
    let error: string | undefined;
    const count = (spent: {
      tokens?: ProviderResponse["tokens"];
      charged?: Money;
      requestId?: string;
    }) => {
      if (spent.tokens) {
        tokens = {
          input: (tokens?.input ?? 0) + spent.tokens.input,
          output: (tokens?.output ?? 0) + spent.tokens.output,
        };
      }
      if (spent.charged) charged = [...charged, spent.charged];
      if (spent.requestId) requestId = spent.requestId;
    };
    const request = { model: resolved.model, state: spec.state, questions: spec.questions };
    try {
      while (true) {
        attempts += 1;
        try {
          // A provider that ignores the signal still cannot hold the call past its end.
          response = await untilAborted(
            provider.decide(structuredClone(request), controller.signal),
            controller.signal,
          );
          count(response);
          answers = answersOf(spec.questions, response.answers);
          break;
        } catch (thrown) {
          if (thrown instanceof DecisionProviderError) count(thrown);
          if (ending) break;
          error = messageOf(thrown);
          const backoff = FIRST_BACKOFF_MILLISECONDS * 2 ** (attempts - 1);
          const retry =
            thrown instanceof DecisionProviderError &&
            thrown.retryable &&
            attempts < MAX_ATTEMPTS &&
            Date.now() + backoff < deadline.unixMilliseconds;
          if (!retry) break;
          await (this.options.sleep ?? abortableSleep)(backoff, controller.signal);
          if (ending) break;
          error = undefined;
        }
      }
    } finally {
      cancelTimer();
      removeFromScope?.();
      this.#cancellers.delete(cancel);
    }

    const artifact = join("decisions", `${slot + 1}.json`);
    const outcome: DecisionRecord["outcome"] = ending
      ? ending.outcome
      : answers
        ? "answered"
        : "failed";
    const failure =
      ending?.outcome === "timed-out"
        ? `deadline exceeded after ${attempts} attempt${attempts === 1 ? "" : "s"}`
        : ending?.outcome === "cancelled"
          ? `cancelled: ${ending.reason}`
          : error;
    const record: DecisionRecord = {
      callPath: [],
      key: spec.key,
      alias: spec.model,
      provider: resolved.provider,
      model: resolved.model,
      ...(response ? { snapshot: response.snapshot } : {}),
      startedAt,
      settledAt: new Date().toISOString(),
      questions: ids.map((id) => ({ id, type: spec.questions[id]!.type })),
      questionsDigest: digestOf(spec.questions),
      outcome,
      ...(outcome === "answered" || failure === undefined ? {} : { error: failure }),
      attempts,
      ...(tokens ? { tokens } : {}),
      ...(requestId ? { requestId } : {}),
      artifact,
    };
    const total = sumMoney(charged);
    let settled: SettledDecision = { ...record, ...(total ? { charged: total } : {}) };
    const written: DecisionArtifact = {
      record: settled,
      request: { state: spec.state, questions: spec.questions },
      ...(answers ? { answers: answers as JsonObject } : {}),
    };
    try {
      await mkdir(join(this.options.runDir, "decisions"), { recursive: true });
      await writeFile(join(this.options.runDir, artifact), `${JSON.stringify(written, null, 2)}\n`);
    } catch (thrown) {
      const lost = `artifact not written: ${messageOf(thrown)}`;
      // Without its artifact an answer cannot be fitted again, so it does not count as one; any
      // other outcome stands.
      settled =
        settled.outcome === "answered"
          ? { ...settled, outcome: "failed", error: lost }
          : { ...settled, error: `${settled.error ?? settled.outcome}; ${lost}` };
    }
    this.#slots[slot] = settled;
    const { charged: _charged, ...returned } = settled;

    if (returned.outcome === "answered") return { answers: answers!, record: returned };
    if (returned.outcome === "timed-out") throw new DeadlineExceededError(deadline);
    throw new DecisionError(`decision ${spec.key}: ${returned.error}`, returned);
  }
}

function assertQuestion(key: string, id: string, question: Question): void {
  const where = `decision ${key}, question ${id}`;
  if (!question || typeof question !== "object") throw new Error(`${where} is not a question`);
  switch (question.type) {
    case "choice":
      if (Object.keys(question.options ?? {}).length === 0)
        throw new Error(`${where} has no options`);
      return;
    case "score":
      if (!Array.isArray(question.levels) || question.levels.length === 0) {
        throw new Error(`${where} has no levels`);
      }
      return;
    case "yes-no":
      return;
    default:
      throw new Error(
        `${where} has unknown type ${JSON.stringify((question as { type?: unknown }).type)}`,
      );
  }
}

/**
 * Every question answered with its own type and a whole distribution, or the call failed: a
 * partial answer is never passed on.
 */
export function answersOf(
  questions: Record<string, Question>,
  provided: Record<string, ProviderAnswer>,
): Record<string, unknown> {
  const answers: Record<string, unknown> = {};
  for (const [id, question] of Object.entries(questions)) {
    const answer = Object.hasOwn(provided, id) ? provided[id] : undefined;
    const invalid = (detail: string) => new Error(`question ${id}: ${detail}`);
    if (!answer) throw invalid("not answered");
    if (answer.type !== question.type) throw invalid(`answered as ${answer.type}`);
    if (question.type === "choice" && answer.type === "choice") {
      const names = Object.keys(question.options);
      const given = answer.probabilities ?? {};
      const extra = Object.keys(given).filter((name) => !names.includes(name));
      if (extra.length > 0) throw invalid(`unknown option ${extra.join(", ")}`);
      const probabilities = names.map((name) =>
        Object.hasOwn(given, name) ? given[name] : undefined,
      );
      const missing = names.find((_, index) => !isProbability(probabilities[index]));
      if (missing !== undefined) throw invalid(`no probability for option ${missing}`);
      const index = assertDistribution(probabilities as number[], invalid);
      answers[id] = {
        type: "choice",
        choice: names[index]!,
        // Built from entries, so an option named like a prototype key is still an own key.
        probabilities: Object.fromEntries(names.map((name, at) => [name, probabilities[at]!])),
      };
    } else if (question.type === "score" && answer.type === "score") {
      const probabilities = answer.probabilities ?? [];
      if (probabilities.length !== question.levels.length || !probabilities.every(isProbability)) {
        throw invalid(`expected a probability for each of ${question.levels.length} levels`);
      }
      const level = assertDistribution(probabilities, invalid);
      const total = probabilities.reduce((sum, probability) => sum + probability, 0);
      const expected =
        probabilities.reduce((sum, probability, at) => sum + probability * at, 0) / total;
      answers[id] = { type: "score", level, expected, probabilities: [...probabilities] };
    } else if (answer.type === "yes-no") {
      if (!isProbability(answer.yes)) throw invalid("no probability of yes");
      answers[id] = { type: "yes-no", yes: answer.yes };
    }
  }
  return answers;
}

/**
 * A distribution sums to 1, give or take each probability's rounding to two decimals (Jev's sum to
 * 0.99–1.00, S10). Returns the most likely index, the first of them on a tie.
 */
function assertDistribution(
  probabilities: readonly number[],
  invalid: (detail: string) => Error,
): number {
  const total = probabilities.reduce((sum, probability) => sum + probability, 0);
  const slack = Math.max(0.02, probabilities.length * 0.005);
  if (Math.abs(total - 1) > slack) throw invalid(`probabilities sum to ${total}, not 1`);
  return probabilities.reduce(
    (best, probability, at) => (probability > probabilities[best]! ? at : best),
    0,
  );
}

/**
 * SHA-256 of the questions as JSON with every object's keys sorted, except a choice's options:
 * their order breaks ties and may sway the model, so it counts.
 */
export function digestOf(questions: Record<string, Question>): string {
  const ordered = Object.fromEntries(
    Object.entries(questions).map(([id, question]) => [
      id,
      question.type === "choice"
        ? { ...question, options: Object.entries(question.options) }
        : question,
    ]),
  );
  return createHash("sha256")
    .update(JSON.stringify(canonical(ordered as unknown as JsonValue)))
    .digest("hex");
}

function canonical(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonical(value[key]!)]),
  );
}

function isProbability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

/** Charges in more than one currency cannot be added without converting, so their sum is unknown. */
function sumMoney(charges: readonly Money[]): Money | undefined {
  const currency = charges[0]?.currency;
  if (!currency || charges.some((charge) => charge.currency !== currency)) return undefined;
  return { amount: charges.reduce((sum, charge) => sum + charge.amount, 0), currency };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

function abortableSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, milliseconds);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}
