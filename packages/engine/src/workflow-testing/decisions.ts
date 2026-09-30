import type { Question } from "@agentswf/contract/workflow";
import { answersOf } from "../decisions/directory";
import type {
  DecisionProvider,
  ProviderAnswer,
  ProviderRequest,
  ProviderResponse,
} from "../decisions/seam";
import { messageOf } from "../errors";
import { findByKey } from "./script";

/**
 * One question's answer in the author's terms:
 * - a choice: the option's name, or a probability per option;
 * - a score: the level's index, or a probability per level, lowest first;
 * - a yes-no: `true` or `false`, or the probability of yes.
 */
export type DecisionAnswer =
  | string
  | number
  | boolean
  | Readonly<Record<string, number>>
  | readonly number[];

/** A decision as the workflow asked it. */
export type DecisionRequest = Omit<ProviderRequest, "model">;

type Answers = Readonly<Record<string, DecisionAnswer>>;

/**
 * What a decision answers, by question id, or a function of the request that returns that. A
 * returned `Error` makes `decide` reject, as a provider failure does; a thrown one fails the test.
 */
export type DecisionScript =
  | Answers
  | Error
  | ((request: DecisionRequest) => Answers | Error | Promise<Answers | Error>);

/** The provider a workflow's test installs as `jev`: it answers each call from its key's script. */
export function createScriptedDecisions(
  scripts: Readonly<Record<string, DecisionScript>>,
  events: { onActivity(): void; onScriptError(message: string): void },
): { provider: DecisionProvider; asked: DecisionRequest[] } {
  const asked: DecisionRequest[] = [];
  const provider: DecisionProvider = {
    async decide(request) {
      events.onActivity();
      try {
        return await scripted(request);
      } finally {
        events.onActivity();
      }
    },
  };
  const scripted = async (request: ProviderRequest): Promise<ProviderResponse> => {
    const { model: _model, ...asking } = request;
    const { key } = asking;
    asked.push(asking);
    const fail = (why: string): never => {
      const message = `decision "${key}": ${why}`;
      events.onScriptError(message);
      throw new Error(message);
    };
    const found = findByKey(scripts, key, "decision");
    if ("why" in found) return fail(found.why);
    let given: Answers | Error;
    try {
      const script = found.value;
      given = typeof script === "function" ? await script(asking) : script;
    } catch (error) {
      return fail(`its script threw: ${messageOf(error)}`);
    }
    if (given instanceof Error) throw given;
    for (const id of Object.keys(given)) {
      if (!Object.hasOwn(request.questions, id)) {
        return fail(`its script answers "${id}", which it did not ask`);
      }
    }
    const answers: Record<string, ProviderAnswer> = {};
    for (const [id, question] of Object.entries(request.questions)) {
      if (!Object.hasOwn(given, id)) continue;
      const answer = distribution(question, given[id]!);
      if (!answer) {
        return fail(
          `"${id}" is a ${question.type} question; its script answers ${JSON.stringify(given[id])}`,
        );
      }
      answers[id] = answer;
    }
    try {
      answersOf(request.questions, answers);
    } catch (error) {
      return fail(`its script's answer is refused: ${messageOf(error)}`);
    }
    return { snapshot: "scripted", answers };
  };
  return { provider, asked };
}

/**
 * The author's shorthand as the distribution a provider returns, or undefined when it is no answer
 * to this kind of question. `answersOf` then checks it as it checks a provider's.
 */
function distribution(question: Question, answer: DecisionAnswer): ProviderAnswer | undefined {
  const certain = (names: readonly string[], picked: string) =>
    names.map((name) => [name, name === picked ? 1 : 0] as const);
  if (question.type === "yes-no") {
    if (typeof answer === "boolean") return { type: "yes-no", yes: Number(answer) };
    return typeof answer === "number" ? { type: "yes-no", yes: answer } : undefined;
  }
  if (question.type === "choice") {
    const names = Object.keys(question.options);
    if (typeof answer === "string") {
      return names.includes(answer)
        ? { type: "choice", probabilities: Object.fromEntries(certain(names, answer)) }
        : undefined;
    }
    return typeof answer === "object" && !Array.isArray(answer)
      ? { type: "choice", probabilities: { ...(answer as Record<string, number>) } }
      : undefined;
  }
  const levels = question.levels.map((_, level) => String(level));
  if (typeof answer === "number") {
    return levels.includes(String(answer))
      ? { type: "score", probabilities: certain(levels, String(answer)).map(([, p]) => p) }
      : undefined;
  }
  return Array.isArray(answer) ? { type: "score", probabilities: [...answer] } : undefined;
}
