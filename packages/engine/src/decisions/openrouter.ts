import { isRecord } from "@agentswf/contract";
import type { Question } from "@agentswf/contract/workflow";
import { messageOf } from "../errors";
import {
  type DecisionProvider,
  DecisionProviderError,
  type ProviderAnswer,
  type ProviderRequest,
  type ProviderResponse,
} from "./seam";

export const OPENROUTER_DECISIONS = "https://openrouter.ai/api/alpha/decisions";

/**
 * OpenRouter's Decisions API, which serves Jev (docs/research/system-one-models.md §2). It speaks
 * Jev's words: a yes-no is a `noul`, and `criteria` carries a choice's options, a score's levels
 * and a yes-no's criteria alike.
 */
export function createOpenRouterProvider(options: {
  apiKey: string;
  endpoint?: string;
  fetch?: typeof globalThis.fetch;
}): DecisionProvider {
  const { apiKey, endpoint = OPENROUTER_DECISIONS, fetch = globalThis.fetch } = options;
  // An error from the transport can quote the request's headers; the key never leaves in one.
  const redacted = (error: unknown) => messageOf(error).replaceAll(apiKey, "[OPENROUTER_API_KEY]");
  return {
    async decide(request, signal) {
      let text: string;
      let status: number;
      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
          body: JSON.stringify(wireRequest(request)),
          signal,
        });
        status = response.status;
        text = await response.text();
      } catch (error) {
        if (signal.aborted) throw error;
        // The connection failed before or while answering; it may come back.
        throw new DecisionProviderError(`openrouter unreachable: ${redacted(error)}`, {
          retryable: true,
        });
      }
      const body = parse(text);
      const failure = errorOf(body);
      if (status < 200 || status >= 300 || failure) {
        const code = failure?.code ?? status;
        const message = failure?.message ?? (text.slice(0, 200) || `status ${status}`);
        throw new DecisionProviderError(`openrouter ${code}: ${message}`, {
          retryable: code === 429 || code >= 500,
          ...spendOf(body),
        });
      }
      return fromWire(request.questions, body);
    },
  };
}

export function wireRequest(request: ProviderRequest): Record<string, unknown> {
  return {
    model: request.model,
    state: request.state,
    questions: Object.fromEntries(
      Object.entries(request.questions).map(([id, question]) => [id, wireQuestion(question)]),
    ),
  };
}

function wireQuestion(question: Question): Record<string, unknown> {
  switch (question.type) {
    case "choice":
      return { type: "choice", instructions: question.instructions, criteria: question.options };
    case "score":
      return { type: "score", instructions: question.instructions, criteria: question.levels };
    case "yes-no":
      return {
        type: "noul",
        instructions: question.instructions,
        ...(question.criteria
          ? { criteria: { true: question.criteria.yes, false: question.criteria.no } }
          : {}),
      };
  }
}

/**
 * Only the distributions are kept: the pick and `score` are derived again from them, and Jev's
 * `confidence` cannot be (findings S10). What is missing is left missing, for the directory to
 * reject.
 */
export function fromWire(questions: Record<string, Question>, body: unknown): ProviderResponse {
  if (!isRecord(body) || typeof body.model !== "string" || !isRecord(body.answers)) {
    throw new DecisionProviderError("openrouter answered without a model or answers", {
      retryable: false,
      ...spendOf(body),
    });
  }
  const answers: Record<string, ProviderAnswer> = {};
  for (const [id, question] of Object.entries(questions)) {
    const answer = Object.hasOwn(body.answers, id) ? body.answers[id] : undefined;
    if (!isRecord(answer)) continue;
    const probabilities = isRecord(answer.probabilities) ? answer.probabilities : {};
    if (answer.type === "noul") {
      answers[id] = { type: "yes-no", yes: answer.noul as number };
    } else if (answer.type === "choice") {
      answers[id] = { type: "choice", probabilities: probabilities as Record<string, number> };
    } else if (answer.type === "score") {
      answers[id] = { type: "score", probabilities: levelsOf(question, probabilities) };
    }
  }
  return { snapshot: body.model, answers, ...spendOf(body) };
}

/**
 * A score's probabilities, keyed "0" to "n-1", as a list. Any other key makes the list the wrong
 * length, for the directory to reject, as it rejects an option nobody asked about.
 */
function levelsOf(question: Question, probabilities: Record<string, unknown>): number[] {
  const count = question.type === "score" ? question.levels.length : 0;
  const listed = Array.from(
    { length: count },
    (_, index) => probabilities[String(index)] as number,
  );
  const expected = new Set(listed.map((_, index) => String(index)));
  const extra = Object.keys(probabilities).filter((key) => !expected.has(key));
  return extra.length === 0 ? listed : [...listed, ...extra.map(() => Number.NaN)];
}

/** What a body says was spent, as far as it says: tokens only when both counts are reported. */
function spendOf(body: unknown): Pick<ProviderResponse, "tokens" | "charged" | "requestId"> {
  if (!isRecord(body)) return {};
  const usage = isRecord(body.usage) ? body.usage : {};
  const counted = typeof usage.input_tokens === "number" && typeof usage.output_tokens === "number";
  return {
    ...(counted
      ? { tokens: { input: usage.input_tokens as number, output: usage.output_tokens as number } }
      : {}),
    ...(typeof usage.cost === "number" ? { charged: { amount: usage.cost, currency: "USD" } } : {}),
    ...(typeof body.id === "string" ? { requestId: body.id } : {}),
  };
}

function errorOf(body: unknown): { code: number; message: string } | undefined {
  if (!isRecord(body) || !isRecord(body.error)) return undefined;
  const { code, message } = body.error;
  return {
    code: typeof code === "number" ? code : 500,
    message: typeof message === "string" ? message : JSON.stringify(body.error),
  };
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
