import { describe, expect, test } from "bun:test";
import { choice, score, yesNo } from "@agentswf/contract/workflow";
import { answersOf } from "./directory";
import { createOpenRouterProvider, OPENROUTER_DECISIONS } from "./openrouter";
import { DecisionProviderError } from "./seam";

const QUESTIONS = {
  is_bug: yesNo("Is the customer reporting a software defect?", {
    yes: "The customer describes broken or unexpected product behavior.",
    no: "The customer is asking a question or requesting a feature.",
  }),
  team: choice("Which team should own this ticket?", {
    payments: "Checkout, billing, or payment processing issues.",
    frontend: "Rendering, layout, or browser compatibility issues.",
    account: null,
  }),
  urgency: score("How urgent is this ticket?", [
    "Can wait for the next release",
    "Should be fixed this week",
    "Blocking revenue right now",
  ]),
};

/** OpenRouter's Jev tutorial, "captured from the live API" (research §2). */
const RECORDED = {
  id: "gen-dec-1790015143-AIaTutprXsJ5EwohRSjb",
  model: "typesafe/jev-1.13-20260917",
  provider: "TypeSafe",
  answers: {
    is_bug: { type: "noul", noul: 0.96 },
    team: {
      type: "choice",
      choice: "payments",
      confidence: 0.67,
      probabilities: { payments: 0.78, frontend: 0.22, account: 0 },
    },
    urgency: {
      type: "score",
      score: 1.99,
      confidence: 0.99,
      probabilities: { "0": 0, "1": 0, "2": 1 },
      legend: {
        "0": "Can wait for the next release",
        "1": "Should be fixed this week",
        "2": "Blocking revenue right now",
      },
    },
  },
  usage: { input_tokens: 476, output_tokens: 70, cost: 0.000019992 },
};

function replying(status: number, body: unknown, seen: Request[] = []) {
  return createOpenRouterProvider({
    apiKey: "sk-or-test",
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(new Request(input, init));
      return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
    }) as typeof fetch,
  });
}

const request = {
  model: "typesafe/jev-1.13",
  state: { ticket: "blank checkout" },
  questions: QUESTIONS,
};

describe("the OpenRouter decision provider", () => {
  test("asks in Jev's words and answers in awf's, keeping only the distributions", async () => {
    const seen: Request[] = [];
    const response = await replying(200, RECORDED, seen).decide(
      request,
      new AbortController().signal,
    );

    expect(seen[0]?.url).toBe(OPENROUTER_DECISIONS);
    expect(seen[0]?.headers.get("authorization")).toBe("Bearer sk-or-test");
    expect(await seen[0]?.json()).toEqual({
      model: "typesafe/jev-1.13",
      state: { ticket: "blank checkout" },
      questions: {
        is_bug: {
          type: "noul",
          instructions: "Is the customer reporting a software defect?",
          criteria: {
            true: "The customer describes broken or unexpected product behavior.",
            false: "The customer is asking a question or requesting a feature.",
          },
        },
        team: {
          type: "choice",
          instructions: "Which team should own this ticket?",
          criteria: {
            payments: "Checkout, billing, or payment processing issues.",
            frontend: "Rendering, layout, or browser compatibility issues.",
            account: null,
          },
        },
        urgency: {
          type: "score",
          instructions: "How urgent is this ticket?",
          criteria: [
            "Can wait for the next release",
            "Should be fixed this week",
            "Blocking revenue right now",
          ],
        },
      },
    });
    expect(response).toEqual({
      snapshot: "typesafe/jev-1.13-20260917",
      answers: {
        is_bug: { type: "yes-no", yes: 0.96 },
        team: { type: "choice", probabilities: { payments: 0.78, frontend: 0.22, account: 0 } },
        urgency: { type: "score", probabilities: [0, 0, 1] },
      },
      tokens: { input: 476, output: 70 },
      charged: { amount: 0.000019992, currency: "USD" },
      requestId: "gen-dec-1790015143-AIaTutprXsJ5EwohRSjb",
    });
    expect(answersOf(QUESTIONS, response.answers)).toMatchObject({
      team: { choice: "payments" },
      urgency: { level: 2, expected: 2 },
    });
  });

  test("a yes-no without criteria is sent without them", async () => {
    const seen: Request[] = [];
    await replying(200, RECORDED, seen)
      .decide({ ...request, questions: { is_bug: yesNo("Broken?") } }, new AbortController().signal)
      .catch(() => undefined);
    expect((await seen[0]!.json()).questions.is_bug).toEqual({
      type: "noul",
      instructions: "Broken?",
    });
  });

  test("an answer without its probabilities is left out, for the directory to reject", async () => {
    const bare = {
      ...RECORDED,
      answers: { ...RECORDED.answers, team: { type: "choice", choice: "payments" } },
    };
    const response = await replying(200, bare).decide(request, new AbortController().signal);
    expect(() => answersOf(QUESTIONS, response.answers)).toThrow(
      "question team: no probability for option payments",
    );
  });

  test.each([
    [
      400,
      { error: { code: 400, message: "Too many choices" } },
      false,
      "openrouter 400: Too many choices",
    ],
    [
      401,
      { error: { code: 401, message: "No auth credentials found" } },
      false,
      "openrouter 401: No auth credentials found",
    ],
    [
      429,
      { error: { code: 429, message: "Rate limit exceeded" } },
      true,
      "openrouter 429: Rate limit exceeded",
    ],
    [529, "overloaded", true, "openrouter 529: overloaded"],
    [502, "", true, "openrouter 502: status 502"],
    [500, { error: { code: 500, message: "Internal" } }, true, "openrouter 500: Internal"],
    [503, "unavailable", true, "openrouter 503: unavailable"],
    [524, "timeout", true, "openrouter 524: timeout"],
    [
      402,
      { error: { code: 402, message: "Insufficient credits" } },
      false,
      "openrouter 402: Insufficient credits",
    ],
    [413, "too large", false, "openrouter 413: too large"],
    [
      200,
      { error: { code: 503, message: "upstream overloaded" } },
      true,
      "openrouter 503: upstream overloaded",
    ],
  ] as const)(
    "a %i is retryable only when waiting could help",
    async (status, body, retryable, message) => {
      const failure = await replying(status, body)
        .decide(request, new AbortController().signal)
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(DecisionProviderError);
      expect(failure).toMatchObject({ retryable, message });
    },
  );

  test("a network failure is retryable, and an abort is passed on as it is", async () => {
    const unreachable = createOpenRouterProvider({
      apiKey: "sk-or-test",
      fetch: (async () => {
        throw new TypeError("fetch failed");
      }) as unknown as typeof fetch,
    });
    await expect(unreachable.decide(request, new AbortController().signal)).rejects.toMatchObject({
      retryable: true,
      message: "openrouter unreachable: fetch failed",
    });
    const aborted = new AbortController();
    aborted.abort("timed-out");
    const failure = await unreachable
      .decide(request, aborted.signal)
      .catch((error: unknown) => error);
    expect(failure).not.toBeInstanceOf(DecisionProviderError);
  });

  test("the key is never quoted back in an error, whatever the transport says", async () => {
    const quoting = createOpenRouterProvider({
      apiKey: "sk-or-secret",
      fetch: (async () => {
        throw new TypeError("Header 'Authorization' has invalid value: 'Bearer sk-or-secret'");
      }) as unknown as typeof fetch,
    });
    const failure = (await quoting
      .decide(request, new AbortController().signal)
      .catch((error: unknown) => error)) as Error;
    expect(failure.message).not.toContain("sk-or-secret");
    expect(failure.message).toContain("[OPENROUTER_API_KEY]");
  });

  test("a body cut off mid-read is retried like a failed connection", async () => {
    const cut = createOpenRouterProvider({
      apiKey: "sk-or-test",
      fetch: (async () =>
        ({
          status: 200,
          text: () => Promise.reject(new TypeError("socket closed")),
        }) as unknown as Response) as unknown as typeof fetch,
    });
    await expect(cut.decide(request, new AbortController().signal)).rejects.toMatchObject({
      retryable: true,
      message: "openrouter unreachable: socket closed",
    });
  });

  test("spend reported with an error is kept", async () => {
    const failure = await replying(500, {
      id: "gen-dec-1",
      error: { code: 500, message: "Internal" },
      usage: { input_tokens: 10, output_tokens: 0, cost: 0.00000042 },
    })
      .decide(request, new AbortController().signal)
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({
      tokens: { input: 10, output: 0 },
      charged: { amount: 0.00000042, currency: "USD" },
      requestId: "gen-dec-1",
    });
  });

  test("usage not reported is unknown, not zero; a cost not reported is not charged", async () => {
    const { usage: _usage, ...silent } = RECORDED;
    const unreported = await replying(200, silent).decide(request, new AbortController().signal);
    expect(unreported.tokens).toBeUndefined();
    expect(unreported.charged).toBeUndefined();
    const free = await replying(200, {
      ...RECORDED,
      usage: { input_tokens: 5, output_tokens: 1 },
    }).decide(request, new AbortController().signal);
    expect(free.tokens).toEqual({ input: 5, output: 1 });
    expect(free.charged).toBeUndefined();
  });

  test.each([
    [
      "a score keyed past its levels",
      { type: "score", probabilities: { "0": 0, "1": 0, "2": 1, "3": 0 } },
      "urgency",
      "question urgency: expected a probability for each of 3 levels",
    ],
    [
      "a score keyed by name",
      { type: "score", probabilities: { low: 0, mid: 0, high: 1 } },
      "urgency",
      "question urgency: expected a probability for each of 3 levels",
    ],
    [
      "a choice answered as a score",
      { type: "score", probabilities: { "0": 1 } },
      "team",
      "question team: answered as score",
    ],
  ] as const)("%s is rejected", async (_name, answer, id, message) => {
    const response = await replying(200, {
      ...RECORDED,
      answers: { ...RECORDED.answers, [id]: answer },
    }).decide(request, new AbortController().signal);
    expect(() => answersOf(QUESTIONS, response.answers)).toThrow(message);
  });

  test("a success that is not a decisions response is not retried", async () => {
    await expect(
      replying(200, "<html>").decide(request, new AbortController().signal),
    ).rejects.toMatchObject({ retryable: false });
  });
});
