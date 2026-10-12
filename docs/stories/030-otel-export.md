---
id: "030"
title: A run shows up as one trace in the operator's OTel backend
summary: "When an OTLP endpoint is set, each attempt sends its part of the run's event log as OTLP JSON spans under the GenAI names, in one trace per run, so a continued run stays one trace; it never fails a run, and unit tests prove it."
type: story
status: draft
priority: P2
epic: observability
discovered_in: "028 review, 2026-10-11"
depends_on: ["028"]
---

# A run shows up as one trace in the operator's OTel backend

Split from [[028-run-logs-and-telemetry]] on 2026-10-11, once its review showed that the export is
more than a POST. 028 makes the run's event log span-shaped, with the keys its span ids are hashed from. This story translates
that log and sends it. The decisions below come from 028's OTel review; the code map and tasks come
once 028's record is settled.

## Outcome

An operator sets `OTEL_EXPORTER_OTLP_ENDPOINT` and runs a workflow. The backend shows the run as
one trace: each attempt of the workflow, its stages, and each agent's turns under them, with model,
usage and outcome on each turn. A continued run adds its attempt to the same trace. If the endpoint is unset, nothing
happens. If it is down, the run prints one warning and its result does not change.

The proof is unit tests, with no live backend, as the operator asked.

A run has no span of its own, since any run can be continued again
([[0011-a-run-continues-from-its-stages]]): each attempt is a root in the run's trace.

## Decisions

### The translation

A pure function turns one attempt into an OTLP/JSON `ExportTraceServiceRequest`. It takes three
inputs: `run.json`'s `workflow`, `id` and `created`, for the trace id; the attempt's events from
028's log; and its `OutputRecord`'s `usage` and `decisions` for spend, which turn lines do not
carry. The model comes from each operation's `execution`, or from its spend for the calling session,
whose `execution.model` is empty (ADR 0010). It lives
in `engine/src/otel/translate.ts`, imports contract only, and does no I/O, like
`engine/src/accounting`; the boundary check gains that rule. The sender is `engine/src/otel/send.ts`.
The folder is not named `telemetry`, which foundation §10 keeps for a package that may come later.
The translation does not go in `contract`, because the GenAI names change on their own schedule.

| 028 span | OTel span | Kind | Attributes |
| --- | --- | --- | --- |
| attempt | `invoke_workflow {workflow}` | INTERNAL | `gen_ai.operation.name`, `gen_ai.workflow.name`, `awf.run_id`, `awf.attempt`, `awf.outcome`, `error.type` when it did not complete |
| stage | `awf.stage {name}` | INTERNAL | `awf.stage` |
| operation | `invoke_agent {agent}` | INTERNAL | see below |
| decision | `chat {model}` | CLIENT | `gen_ai.provider.name` (the model's vendor), `awf.decision_provider` (`openrouter` today), `gen_ai.request.model`, usage |

On `invoke_agent`:

- `gen_ai.agent.name` is the agent key, `awf.call_path` its call path, and `gen_ai.request.model`
  the model.
- `gen_ai.provider.name` is the model's vendor (`anthropic`, `openai`), never the harness; the
  harness goes in `awf.harness`. INTERNAL rather than CLIENT, because CLIENT means a remote agent
  service.
- `gen_ai.conversation.id` is the native session id, which joins awf's spans to a harness's own
  telemetry in the same backend. The calling session's operations (`caller: true` on its
  `agent-opened`) carry `awf.caller = true` and no conversation id: that id is the operator's own
  session. A fork of the calling session is a run agent and keeps its conversation id.
- `gen_ai.usage.input_tokens` includes cached tokens, so a cache read is added to Anthropic's input
  count. Also `gen_ai.usage.cache_read.input_tokens`, `gen_ai.usage.cache_write.input_tokens` and
  `gen_ai.usage.output_tokens`. Usage is known when the attempt ends, which is when it is sent.
- No cost. A list-price estimate exists only in the run's summary, and pricing an operation would
  mean importing `engine/src/accounting`; the tokens are sent, and a backend can price them.
- `gen_ai.agent.id` is not set; the conventions discourage transient ids.

Other rules:

- **A fork** keeps its stage as parent and carries a span link to the operation in its
  `agent-forked` event's `after`; a fork whose `after` is null gets no link.
- **A parallel group** has no span and no attribute; 028 records no group. Its operations overlap
  under one parent.
- **Log lines and warnings** are span events on the innermost span. They are not OTLP logs, which
  would need a second endpoint. Check-ins and nudges are not in 028's event log, so they are not
  sent.
- **Only the attributes in this section are sent.** Never text: no log or warning text, no
  `status.message`, no reasons, labels or prompts. A log line goes as its kind, `log` or `warning`, only. The text
  would go to a third party, and a workflow may log anything.
- **Failure** is span status 2 (error) with `error.type`, never the error's text. An
  `operation-failed` sends `error.type = "failed"`. A settled operation whose outcome is `blocked`,
  `timed-out`, `failed` or `cancelled` sends that outcome as `error.type`; `answered` and
  `unanswered` are not errors. An operation that failed before it was delivered has no start; it is
  sent as a zero-length span at the time it failed.
- **A reused stage** gets no span; its work is in the attempt that ran it.
- **A decision** ends with `decision-ended`; one that did not answer has status error and
  `error.type` from its outcome.

### Ids and attempts

- **The trace id** is the first 16 bytes of `sha256("awf|" + workflow + "|" + id + "|" + created)`,
  all from `run.json`. A run's id is unique only within its workflow and run root, and `--id`
  repeats ids, so the id alone would merge unrelated runs; `created`, to the millisecond, is written
  once when the run's folder is claimed. No record changes, and moving the project does not change
  the trace. A run dir copied to another machine and continued on both would give two attempt 2s
  the same span ids; that is accepted.
- **A span id** is the first 8 bytes of `sha256(traceId + "|" + spanKey)`, where `spanKey` is the
  attempt and the keys 028's event log records for that span. 028 stores no span ids; these are
  this story's own. Sending twice sends the same spans.
- An inherited `TRACEPARENT` does not change the trace id.
- **Each attempt sends its own subtree** when it ends, rooted at its `invoke_workflow` span.
- **A killed attempt** sends nothing. Each attempt, when it ends, also sends every earlier attempt
  that has no `attempt-ended` line, which covers two kills in a row. Such an attempt is sent whole, and sent
  again by each later attempt; the same ids make that harmless. Its open spans end at the attempt's last event time, with status error and `error.type =
  interrupted`. Its spans carry no usage, since an interrupted attempt keeps none. A run that is
  never continued is never sent.

### Sending

- **On** when `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` is set, used as given, or else
  `OTEL_EXPORTER_OTLP_ENDPOINT`, with `v1/traces` appended and no double slash.
- **Off** when neither is set, or `OTEL_SDK_DISABLED=true`, or `OTEL_TRACES_EXPORTER=none`.
- **Protocol.** The body is JSON (`Content-Type: application/json`). If
  `OTEL_EXPORTER_OTLP_PROTOCOL` or its `_TRACES_` form says `grpc`, awf warns and skips. A 415 is
  reported as "this endpoint does not take JSON".
- **Headers** from `OTEL_EXPORTER_OTLP_HEADERS` (`k=v,k2=v2`, values percent-decoded).
- **Resource:** `OTEL_RESOURCE_ATTRIBUTES`, with `service.name=awf` over any `service.name` it
  holds. `OTEL_SERVICE_NAME` is not taken. Both are usually set for the harnesses.
- **Retries:** 429, 502, 503, 504 and a dropped connection are retried once, after `Retry-After`
  when it fits the deadline, else after a second. Nothing else is retried, `partial_success` included.
- **Time:** `OTEL_EXPORTER_OTLP_TIMEOUT` (10 s) per request, 15 s in all: the run's exit is held up
  at most 15 s.
- **One request per attempt.** An attempt's spans are a few hundred at most, so there is no batching.
- **One warning** sums up any failure and any spans the endpoint rejected.

The operator's `OTEL_*` variables also reach the harnesses, and claude exports with them when its
own telemetry is on. That is mostly useful, since both land in one backend, joined by
`gen_ai.conversation.id`. The variables are documented, not scrubbed. `OTEL_EXPORTER_OTLP_HEADERS`
can hold a backend's credentials, so the code map checks which `OTEL_*` variables a sandbox passes
to the agents inside it.

### Proof

- Unit tests on the encoding:
  - ids in hex (32 and 16 characters);
  - `*UnixNano` and `intValue` as decimal strings;
  - `kind` and `status.code` as integers;
  - keys in lowerCamelCase;
  - the right `AnyValue` variant for each attribute.
- A golden payload for a fixed run (stages, parallel agents, a fork, a turn that throws, a
  decision, the calling session, a `--continue` after a kill), decoded strictly against the `opentelemetry-proto` schema with a
  test-only dependency, so a misnamed field fails.
- A local `Bun.serve` receiver: the request and its headers, the one retry and the statuses never retried,
  `partial_success`, the deadline, and grpc skipped.

What unit tests cannot show is that a real backend accepts the payload and draws the tree. An
optional manual check against a local Collector or Jaeger on port 4318 would show it, recorded in
[[testing]]. It is not required.

## Open questions

- **Q1.** Is there a backend to send to? Two reviewers noted that nothing reads the export yet, and
  the GenAI conventions are all still at "Development". The translation is a pure function over a
  record that will not change, so a rename later costs one function, not a migration. Build it
  after 028, or wait until a backend is named?

## Out of scope

- Passing `TRACEPARENT` to headless claude (`-p`) and `codex exec`, so their own spans nest under the
  operation. Setting the variable is trivial, but only a live backend can show that it works. A
  todo once this story lands.
- Taking in the harnesses' own OTel.
- Metrics and OTLP logs.
- Sending spans live, during an attempt.

## Related

- [[028-run-logs-and-telemetry]]: the event log this translates.
- [[reading]]: the GenAI conventions and the harness OTel exports.
- Sources: the GenAI agent spans and attribute registry
  (`open-telemetry/semantic-conventions-genai`, `docs/gen-ai/gen-ai-agent-spans.md`,
  `gen-ai-spans.md`), the OTLP spec, and the OTLP exporter spec, read 2026-10-11.
