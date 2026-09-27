# System One models: what TypeSafe's Jev is and how it is called

Checked 2026-09-26 against primary sources only: docs.typesafe.ai, typesafe.ai, OpenRouter's docs,
OpenRouter's model pages and public models API, and the `typesafe-ai` GitHub org. The shapes below are
copied from documentation; live calls since then confirmed them, and
[`findings/system-one-models.md`](../findings/system-one-models.md) has what they measured.

## Answer

A System One model takes a `state` (text or JSON) plus a map of named, typed questions, and returns one
typed answer per question with probabilities, never text. Jev 1.13 is the only one. There are three
question types: Choice (one of up to 255 named options), Score (an ordered scale of up to 10 levels)
and Noul (yes/no). Choice and Score return the full distribution plus a derived `confidence`; Noul
returns only P(yes). The same JSON shape is served natively at `POST https://api.typesafe.ai/v1/systemone`
and on OpenRouter at `POST /api/alpha/decisions` and `POST /api/v1/systemone`. OpenRouter adds `id`,
`provider` and `usage.cost`. It costs $0.042 per million input tokens, and output is free. Calibration is
the stated training objective (RLCD), but no calibration measurement is published. `typesafe/jev-router`
is not a decision model: it is an OpenRouter chat-completions router that uses Jev to pick the model.

## 1. What a System One model is

- **Definition.** "System One models are a class of AI models built to make fast, structured decisions
  that software can use directly. A System One model evaluates a state and returns typed answers and
  probabilities." They "do not write replies, produce code, or generate explanations of their reasoning"
  ([System One](https://docs.typesafe.ai/concepts/system-one)). The name comes from Kahneman's System 1
  (same page).
- **Training.** RLCD, "reinforcement learning for calibrated decisions", "trains TypeSafe to return decisions
  and calibrated probabilities instead of generated text" ([AI primer](https://docs.typesafe.ai/introduction/machine-learning-primer)).
  All accounts share the same weights, and there is no fine-tuning or LoRA on customer data
  ([Models](https://docs.typesafe.ai/models)).
- **Models.** Jev 1.13 (`jev-1.13.0`) is the only model listed. The aliases `jev-latest` ("most recent stable,
  official release", the SDK default) and `jev-preview` both point to `jev-1.13.0`, and "there is no preview
  build available right now" ([Models](https://docs.typesafe.ai/models)). On OpenRouter it is `typesafe/jev-1.13`
  and `~typesafe/jev-latest` ([OpenRouter Jev hub](https://openrouter.ai/docs/guides/community/jev)). The
  response names a dated snapshot, `typesafe/jev-1.13-20260917`
  ([tutorial](https://openrouter.ai/docs/guides/community/jev-tutorial)).
- **jev-router.** `typesafe/jev-router` "picks the best model and reasoning effort for each request, balancing
  quality, speed, and cost. It runs on Jev". It is served through the **Chat Completions API**
  (`POST /api/v1/chat/completions`, `messages`, `stream`). Its context is 1,000,000 tokens and its input is
  text, image, file, audio and video. It is billed as a router: the models API shows pricing `-1`, and the
  page says "This model is free to use" ([model page](https://openrouter.ai/typesafe/jev-router),
  [llms.txt](https://openrouter.ai/typesafe/jev-router/llms.txt), [models API](https://openrouter.ai/api/v1/models)).
  The provider is shown as "OpenRouter" (a Stealth adapter), not TypeSafe (model page HTML). How it routes
  and which models it picks from is not documented. OpenRouter's announcement calls it "cache-aware"
  ([X post](https://x.com/OpenRouter/status/2103610898690855161)); the "237 vs 130 of 423" benchmark claim
  appears only in search snippets, and we found no primary page for it.
- **Roadmap.** No further System One model is announced. The only forward statements are in
  [jaggedness](https://docs.typesafe.ai/model-jaggedness/jev-1.13) ("Many of these will be fixed in later
  versions") and [State](https://docs.typesafe.ai/concepts/state) ("Images, audio, and video are not supported
  (yet)").

## 2. API shape

### Endpoints and auth

| Surface | Endpoint | Auth | Model IDs |
| --- | --- | --- | --- |
| TypeSafe native | `POST https://api.typesafe.ai/v1/systemone` | `Authorization: Bearer $TYPESAFE_API_KEY` (key from console.typesafe.ai) | `jev-latest`, `jev-preview`, `jev-1.13.0` |
| TypeSafe native | `GET https://api.typesafe.ai/v1/models` | same | returns `{models:[{name,description,release_date}]}` |
| OpenRouter Decisions | `POST https://openrouter.ai/api/alpha/decisions` | `Authorization: Bearer $OPENROUTER_API_KEY` | `typesafe/jev-1.13`, `~typesafe/jev-latest` |
| OpenRouter System One | `POST https://openrouter.ai/api/v1/systemone` | same | also takes the bare IDs `jev-1.13` and `jev-latest` and maps them to `typesafe/…` |

Sources: [API reference](https://docs.typesafe.ai/api), [Models](https://docs.typesafe.ai/models),
[Quickstart](https://docs.typesafe.ai/introduction/quickstart),
[Decisions reference](https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-request),
[System One reference](https://openrouter.ai/docs/api/api-reference/systemone/submit-a-system-one-request),
[OpenRouter TypeSafe SDK guide](https://openrouter.ai/docs/guides/community/typesafe-sdk). Both OpenRouter
endpoints use the same `DecisionsRequest` and `DecisionsResponse` schemas (the two references). On OpenRouter,
`GET /api/v1/models` returns OpenRouter's shape, "so the SDK rejects it" (SDK guide).
`typesafe/jev-1.13` is not listed in OpenRouter's public `/api/v1/models` but has an endpoints record
([endpoints API](https://openrouter.ai/api/v1/models/typesafe/jev-1.13/endpoints)), and its model page
returned 404 to our fetcher.

### Request

```
{
  model:     string                                   // required
  state:     string | object | array                  // required; OpenRouter SDK types also allow null
  questions: { [id: string]: Question }               // required, non-empty; id is NOT sent to the model
  // OpenRouter only: provider (routing prefs), session_id (≤256, never sent to provider), trace, user (≤256)
}
Question =
  | { type: "noul",   instructions: Text, criteria?: { true: Text, false: Text } }
  | { type: "choice", instructions: Text, criteria: { [option: string]: Text | null } }  // ≤255 options
  | { type: "score",  instructions: Text, criteria: Text[] }                              // ordered, low→high; 2–10 levels
Text = string | object | array
```

- `instructions` and every criterion accept structured JSON: "Put the question in one field and the data in
  the others, and refer to the data fields by name in backticks, the same way you point a question at a nested
  `state` value" ([API reference](https://docs.typesafe.ai/api), [Advanced: structure](https://docs.typesafe.ai/primitives/advanced)).
- Per-option descriptions are the Choice `criteria` values (`null` = none). The Score rubric is the ordered
  `criteria` array ([API reference](https://docs.typesafe.ai/api)).
- The docs disagree on details. TypeSafe says Noul `criteria` is optional with optional `true` and `false` keys,
  but OpenRouter's schema requires both keys once `criteria` is present. TypeSafe says a Score "should have at
  least two levels; the API accepts up to 10", while OpenRouter's schema says `minItems: 1` with no maximum. The
  255-option cap is TypeSafe's ([Choice](https://docs.typesafe.ai/primitives/choice)) and is absent from
  OpenRouter's schema. Live, OpenRouter enforces both 255 options and 10 levels, and accepts one of
  either (findings S2). The JS SDK types `instructions` as optional ([ChoiceQuestion](https://docs.typesafe.ai/sdk/javascript/api/interfaces/ChoiceQuestion)),
  while the HTTP reference marks it required.
- **Output types.** Only the three above exist. There are no numeric or free-value outputs, no nested or
  structured output types, and no multi-label Choice. For multi-label, the recommended practice is "one Noul
  per tag" ([OpenRouter classification cookbook](https://openrouter.ai/docs/cookbook/evaluate-and-optimize/jev-classification)).
  For extraction, turn the candidate values into a Choice ([jaggedness](https://docs.typesafe.ai/model-jaggedness/jev-1.13)).
- **Multiple questions per call** are supported and encouraged. They are "evaluated in parallel and in isolation
  against the same state" ([Introduction](https://docs.typesafe.ai/introduction)). A cap on the number of questions
  is not documented, beyond the token budget.

Verbatim example request ([OpenRouter tutorial](https://openrouter.ai/docs/guides/community/jev-tutorial)):

```bash
curl https://openrouter.ai/api/alpha/decisions \
  -H "Authorization: Bearer $OPENROUTER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "typesafe/jev-1.13",
    "state": {
      "customer_tier": "enterprise",
      "ticket": "My checkout page shows a blank screen after I click Pay. I have tried two browsers."
    },
    "questions": {
      "is_bug": {
        "type": "noul",
        "instructions": "Is the customer reporting a software defect?",
        "criteria": {
          "true": "The customer describes broken or unexpected product behavior.",
          "false": "The customer is asking a question or requesting a feature."
        }
      },
      "team": {
        "type": "choice",
        "instructions": "Which team should own this ticket?",
        "criteria": {
          "payments": "Checkout, billing, or payment processing issues.",
          "frontend": "Rendering, layout, or browser compatibility issues.",
          "account": "Login, permissions, or profile issues."
        }
      },
      "urgency": {
        "type": "score",
        "instructions": "How urgent is this ticket?",
        "criteria": [
          "Can wait for the next release",
          "Should be fixed this week",
          "Blocking revenue right now"
        ]
      }
    }
  }'
```

### Response

```
{
  model:   string                     // versioned id that answered, e.g. "jev-1.13.0" / "typesafe/jev-1.13-20260917"
  answers: { [id: string]: Answer }   // same keys as questions
  usage:   { input_tokens: int, output_tokens: int, cost?: number /* USD, OpenRouter only */ }
  id?:       string                   // OpenRouter only, "gen-dec-…"
  provider?: string                   // OpenRouter only, "TypeSafe"
}
Answer =
  | { type: "noul",   noul: number }                                   // P(yes), 0–1; no confidence
  | { type: "choice", choice: string, probabilities: {[option]: number}, confidence: number }
  | { type: "score",  score: number, legend: {"0": Text, …}, probabilities: {"0": number, …}, confidence: number }
```

- Choice `choice` is "the highest-probability option". `probabilities` covers "every option … floats that sum to 1".
  Score `score` is "the probability-weighted answer across the levels; can land between levels", indexed from 0
  ([API reference](https://docs.typesafe.ai/api)). OpenRouter's schema marks only `type` plus
  `choice`/`score`/`noul` as required, so `probabilities` and `confidence` are optional there
  ([Decisions reference](https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-request)).
- `output_tokens` is reported (20–70 in the examples) but costs nothing.

Verbatim response to the request above ([OpenRouter tutorial](https://openrouter.ai/docs/guides/community/jev-tutorial),
"captured from the live API"):

```json
{
  "id": "gen-dec-1790015143-AIaTutprXsJ5EwohRSjb",
  "model": "typesafe/jev-1.13-20260917",
  "provider": "TypeSafe",
  "answers": {
    "is_bug": { "type": "noul", "noul": 0.96 },
    "team": {
      "type": "choice",
      "choice": "payments",
      "confidence": 0.67,
      "probabilities": { "payments": 0.78, "frontend": 0.22, "account": 0 }
    },
    "urgency": {
      "type": "score",
      "score": 1.99,
      "confidence": 0.99,
      "probabilities": { "0": 0, "1": 0, "2": 1 },
      "legend": {
        "0": "Can wait for the next release",
        "1": "Should be fixed this week",
        "2": "Blocking revenue right now"
      }
    }
  },
  "usage": { "input_tokens": 476, "output_tokens": 70, "cost": 0.000019992 }
}
```

The OpenAPI example for the identical request gives `payments: 0.84, frontend: 0.16, confidence: 0.75`. The
tutorial says "Your probabilities will differ slightly from run to run", so outputs are **not deterministic**.
Seed and temperature controls are not documented.

**Errors.** Native: 401, 422 (validation), 429, 529 (overloaded) ([API reference](https://docs.typesafe.ai/api)).
OpenRouter: 400, 401, 402, 403, 404, 413, 429, 500, 502, 503, 524, 529, as `{error:{code,message}}`
([Decisions reference](https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-request)).

## 3. Limits

- **Options.** Choice takes at most 255 and Score at most 10 levels ([API reference](https://docs.typesafe.ai/api)).
- **Context.** Native: "64k tokens per request; 32k tokens for `state` plus the longest question"
  ([Models](https://docs.typesafe.ai/models)). OpenRouter: "32,000 tokens. That's the `state` you send plus the
  questions" ([Jev hub](https://openrouter.ai/docs/guides/community/jev)). The endpoint record says
  `context_length: 32000` ([endpoints API](https://openrouter.ai/api/v1/models/typesafe/jev-1.13/endpoints)).
  **The two sources disagree**, and OpenRouter's figure is the more conservative. Through OpenRouter a
  30,273-token state answered and a 40k one was refused (findings S2).
- **Input.** Text only: "String, JSON object, or array of text values. No image, audio, or video input." English
  is the primary language ([Models](https://docs.typesafe.ai/models)). Accuracy falls as irrelevant state grows
  ("Jev suffers from context rot") ([jaggedness](https://docs.typesafe.ai/model-jaggedness/jev-1.13)).
- **Rate limits.** Native: 250,000 tokens/s and 1,200 requests/min. These are "adjusting dynamically … can change
  without notice" ([Models](https://docs.typesafe.ai/models)). OpenRouter-specific limits for Jev are not
  documented.
- **Batching.** Many questions per request is the batching mechanism. The TypeSafe cookbook reports that putting
  13 questions in one call was "12.2x cheaper and 10.0x faster" ([docs index](https://docs.typesafe.ai/llms.txt));
  another page gives "11.5x cheaper and 9.6x faster" for the same experiment ([Primitives](https://docs.typesafe.ai/primitives)).
  Whether OpenRouter's Batch API accepts decisions is not documented.
- **Streaming.** Not documented for either decisions endpoint, and there is no `stream` field in the schema.

## 4. Pricing, usage, latency

- $0.042 per Mtok input, and output is free ([Models](https://docs.typesafe.ai/models); OpenRouter endpoint pricing
  `prompt: "0.000000042", completion: "0"`, [endpoints API](https://openrouter.ai/api/v1/models/typesafe/jev-1.13/endpoints)).
- Cost in the response: OpenRouter returns `usage.cost` in USD. "Every Jev response includes a `usage.cost` field"
  ([Jev hub](https://openrouter.ai/docs/guides/community/jev)). The native API returns tokens only
  ([API reference](https://docs.typesafe.ai/api)).
- Latency: "70ms-500ms end-to-end response time", and "193.6x faster, 444.6x cheaper" on TypeSafe's workflow evals
  ([launch blog](https://typesafe.ai/blog/introducing-system-one-models-and-jev)). These are vendor claims. The
  OpenRouter endpoint record has `latency_last_30m: null`, so OpenRouter publishes no latency figure.

## 5. Calibration

- **Claimed.** "Their probabilities are optimized against outcomes to reflect uncertainty. Calibration is measured
  across groups of predictions; it does not guarantee that an individual answer is correct"
  ([System One](https://docs.typesafe.ai/concepts/system-one)). The primer defines calibration in the textbook way
  (0.2 → 20%, 0.8 → 80%) ([AI primer](https://docs.typesafe.ai/introduction/machine-learning-primer)).
- **What `confidence` is.** It is "a statistic computed from the probability distribution", not a separate
  estimate: it is 1.0 when all the mass sits on one option and falls as the mass spreads. The exact formula is
  not documented. The docs' demo approximates it for three options as `(3 × max − 1) / 2`, which generalises to
  `(n·max − 1)/(n − 1)` ([Confidence](https://docs.typesafe.ai/confidence)). Noul has no confidence.
- **Measured.** No calibration metric (ECE, Brier score, reliability diagram) appears in the docs, the blog or
  [evals.typesafe.ai](https://evals.typesafe.ai/). The evals page reports accuracy, cost and time on four workflows,
  scored against labels generated by other LLMs, and gives no sample sizes. The blog's "0% hallucination/type
  errors" means the output is constrained by construction; it is not a measured rate
  ([launch blog](https://typesafe.ai/blog/introducing-system-one-models-and-jev)).
- **Vendor-stated caveats.** Separate questions are not mutually consistent: two Nouls asking a question and its
  negation summed to 1.19, and a Noul gave 0.22 where the Choice form of the same question gave P(yes) = 0.01.
  "Don't carry a threshold tuned on a Noul over to a Choice". Score is "weak in numerical calibration". Jev is weak
  at counting, dates, indirection and adversarial state ([jaggedness](https://docs.typesafe.ai/model-jaggedness/jev-1.13)).
  Because aliases move, "if you have tuned confidence thresholds against a specific version, pin that version's ID"
  ([Models](https://docs.typesafe.ai/models)).

## 6. Data handling

- **TypeSafe.** "Jev is not trained on customer requests or responses". ZDR is available for enterprise customers
  ([Models](https://docs.typesafe.ai/models), [Legal](https://docs.typesafe.ai/legal)). Retention periods are in
  the [DPA](https://typesafe.ai/legal/data-processing), which we did not read.
- **Via OpenRouter.** The provider data policy for the TypeSafe endpoint is `training: false,
  trainingOpenRouter: false, retainsPrompts: false, canPublish: false` (embedded in the model page payload for
  [typesafe/jev-1.13](https://openrouter.ai/typesafe/jev-1.13); that page renders 404 to fetchers).
  `session_id` is "never sent to the provider"
  ([Decisions reference](https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-request)).

## 7. SDKs and compatibility

- **TypeSafe.** `@typesafe-ai/sdk` (Node ≥ 20; ESM, CJS and TypeScript declarations; "answer types are inferred
  from your questions", e.g. `choice: keyof T & string`) and `typesafe-sdk` for Python ≥ 3.10
  ([JS SDK](https://docs.typesafe.ai/sdk/javascript), [ChoiceResponse](https://docs.typesafe.ai/sdk/javascript/api/interfaces/ChoiceResponse),
  [Quickstart](https://docs.typesafe.ai/introduction/quickstart); source at
  [typesafe-sdk-js](https://github.com/typesafe-ai/typesafe-sdk-js)). Both retry 429 and 529 with backoff by
  default ([Models](https://docs.typesafe.ai/models)). To point them at OpenRouter, set
  `baseURL: "https://openrouter.ai/api"` or `TYPESAFE_BASE_URL`
  ([SDK guide](https://openrouter.ai/docs/guides/community/typesafe-sdk)).
- **OpenRouter SDKs.** `openRouter.alpha.decisions.create({ decisionsRequest })` in TypeScript (`@openrouter/sdk`),
  plus Python and Go ([TS SDK](https://openrouter.ai/docs/client-sdks/typescript/sdks/decisions/README)).
- **OpenAI-compatible clients.** Jev cannot be called through them: "Jev is not a drop-in replacement for a chat
  model" ([Jev hub](https://openrouter.ai/docs/guides/community/jev)), and "there is no `model: "jev-latest"`
  setting that turns your coding agent into a Jev-powered agent" ([coding agents](https://docs.typesafe.ai/introduction/coding-agents)).
  The endpoint's `supported_parameters` is empty. Only jev-router speaks chat completions.
- **Reverse adapter.** [system-one-adapter-python](https://github.com/typesafe-ai/system-one-adapter-python) is
  TypeSafe's own "drop-in replacement for `typesafe_sdk`'s `system_one` evaluation API, backed by LLM APIs"
  (OpenAI, Anthropic, Gemini), with `llm_answer_mode="probabilities"` or `"discrete"`,
  `structured_outputs` and `normalize_probabilities`. This is TypeSafe's own provider-neutral abstraction over
  the same shape.
- **Agent skill.** `typesafe-ai/skills` ([Agent skill](https://docs.typesafe.ai/agent-skill)).

## 8. Comparable APIs

- **Cohere Classify.** `POST /v1/classify` takes `inputs` (at most 96) and `examples` (at most 2,500, at least 2
  per label). It returns `predictions`, `confidences` and a `labels` map of per-label confidence, and supports
  multi-label mode with independent confidences ([reference](https://docs.cohere.com/reference/classify)). Labels
  come from examples or a fine-tune, not from a rubric.
- **OpenAI logprobs.** `logprobs` with `top_logprobs` between 0 and 20 per token position
  ([openai-openapi](https://github.com/openai/openai-openapi)). Combined with structured outputs (a JSON-schema
  enum), this gives a distribution over at most 20 first-token alternatives. That distribution is not calibrated
  by any contract, and multi-token labels need extra work.
- **Plain LLM structured outputs** (the path system-one-adapter takes) give a closed set by schema, but any
  probability is self-reported or reconstructed.
- Anthropic, Gemini and other providers were not surveyed here.

## Implications for a provider-neutral typed-decision abstraction

**Minimal common shape** (grounded in Jev, Cohere and the adapter):

```
decide({ model, state: string | Json, questions: { [id]: Question } })
  → { model: resolvedId, answers: { [id]: Answer }, usage: { inputTokens, outputTokens?, costUsd? }, requestId? }
Question = noul(instructions, {true?, false?}) | choice(instructions, {[option]: description|null}) | score(instructions, levels[])
Answer   = { value, distribution? }   // value: boolean-prob | option | expected level
```

Jev's own three primitives are already the smallest set that covers binary, categorical and ordinal decisions.
TypeSafe's adapter shows that the shape can sit over any LLM, so adopting it would not lock awf to one vendor.

**Axes where providers differ.** An abstraction must model these or refuse them:

1. **Distribution present or absent.** Jev returns a full distribution. Logprob paths return a truncated one
   (top 20). Structured-output LLMs return none unless asked to self-report. The type needs `distribution?`, plus
   provenance saying whether it was trained for calibration, taken from logprobs or self-reported. Treating these
   three as the same "confidence" would mislead.
2. **Confidence definition.** Jev's `confidence` is a vendor statistic over the distribution. Noul has none,
   and Cohere's is per label. *Speculation:* awf should compute its own confidence from the distribution and treat
   the vendor's field as informational.
3. **Multi-label.** Cohere supports it natively. Jev does not; it uses N Nouls whose sum is unconstrained. The
   choice is to model multi-label as N independent binaries, or refuse it.
4. **Cardinality caps.** Jev allows 255 options and 10 levels, top-logprobs gives 20, and Cohere 96 inputs. These
   must be per-provider limits the abstraction checks before calling.
5. **Many questions over one state.** Jev evaluates them in parallel and "in isolation", so they cost nearly
   nothing extra. For an LLM this means N calls, or one call whose answers can influence each other. Isolation is
   a semantic property, not just an optimisation.
6. **Rubric as structured JSON** (Jev) versus labelled examples (Cohere) versus a prompt (LLMs).
7. **Determinism and pinning.** Jev's output varies run to run, and aliases move. Thresholds are valid only for a
   pinned versioned ID, so the resolved `model` must be recorded with every answer.
8. **Cost reporting.** OpenRouter returns `usage.cost`; native TypeSafe returns tokens only, and output tokens are
   free. Cost has to be computable from tokens times price when it is absent.
9. **Context budget semantics.** Jev splits the budget between state plus longest question and the whole request,
   and the two surfaces publish different numbers. A single `contextLength` loses this.
10. **Things to refuse outright** (*speculation*): free-form or numeric-extraction outputs and nested result
    types. No decision provider offers them, and Jev's docs send them to code or to a generative model.
