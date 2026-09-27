import type { Money } from "@wf/contract/records";
import type { JsonObject, JsonValue, Question } from "@wf/contract/workflow";

/**
 * A question's distribution, as awf shapes it, before the picks are derived: a choice's by option
 * name, a score's by level index.
 */
export type ProviderAnswer =
  | { type: "choice"; probabilities: Record<string, number> }
  | { type: "score"; probabilities: number[] }
  | { type: "yes-no"; yes: number };

export type ProviderRequest = {
  model: string;
  state: string | JsonObject | JsonValue[];
  questions: Record<string, Question>;
};

export type ProviderResponse = {
  /** The versioned model that answered. */
  snapshot: string;
  answers: Record<string, ProviderAnswer>;
  /** Absent when the provider did not report them: unknown, not zero. */
  tokens?: { input: number; output: number };
  charged?: Money;
  requestId?: string;
};

/**
 * One kind of decision model behind one API. It sends one request and translates both ways; the
 * directory owns deadlines, retries and records.
 */
export interface DecisionProvider {
  decide(request: ProviderRequest, signal: AbortSignal): Promise<ProviderResponse>;
}

/** A request the provider refused or could not complete. Whatever it reported spending is kept. */
export class DecisionProviderError extends Error {
  readonly retryable: boolean;
  readonly tokens?: { input: number; output: number };
  readonly charged?: Money;
  readonly requestId?: string;

  constructor(
    message: string,
    options: {
      retryable: boolean;
      tokens?: { input: number; output: number };
      charged?: Money;
      requestId?: string;
    },
  ) {
    super(message);
    this.name = "DecisionProviderError";
    this.retryable = options.retryable;
    if (options.tokens) this.tokens = options.tokens;
    if (options.charged) this.charged = options.charged;
    if (options.requestId) this.requestId = options.requestId;
  }
}

/** What the operator runtime installed: providers by name, and the aliases workflows ask for. */
export type DecisionInstallation = {
  providers: Readonly<Record<string, DecisionProvider>>;
  aliases: Readonly<Record<string, { provider: string; model: string }>>;
  /** Aliases that could not be installed, and why, so asking for one says what to fix. */
  unavailable?: Readonly<Record<string, string>>;
};
