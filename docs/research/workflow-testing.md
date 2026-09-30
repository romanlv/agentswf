# Unit-testing a workflow offline

Checked 2026-09-30 for a utility that tests a workflow's own logic (branches, loops, fan-out, every
outcome kind, deadlines, prompts sent) with no live agent, the test beside the workflow. Sources are
official docs and, where those were thin, source on default branches that date.

## Answer

Two families exist, and only one fits awf. Durable engines (Temporal, Restate, Cloudflare, Vercel,
Durable Task) run the real engine in-process or in a container and swap the leaf calls; they pay
seconds of startup and CI flakiness for fidelity. Agent SDKs (pydantic-ai, the AI SDK, OpenAI
Agents) swap the model behind one interface and record every call; they are instant and
deterministic. An awf workflow is a plain async function over the author surface, so the model is
the second family: scripted agents, decisions and sandboxes behind that surface, with awf's own
orchestration (`parallel`, deadlines, outcome mapping) left real.

The design to copy is the OpenAI Agents SDK's `agents.testing` (August 2026): FIFO scripts whose
steps are a result, an error, or a responder over the recorded call; an optional `match` predicate;
a hard failure on an unscripted call; `assert_complete()` for leftovers; detached snapshots of every
call. Its gap is awf's hard case: it omits "concurrency helpers", and a global FIFO breaks under
`workflow.parallel` (Step Functions Local tells you to set a Map's `maxConcurrency` to 1). Systems
that stay deterministic under concurrency address a fake by a stable name plus a per-name index:
Cloudflare's `{name, index}`, Inngest's step id, Step Functions' state plus invocation number. awf
has the name already, the agent `key`: script FIFO per key, and cross-key interleaving stops
mattering.

Time: copy Temporal's rule, where the clock "automatically skips to the next events in time when a
workflow handle's `result` is awaited" and stops skipping while an activity runs. For awf: a
virtual clock that jumps to the next deadline when every open turn is waiting, and a scripted turn
that declares its duration, which is how a test reaches `timed-out`. Replay: awf does not replay for
durability, so take Temporal's fixture, not its determinism check. Record at the turn boundary, not
at HTTP: cassettes are transport-bound (LangSmith's silently failed for a gRPC client), and awf's
agents are CLI subprocesses.

The non-AI engines (§1b) and HTTP mocks (§1c) confirm this and add four things. Temporal Go is the
closest precedent: in memory, per-name mocks checked by `AssertExpectations`, `After(d)` for a
mock's virtual duration, a clock that skips only when nothing is in flight. HTTP libraries add
layered precedence (shared defaults, per-test overrides win) and near-miss diagnostics; Pact adds
checking fakes against the real side. Camunda adds reporting which paths a suite never reached.

## 1. Durable-workflow engines

- **Temporal (TypeScript).** `TestWorkflowEnvironment.createTimeSkipping()` downloads and starts a
  test server; `createLocal()` starts a full dev server without skipping
  ([API](https://typescript.temporal.io/api/classes/testing.TestWorkflowEnvironment)). Activities are
  faked by passing a different implementation object to `Worker.create`, so they are addressed **by
  activity name** (the object key), and any routing by argument is code inside the fake
  ([docs](https://docs.temporal.io/develop/typescript/testing-suite)). The sample:

  ```ts
  const worker = await Worker.create({ connection: env.nativeConnection, taskQueue: 'test',
    workflowsPath: require.resolve('../workflows'),
    activities: { async processOrder() { await env.sleep('2 days'); },
                  async sendNotificationEmail() { emailSent = true; } } });
  await worker.runUntil(env.client.workflow.execute(processOrderWorkflow, { workflowId: uuid(), taskQueue: 'test', args }));
  ```
  ([timer-examples test](https://github.com/temporalio/samples-typescript/blob/main/timer-examples/src/test/workflows.test.ts)).
- **Temporal time.** `execute()`/`result()` switch the server to skipped time until completion;
  `start()` plus `env.sleep()` skips by hand so a test can query mid-run; "the test server switches
  to 'normal' time while an Activity is executing"; time "is a global property" of one environment,
  so different time behaviours need separate instances
  ([docs](https://docs.temporal.io/develop/typescript/testing-suite)). Concurrency is not a test
  concern: every activity result is a history event, so order is deterministic.
- **Temporal assertions and replay.** Assert on the result, on closures in fakes, on queries, or on
  `handle.fetchHistory()`. Asked how to assert a child workflow ran, a maintainer called it "an
  implementation detail" and suggested history, logs, interceptors or spans, or registering a fake
  under the child's name ([forum](https://community.temporal.io/t/testing-child-workflow-started-in-typescript-sdk/8694)).
  `Worker.runReplayHistory({ workflowsPath }, history)` replays one JSON history,
  `runReplayHistories` many; failure is `DeterminismViolationError` or `ReplayError`
  ([docs](https://docs.temporal.io/develop/typescript/testing-suite)).
- **Temporal pain points.** ~0.5 s for the environment and 2.5–3 s for `Worker.create`, over Jest's
  5 s default; fixes are prebundling, `reuseV8Context`, `createLocal`
  ([forum](https://community.temporal.io/t/jest-workflow-unit-tests-run-long/8892),
  [#728](https://github.com/temporalio/sdk-typescript/issues/728)); open handles
  ([#928](https://github.com/temporalio/sdk-typescript/issues/928)); the PHP test server started
  time-locked, so timer-only workflows hung ([sdk-php#743](https://github.com/temporalio/sdk-php/issues/743)).
- **Inngest (`@inngest/test`).** No server: `new InngestTestEngine({ function })`, then
  `t.execute()` or `t.executeStep("id")`, returning `{ result, ctx, state, error }`; `state` maps
  step ids to outputs, and `ctx.step.*` are "Jest-compatible spy functions"
  ([reference](https://www.inngest.com/docs/reference/testing)). Steps are mocked **by step id**:

  ```ts
  const { result, ctx } = await t.execute({
    events: [{ name: "demo/event.sent", data: { message: "Hi!" } }],
    steps: [{ id: "wait-for-approval", handler() { return null; } }], // null = waitForEvent timed out
  });
  expect(ctx.step.run).toHaveBeenCalledWith("my-step", expect.any(Function));
  ```
- **Inngest time and pauses.** `step.sleep`, `sleepUntil` and `waitForEvent` "should always be
  mocked"; a sleep mock is an empty handler, a `waitForEvent` mock returns `null` for timeout
  ([reference](https://www.inngest.com/docs/reference/testing)). The docs skip `step.invoke`; in
  source an unmocked invoke, sleep or wait stops the run there, and an unmocked `step.run` runs for real
  ([InngestTestEngine.ts](https://github.com/inngest/inngest-js/blob/main/packages/test/src/InngestTestEngine.ts)).
  Handlers are lazy and cached per run; parallel steps are matched by id, not arrival order. RFC
  users asked for no real waiting on pauses and no hand-built "completionOrder" and "stepState"
  ([discussion #1680](https://github.com/orgs/inngest/discussions/1680)).
- **Restate.** Integration only: `RestateTestEnvironment.start({ services: [router] })` runs a
  container via Testcontainers; `stateOf(router, key)` reads and sets state; `alwaysReplay` replays
  at every suspension to surface non-determinism ([docs](https://docs.restate.dev/develop/ts/testing)).
  No mock context; a request for one is unanswered ([sdk-rust#44](https://github.com/restatedev/sdk-rust/issues/44)).
- **Cloudflare Workflows.** `introspectWorkflowInstance(env.WF, id)` or `introspectWorkflow(env.WF)`
  for instances whose id is unknown; inside `modify(m => …)`: `disableSleeps`,
  `disableRetryDelays`, `mockStepResult`, `mockStepError`, `forceStepTimeout`, `mockEvent`,
  `forceEventTimeout`; then `waitForStepResult`, `waitForStatus`, `getOutput`, `getError`. Steps are
  addressed **by name, and by 1-based `index` for a repeated name**: `{ name: "process-payment",
  index: 2 }`. Introspectors must be disposed per test (`await using`)
  ([test APIs](https://developers.cloudflare.com/workers/testing/vitest-integration/test-apis/)).
  Pain: a dispose race gave "Trying to mock step multiple times" on slow CI
  ([changelog](https://github.com/cloudflare/workers-sdk/blob/main/packages/vitest-pool-workers/CHANGELOG.md)),
  CI-only timeouts ([#10600](https://github.com/cloudflare/workers-sdk/issues/10600)), `vi.mock`
  breaking in the pool ([#10201](https://github.com/cloudflare/workers-sdk/issues/10201)).
- **Vercel Workflow SDK.** Steps are plain functions without the compiler; the `workflow()` Vitest
  plugin runs a workflow in-process: `start(wf, args)`, `await run.returnValue`, `waitForSleep(run)`
  then `wakeUp({ correlationIds })`, `waitForHook`/`resumeHook`. No step mocks: "`vi.mock()` … do
  *not* work inside workflow functions" ([docs](https://workflow-sdk.dev/docs/testing)). "Unable to
  resolve base URL for workflow queue" under Vitest is open and unanswered
  ([#888](https://github.com/vercel/workflow/issues/888)).
- **Azure Durable Functions / Durable Task.** Durable Functions: mock the context with Moq, set up
  `CallActivityAsync` **by activity name and input predicate**
  (`It.Is<TaskName>(n => n.Name == nameof(SayHello))`, `It.Is<string>(n => n == "Tokyo")`), call the
  orchestrator directly; Python drives the generator with `orchestrator_generator_wrapper` and
  asserts `call_args_list`. The standalone Durable Task SDKs run an in-memory engine instead
  (`DurableTaskTestHost`; JS `InMemoryOrchestrationBackend` + `TestOrchestrationWorker`) with real
  activities ([docs](https://learn.microsoft.com/en-us/azure/azure-functions/durable/durable-functions-unit-testing)).
  The mocked context sees calls but not timers; the host sees both but takes fakes as activities.
- **AWS Step Functions Local.** A `MockConfigFile.json`: `StateMachines.{name}.TestCases.{case}` maps
  **state name → mocked-response name**; each response is keyed by **invocation number or range**
  (`"0"`, `"1-2"`, `"3"`) with `Return` or `Throw`; a run picks the case by ARN suffix
  (`…:stateMachine:LambdaSQSIntegration#HappyPath`); assertions read `GetExecutionHistory`. A mocked
  task needs a response for every invocation or the execution fails; an unmocked state in a case
  calls the real service ("HybridPath"). For Map, "set the value of `maxConcurrency` to 1" or
  iterations take unpredictable mocks. Step Functions Local is now "unsupported"
  ([docs](https://docs.aws.amazon.com/step-functions/latest/dg/sfn-local-test-sm-exec.html)).
- **AWS TestState API** (Nov 2025, the replacement). One state at a time, alone or by `stateName` in
  a full definition; `--mock '{"result": …}'` or `{"errorOutput": …}`, validated against the
  service's API model by default (`fieldValidationMode` STRICT); `retrierRetryCount` picks a retry
  attempt; responses give `status`, `nextState`, `catchIndex`, `retryIndex`. Paths are "chained" by
  hand ([docs](https://docs.aws.amazon.com/step-functions/latest/dg/test-state-isolation.html)).

## 1b. Other workflow engines

- **Temporal Go.** `TestWorkflowEnvironment` is "an in-memory implementation of Temporal Server that
  supports skipping time"; Java's is in-memory too, while Python's `start_time_skipping()` and TS
  start a downloaded test-server binary ([Go](https://docs.temporal.io/develop/go/testing-suite),
  [Java](https://docs.temporal.io/develop/java/testing-suite),
  [Python source](https://github.com/temporalio/sdk-python/blob/main/temporalio/testing/_workflow.py)).
  Fakes are testify expectations **by activity (function or name) plus argument matchers**:

  ```go
  s.env.OnActivity(SimpleActivity, mock.Anything, mock.Anything).Return("", errors.New("SimpleActivityFailure"))
  s.env.OnActivity(Charge, mock.Anything, "card-1").Return("ok", nil).Once().After(2 * time.Hour)
  s.env.ExecuteWorkflow(OrderWorkflow, input)
  s.True(s.env.IsWorkflowCompleted()); s.env.AssertExpectations(s.T())
  ```
  `Return` also takes a function of the activity's signature (a responder); `Times`, `Once`, `Never`,
  `Maybe`, `NotBefore`, `InOrderMockCalls` bound and order calls; `After(d)` "sets how long to wait on
  workflow's clock before the mock call returns"; `OnWorkflow` mocks a child workflow
  ([workflow_testsuite.go](https://github.com/temporalio/sdk-go/blob/master/internal/workflow_testsuite.go)).
- **Temporal Go: misses, time, pain.** A name with no expectation runs the registered code; an
  unregistered name panics at `OnActivity`; a mocked name with unmatched args, or past its `Times`,
  fails with "The closest call I have is:" and a diff; of several matching expectations the first
  registered with calls left wins, not the most specific
  ([testify](https://github.com/stretchr/testify/blob/master/mock/mock.go)). The clock fires the next
  timer only when `runningCount == 0`, no activity or mock in flight
  ([internal_workflow_testsuite.go](https://github.com/temporalio/sdk-go/blob/master/internal/internal_workflow_testsuite.go));
  `RegisterDelayedCallback(fn, d)` signals at a virtual time; `SetTestTimeout` is a **wall-clock
  idle** limit; `SetOnActivityStartedListener` and siblings report each activity, child and timer.
  Pain: a workflow and an activity of one name collide in mocks
  ([sdk-go#887](https://github.com/temporalio/sdk-go/issues/887)); one name on two task queues
  cannot be told apart ([temporal#2099](https://github.com/temporalio/temporal/issues/2099)).
- **Temporal Java / Python.** Java: `TestWorkflowExtension` with
  `mock(GreetActivities.class, withSettings().withoutAnnotations())`, **method + Mockito matchers**.
  Python: a fake under the same `@activity.defn(name="compose_greeting")`, **by name** (links above).
- **Camunda 8 (Camunda Process Test).** The full engine in Testcontainers or a remote Camunda 8 Run;
  Zeebe Process Test's embedded engine had "faster startup" and was removed in 8.10
  ([getting started](https://docs.camunda.io/docs/apis-tools/testing/getting-started/),
  [migration](https://docs.camunda.io/docs/apis-tools/migration-manuals/migrate-to-camunda-process-test/)).
  Fakes are **by job type**, "all jobs of the given job type": `mockJobWorker("send-email")
  .thenComplete(vars)`, `.thenThrowBpmnError("INVALID_ORDER")`, `.withHandler(…)`,
  `.thenCompleteWithExampleData()` (example data kept on the BPMN element); `mockChildProcess`,
  `mockDmnDecision`. Time moves by hand, `increaseTime(Duration.ofDays(2))`, after asserting the
  timer is active ([utilities](https://docs.camunda.io/docs/apis-tools/testing/utilities/)). An
  unmocked job just waits, so the failure is a blocking assertion timing out (10 s default), not an
  unscripted-call error (inferred from [assertions](https://docs.camunda.io/docs/apis-tools/testing/assertions/)).
- **Camunda: path and coverage.** `assertThat(pi).hasCompletedElementsInOrder(byId("Start"),
  byId("Approve"), …).isCompleted()`, `hasNotActivatedElements`, and `getInvocations()` on a job
  mock. After a run CPT prints coverage per process and decision (`Process_InvoiceApproval: 96%`) and
  writes HTML and JSON "to identify untested paths" (getting started, above). Pain: startup; sharing
  one runtime cut a suite from 252 s to 95 s ([connectors#8814](https://github.com/camunda/connectors/pull/8814)).
  Camunda 7's `camunda-bpm-assert` ran in-memory H2 with `isWaitingAt`, `hasPassed`, `hasNotPassed`
  ([docs](https://docs.camunda.org/manual/7.24/user-guide/testing/)).
- **Airflow.** `dag.test()` "executes a real Dag run" in one process; `mark_success_pattern` marks
  matching task ids successful unrun, the only built-in stub
  ([debug](https://airflow.apache.org/docs/apache-airflow/stable/core-concepts/debug.html)); the rest
  is `op.execute(context={})`, `AIRFLOW_VAR_*` env and `mock.patch`
  ([best practices](https://airflow.apache.org/docs/apache-airflow/stable/best-practices.html)).
  Before 2.7 it raised on the first failed task, so `ONE_FAILED` branches were untestable
  ([#32831](https://github.com/apache/airflow/discussions/32831)).
- **Prefect.** `prefect_test_harness()` = temp SQLite + subprocess API server; `task.fn()` bypasses
  "state tracking, retries, and logging"; mocks are `unittest.mock`
  ([docs](https://docs.prefect.io/v3/how-to-guides/workflows/test-workflows)). The server fails to
  start in CI 1 in 3–5 ([#16397](https://github.com/PrefectHQ/prefect/issues/16397)).
- **Dagster.** Dependencies are resources injected **by key**, so the fake sits at the edge:
  `materialize_to_memory([assets], resources={"s3": fake})`, or `ResourceDefinition.mock_resource()`
  ([unit testing](https://docs.dagster.io/guides/test/unit-testing-assets-and-ops)); the result gives
  `success`, `asset_value`, `all_events`, `get_asset_check_evaluations()`
  ([execution](https://docs.dagster.io/api/dagster/execution)). Unfaked means the real resource.
- **Conductor.** `POST /api/workflow/test` takes `taskRefToMockOutput`, **task reference name → list**
  of `{status, output, executionTime, queueWaitTime}`, "because loops or retries can consume
  multiple mocks" ([guide](https://conductor-oss.github.io/conductor/devguide/how-tos/Workflows/testing-workflows.html)).
  In source the real decider runs under a random task domain, pops each list with `remove(0)`,
  back-dates a task's start by the mock's `executionTime` to hit timeouts, and on a task with no mock
  **returns the still-running workflow, no error**; leftovers are unchecked
  ([WorkflowTestService.java](https://github.com/conductor-oss/conductor/blob/main/core/src/main/java/com/netflix/conductor/service/WorkflowTestService.java)).
- **Thinner.** DBOS: no test API; unit tests `jest.mock` the SDK, integration tests reset Postgres
  ([docs](https://docs.dbos.dev/typescript/tutorials/testing)). Hatchet: `task.mock_run(input,
  parent_outputs=…)` runs one task, no workflow harness ([runnables](https://docs.hatchet.run/sdks/python/runnables)).
  Trigger.dev: dashboard test runs only ([docs](https://trigger.dev/docs/run-tests)); `@trigger.dev/testing`
  is v2-era jobs (no v3/v4 equivalent found, unverified). Windmill mocks or pins a past result in
  the editor ([docs](https://www.windmill.dev/docs/flows/step_mocking)). Argo: nothing
  ([#2931](https://github.com/argoproj/argo-workflows/issues/2931) closed without a tool).

## 1c. HTTP mocking and contract testing

A turn is an outbound call: a request (prompt) to a named host (agent key), a typed response, often
several in flight. These libraries have the most mileage on that shape.

- **nock.** Interceptors by host + method + path (+ body); each is removed when used, so two on one
  URL answer in order, and with none left: "Nock: No match for request". `.times(n)`, `.persist()`,
  `.optionally()` (not a leftover); `isDone()`, `pendingMocks()`; `disableNetConnect()` makes any
  unmocked host an error, `allowUnmocked` lets it through. `.delay(ms)` is real time;
  `.replyWithError()`. Nock Back: `wild`, `dryrun` (default, allows live), `record`, `update`,
  `lockdown` ([README](https://github.com/nock/nock/blob/main/README.md)).
- **MSW.** Handlers by method + route; the first match in the list answers; `server.use()`
  **prepends** per-test handlers over the shared ones; `{ once: true }` is used up after one match;
  `resetHandlers()` drops overrides ([overrides](https://mswjs.io/docs/best-practices/network-behavior-overrides),
  [http](https://mswjs.io/docs/api/http)). Unhandled: `onUnhandledFrame` (was `onUnhandledRequest`)
  `"warn"` by default, `"error"` halts ([listen](https://mswjs.io/docs/api/setup-server/listen));
  `delay("infinite")` for timeouts ([delay](https://mswjs.io/docs/api/delay)). No leftover check.
- **WireMock.** Overlap resolves by `atPriority` (1 highest, default 5), then newest
  ([stubbing](https://wiremock.org/docs/stubbing/)); unmatched is a 404, but the JUnit 5 extension
  fails the test by default ([junit](https://wiremock.org/docs/junit-jupiter/));
  `findNearMissesForAllUnmatched()` gives the 3 closest stubs; `verify(3, postRequestedFor(…))`
  ([verifying](https://wiremock.org/docs/verifying/)). Sequences are Scenarios, a global named state
  machine (`inScenario("retry").whenScenarioStateIs(STARTED).willSetStateTo("failed-once")`,
  [stateful](https://wiremock.org/docs/stateful-behaviour/)), which concurrent callers race on
  (inferred). Faults: fixed and random delays, `EMPTY_RESPONSE`, `CONNECTION_RESET_BY_PEER`, …
  ([faults](https://wiremock.org/docs/simulating-faults/)).
- **Pact.** A consumer test's mocks are written to a pact file, and provider verification replays
  each request against the real provider, comparing "the minimal expected response"
  ([how it works](https://docs.pact.io/getting_started/how_pact_works)); strict on requests,
  type-based on responses (`like`, `eachLike`), extra fields ignored
  ([matching](https://docs.pact.io/getting_started/matching)). A fake is a claim that gets checked.
- **Polly.js.** `recordIfMissing` defaults to `true`, so a miss goes live; `matchRequestsBy` includes
  `body` and `order` (numbering identical requests: identity + index); `expiresIn` with
  `expiryStrategy` `warn`/`error`/`record` ages recordings
  ([configuration](https://github.com/Netflix/pollyjs/blob/master/docs/configuration.md)).
- **`responses` / `httpmock`.** `responses`: unmatched raises `ConnectionError` listing each
  non-match's reason; of several matches the first is popped, so the last repeats; `OrderedRegistry`
  is global order; `assert_all_requests_are_fired`
  ([registries.py](https://github.com/getsentry/responses/blob/master/responses/registries.py)).
  `httpmock`: exact URLs beat regexps, and "regexp responders are tested in the order they are
  registered"; `Then`, `Times`, `Delay` ([docs](https://pkg.go.dev/github.com/jarcoal/httpmock)); a
  miss that another method or URL would match says so ([error.go](https://github.com/jarcoal/httpmock/blob/v1/internal/error.go)).

## 2. LLM and agent frameworks

- **pydantic-ai.** `Agent.override(model=…)` swaps the model in a context manager without touching
  app code. `TestModel` "calls all tools in the agent, then return[s] either plain text or a
  structured response", generating schema-valid arguments procedurally. `FunctionModel(fn)` takes
  `fn(messages: list[ModelMessage], info: AgentInfo) -> ModelResponse`, a responder over the whole
  history. `capture_run_messages()` records the exchange; `models.ALLOW_MODEL_REQUESTS = False`
  forbids any real request; `dirty-equals` (`IsNow`) and `inline-snapshot` handle volatile and long
  values ([docs](https://pydantic.dev/docs/ai/guides/testing/)).

  ```python
  models.ALLOW_MODEL_REQUESTS = False
  with capture_run_messages() as messages:
      with weather_agent.override(model=TestModel()):
          await run_weather_forecast([(prompt, user_id)], conn)
  ```
- **Vercel AI SDK.** `ai/test` exports `MockLanguageModelV4` (V2 in SDK 5), `mockValues`,
  `mockId`, and `simulateReadableStream({ chunks, initialDelayInMs, chunkDelayInMs })`
  ([docs](https://ai-sdk.dev/docs/ai-sdk-core/testing),
  [reference](https://ai-sdk.dev/docs/reference/ai-sdk-core/simulate-readable-stream)). `doGenerate`
  is a function, a single result, or an array read as `doGenerate[this.doGenerateCalls.length - 1]`,
  so **by global call order**; each call's options are pushed to `doGenerateCalls`
  ([source](https://github.com/vercel/ai/blob/main/packages/ai/src/test/mock-language-model-v4.ts)).
- **LangGraph / LangChain.** Compile per test with a fresh `MemorySaver`; call one node via
  `compiled_graph.nodes["node1"].invoke(state)`; run a slice with `update_state(…, as_node="node1")`
  then `invoke(None, …, interrupt_after="node3")` ([docs](https://docs.langchain.com/oss/python/langgraph/test));
  resume an `interrupt` with `Command(resume=…)` on the same `thread_id`
  ([interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts)). The fake,
  `GenericFakeChatModel(messages=iter([...]))`, is ordered
  ([source](https://github.com/langchain-ai/langchain/blob/master/libs/core/langchain_core/language_models/fake_chat_models.py)).
- **OpenAI Agents SDK (`agents.testing`).** `ScriptedModel(steps)`: a step is a `ModelStep`
  (`output`, `usage`, `error`, `responder`, `stream_events`), a dict, an output list or an exception;
  `ModelStep.respond(fn)` derives the result from the recorded `ModelCall` (instructions, input,
  tools, output schema). Steps pop FIFO; an empty queue raises `UnexpectedModelCall`;
  `assert_complete()` raises `UnconsumedModelSteps`; `calls` are deep-copied snapshots
  ([model.py](https://github.com/openai/openai-agents-python/blob/main/src/agents/testing/model.py)).
  `scripted_sandbox_session([{"method": "exec", "match": lambda call: call.args == ("pwd",),
  "result": ExecResult(...)}])` scripts sandbox calls; a wrong method or rejecting matcher raises
  rather than skipping ahead ([sandbox.py](https://github.com/openai/openai-agents-python/blob/main/src/agents/testing/sandbox.py)).
  It omits "test-runner integration, implicit timeouts, and concurrency helpers"
  ([testing](https://openai.github.io/openai-agents-python/testing/)).
- **Mastra.** Experiment tool mocks, **by `toolName`**, with `args`/`output` checked against the
  tool's schemas; the model stays live; workflow mocks are "to follow"
  ([blog](https://mastra.ai/blog/introducing-experiment-tool-mocks)).
- **Claude Agent SDK (Python).** `claude_agent_sdk.testing` holds only
  `run_session_store_conformance` ([source](https://github.com/anthropics/claude-agent-sdk-python/tree/main/src/claude_agent_sdk/testing));
  `Transport` is public but no fake ships ("no fake transport, no recorded-session fixture",
  [issue](https://github.com/overwirehq/claude-code-telegram/issues/234)).

## 3. Record and replay

- **vcrpy.** Modes `once` (default), `new_episodes`, `none` (replay only, any new request errors),
  `all` ([usage](https://vcrpy.readthedocs.io/en/latest/usage.html)); default matching ignores the
  body, where the prompt lives ([configuration](https://vcrpy.readthedocs.io/en/latest/configuration.html)).
- **Where cassettes are used well.** pydantic-ai uses them for provider adapters only, scrubbed in
  `before_record_request`, with `--strict-vcr-cassette-usage` failing a partly played cassette
  ([conftest.py](https://github.com/pydantic/pydantic-ai/blob/main/tests/conftest.py)).
- **LangSmith.** `LANGSMITH_TEST_CACHE=tests/cassettes`, checked in for CI
  ([docs](https://docs.langchain.com/langsmith/pytest)); HTTP-level, it silently wrote nothing for
  `ChatVertexAI` ([#1716](https://github.com/langchain-ai/langsmith-sdk/issues/1716)).
- **Trade-offs.** For: real model text after one paid run; catches adapter regressions. Against:
  bound to a transport; stale when the prompt changes unless bodies match, and brittle to every
  prompt edit when they do; one stochastic sample frozen as "the" answer; secrets unless scrubbed;
  and a recorded happy path reaches none of the error branches a scripted fake reaches in one line.

## 4. How each addresses a fake

| System | Address | Order under concurrency | Unmatched call |
| --- | --- | --- | --- |
| Temporal TS | activity name; args in fake code | deterministic by history | real code if registered, else error |
| Inngest | step id (hashed) | by id; handlers lazy, cached | `step.run` runs for real; pauses stop the run |
| Cloudflare | step name + 1-based index | by name/index | runs for real |
| Step Functions Local | state name + invocation number | unpredictable in Map unless `maxConcurrency: 1` | calls the real service |
| Temporal Go | activity/child name + arg matchers; first registered match with calls left | deterministic by history | real code if registered; mocked name, wrong args: fail with closest call |
| Camunda CPT | job type, all jobs of it | engine order; mock is stateless | job waits; blocking assertion times out |
| Conductor test API | task ref name → list, popped in order | by ref name | run stops, returns RUNNING; leftovers unchecked |
| Dagster | resource key (DI) | n/a | the real resource |
| Airflow `dag.test` | task id regex (`mark_success_pattern`) | serial | runs for real |
| Durable Functions (Moq) | activity name + input predicate | n/a (called directly) | Moq default (null) |
| nock | host + path (+ body); consumed per interceptor | per URL, in definition order | throws "No match"; `disableNetConnect` for hosts |
| MSW | route; first in list, `use()` prepends | stateless handlers; `once` consumed | `warn` (default) or `error` |
| WireMock | request pattern; priority, then newest | Scenarios: global state, races | 404; JUnit ext fails test; near misses |
| `responses` / `httpmock` | URL (+ matchers); httpmock: exact before regexp, regexps by registration | per URL in order | `ConnectionError` / `ConnectionFailure` with suggestion |
| Polly.js | method + URL + body + order among identical | identity + index | `recordIfMissing` (default): goes live |
| AI SDK | global call index | global order | array: `undefined`; function: whatever it returns |
| OpenAI `ScriptedModel` | global FIFO, optional matcher | global order | `UnexpectedModelCall` |
| pydantic-ai `FunctionModel` | responder over full history | responder decides | responder decides |

## Patterns that transfer to awf

- **Swap at the author surface, keep awf's orchestration real.** A test `run(workflow, args)` with
  scripted agents, decisions and sandboxes. Temporal, Durable Task and Cloudflare show real
  orchestration plus fake leaves catches the most; pydantic-ai's `override` shows the swap need not
  touch workflow code. Avoid a hand-mocked context (Moq style): it re-implements `parallel` and
  deadlines per test and tests neither.
- **Address by agent `key`, FIFO per key, never global order.** Cloudflare's `{name, index}`,
  Inngest's step id and Step Functions' state-plus-invocation survive concurrency; the AI SDK's
  array and `ScriptedModel`'s queue do not. Conductor's `taskRefToMockOutput` is a per-key list,
  Polly's `order` the same index. Keys must be unique across kinds (sdk-go#887).
- **A script entry is an outcome, not a transcript.** `answered` with a value checked against the
  turn's schema (as STRICT `fieldValidationMode` and Mastra check mocks), or any of `unanswered`,
  `blocked`, `timed-out`, `failed`, `cancelled` in one line, so every branch is cheap: the outcome
  kinds are awf's fault vocabulary (WireMock's faults, `thenThrowBpmnError`, `replyWithError`). Also
  accept a responder `(call) => outcome`, as `FunctionModel`, `ModelStep.respond` and Go's function
  `Return` do, for logic that depends on the prompt.
- **Strict by default.** An unscripted turn fails with the call attached (`UnexpectedModelCall`,
  vcrpy `none`, WireMock's JUnit default); leftover script fails the test (`assert_complete`,
  `AssertExpectations`, nock `isDone`, `assert_all_requests_are_fired`). Never fall through to a
  live agent (Step Functions' "HybridPath", Inngest's `step.run`, Polly's `recordIfMissing`), and
  never stall: Conductor returns a RUNNING workflow, Camunda waits out an assertion timeout. Only a
  test's own entries count as leftovers; shared defaults are exempt (nock `optionally`, testify
  `Maybe`, MSW handlers).
- **Name the near miss.** The failure lists the closest scripted keys and why each missed
  (testify's "closest call", WireMock near misses, `responses`' reasons, `httpmock`'s "despite").
- **Layer precedence.** Shared defaults plus per-test overrides is the norm: MSW's `use()` prepends,
  WireMock ranks by priority then newest. Exact-before-pattern matches `httpmock`, but every surveyed
  library resolves two matching patterns by order or priority; none errors. Erroring is sound within
  one layer only; a test's entry must beat a shared default by layer.
- **Record every call as a detached snapshot.** Key, runtime, prompt, schema, deadline, virtual
  start and end, outcome. Assert on that list (`ScriptedModel.calls`, `doGenerateCalls`,
  `capture_run_messages`, Go's listeners), not on spies; snapshots (`inline-snapshot`) fit prompts.
- **Report which outcomes the suite exercised.** Camunda's `hasNotActivatedElements` and coverage
  report ("identify untested paths") translate to: per agent key, which outcome kinds any test
  scripted. `review` never `timed-out` is the untested branch.
- **Virtual time that skips when everything waits.** Temporal's auto-skip, without its server
  binary, seconds of startup, or the PHP SDK's locked-by-default trap. Temporal Go does it in
  memory: it skips only at `runningCount == 0`, and `After(d)` holds a mock for `d` of workflow
  time, as Conductor's `executionTime` does; so a scripted turn declares its duration. Add a
  wall-clock idle limit (Go's `SetTestTimeout`) so a stuck test fails rather than hangs.
- **Check fakes against reality, Pact style.** Every scripted `answered` value validates against the
  turn's schema; recorded real answers can go through the same check; Polly's `expiresIn` is the
  model for ageing such fixtures.
- **Decisions scripted like turns**, returning a probability vector, so a low-confidence branch is
  one line.
- **Replay fixtures from run records, not HTTP.** A finished run already records each turn's key,
  prompt and outcome; converting that into a script gives cassette-like fixtures without transport
  coupling. Key them by prompt hash so a prompt edit shows.
- **In-process, sub-second, no container.** Testcontainers (Restate), CI-only timeouts
  (Cloudflare) and worker startup (Temporal) are the most-reported complaints; a test beside the
  workflow should run under plain `bun test`.

## Open questions

- Where does it live? Boundary 6 lets `examples/` import only the author surface and pure
  libraries, but a scripted `run` needs awf's orchestration: either that core is pure enough for
  contract, or a testing entry point needs its own boundary rule. A published seam; decide it first.
- Does the fake replace the harness (the run goes through the real engine, run directory and
  control plane, slower but faithful) or the author-surface objects (pure, fast, and blind to the
  engine)? Temporal chose the first, pydantic-ai the second.
- Keys in loops: per-key FIFO covers `review-${lens}`, but a responder may need the open options
  (runtime, sandbox) as a matcher, as `scripted_sandbox_session`'s `match` does. Is `match` needed
  from the start?
- Virtual time needs an injected clock; `engine/src/deadlines.ts` reads `Date.now()` directly in four
  places and waits on real timers. Where does the clock seam go?
- Sandboxes: script sandbox operations (OpenAI's method-level FIFO), or treat the sandbox as opaque
  and script only what the agent returns?
- Nested workflows: stub by workflow name (Temporal's child-workflow advice), or always run the
  child for real under the same script?
- Should turning a real run into a script be in scope now, or wait until a test needs it?
