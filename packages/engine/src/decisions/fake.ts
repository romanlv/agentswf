import type { Question } from "@wf/contract/workflow";
import type { DecisionProvider, ProviderAnswer, ProviderRequest, ProviderResponse } from "./seam";

/** One scripted reply: a response, an error to throw, or a function of the request. */
export type FakeReply =
  | ProviderResponse
  | Error
  | ((request: ProviderRequest, signal: AbortSignal) => Promise<ProviderResponse>);

/**
 * A provider that answers from a script, one reply per request, and then with `fallback`. For the
 * engine's own tests; the default answers every question with its first option or level at 0.9.
 */
export function createFakeDecisionProvider(
  script: FakeReply[] = [],
  fallback: FakeReply = (request) => Promise.resolve(confidentResponse(request)),
): DecisionProvider & { requests: ProviderRequest[] } {
  const requests: ProviderRequest[] = [];
  return {
    requests,
    async decide(request, signal) {
      requests.push(request);
      const reply = script.shift() ?? fallback;
      if (reply instanceof Error) throw reply;
      if (typeof reply === "function") return reply(request, signal);
      return reply;
    },
  };
}

/** The first option or level at 0.9, the rest sharing 0.1; yes at 0.9. */
export function confidentResponse(request: ProviderRequest): ProviderResponse {
  const answers: Record<string, ProviderAnswer> = {};
  for (const [id, question] of Object.entries(request.questions)) answers[id] = confident(question);
  return {
    snapshot: `${request.model}-20260926`,
    answers,
    tokens: { input: 1_000, output: 10 },
    charged: { amount: 0.000042, currency: "USD" },
    requestId: `request-${Object.keys(request.questions).join("-")}`,
  };
}

function confident(question: Question): ProviderAnswer {
  if (question.type === "yes-no") return { type: "yes-no", yes: 0.9 };
  const names =
    question.type === "choice" ? Object.keys(question.options) : question.levels.map(String);
  const rest = names.length > 1 ? 0.1 / (names.length - 1) : 0;
  const probabilities = names.map((_, index) =>
    names.length === 1 ? 1 : index === 0 ? 0.9 : rest,
  );
  return question.type === "choice"
    ? {
        type: "choice",
        probabilities: Object.fromEntries(
          names.map((name, index) => [name, probabilities[index]!]),
        ),
      }
    : { type: "score", probabilities };
}
