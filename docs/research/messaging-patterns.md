# Messaging patterns for AWF's local control plane

## Recommendation

Do not adopt a message broker or actor runtime in Stage 2. Build the smallest engine-owned local RPC endpoint, but take five specific patterns:

1. **Akka Typed Reliable Delivery** for the acknowledgement model: transport or mailbox delivery is not processing; only the consumer can confirm processing.
2. **Erlang/OTP** for process monitoring and restart policy: peer death is an event, not a timeout inference.
3. **Cap'n Proto RPC** for capability-scoped routes: a reference both names an operation and grants only the right to invoke it.
4. **HashiCorp `go-plugin`** for owning a local subprocess: versioned startup handshake, startup deadline, explicit process lifecycle, and reattachment metadata.
5. **NATS Core/JetStream** as a semantics and test reference: request/reply correlation, immediate “no responders”, and separate persistence and consumer acknowledgements.

The first three are the important abstractions. `go-plugin` is the best implementation-shape reference for Stage 2. NATS becomes an implementation candidate only if AWF later needs multiple engines or remote brokers.

## The protocol AWF should expose

Use a local Unix-domain socket (with a Windows equivalent left behind a transport interface). The engine creates and owns the endpoint and the run record. A client connects with a protocol version plus an opaque, invocation-scoped capability. Filesystem permissions protect the socket, but authorization comes from the capability, not from knowing `runDir` and `callId`.

Every command should carry at least:

```text
messageId       stable idempotency/deduplication key
operationId     engine-owned operation identity
capability      opaque authority for one route and bounded actions
correlationId   request whose response or obligation this satisfies
causationId     message that caused this command, when different
deadline        absolute deadline, never an implicit infinite wait
protocolVersion wire compatibility
payload         runtime-decoded tagged union
```

Do not return one ambiguous `delivered` boolean. Record distinct transitions:

```text
submitted -> admitted -> offered -> observed -> processed/responded
                |           |           |
                |           |           +-- proved by harness evidence
                |           +-------------- scheduled for a safe continuation
                +-------------------------- authenticated and durably recorded

terminal alternatives: rejected | expired | peer_died | disconnected | cancelled | maybe_processed
```

`admitted` is a receipt from the engine, not evidence that a terminal agent saw the prompt. `observed` is harness-specific evidence that the message reached a model continuation or transcript. `processed/responded` is an application-level acknowledgement. A timeout after dispatch is not necessarily rejection: Akka's example deliberately reports `MaybeAccepted` because processing may have happened before confirmation was lost. [Akka explicitly says network/mailbox delivery is insufficient and requires `ConsumerController.Confirmed` only after processing](https://doc.akka.io/libraries/akka-core/current/typed/reliable-delivery.html).

## What to take from each project

### Akka Typed Reliable Delivery — closest acknowledgement model

Akka states the core rule directly: reliable delivery cannot be automatic because “fully processed” is a business-level fact; transfer over the network or delivery to a mailbox is not enough. Its consumer receives `ConsumerController.Delivery(message, confirmTo)` and sends `Confirmed` after processing. The controllers resend and deduplicate unconfirmed messages and apply consumer-driven flow control. A durable producer queue preserves unconfirmed work across a producer crash, but changes a producer-side confirmation to mean **stored**, not necessarily processed. Its timeout example returns `MaybeAccepted`, preserving uncertainty instead of lying. [Official reliable-delivery guide](https://doc.akka.io/libraries/akka-core/current/typed/reliable-delivery.html), [message-delivery semantics](https://doc.akka.io/libraries/akka-core/current/general/message-delivery-reliability.html).

Take:

- A typed acknowledgement level, not a success boolean.
- Consumer-issued processing confirmation after transcript/turn evidence exists.
- Stable message IDs, redelivery, deduplication, and backpressure.
- `maybe_processed` when confirmation times out after a dispatch could have run.

Do not take Akka as a dependency. It is a JVM actor runtime, the reliable-delivery module is documented as subject to change, and AWF already owns the relevant local engine and durable record.

### Erlang/OTP — liveness, monitors, and supervision

Erlang monitors are unidirectional and produce a correlated `{'DOWN', Ref, process, Pid, Reason}` event when the process exits; monitoring an absent process reports `noproc` immediately. Process aliases can be unguessable reply destinations and can be deactivated, after which later messages are dropped. [Official process and monitor semantics](https://www.erlang.org/doc/system/ref_man_processes.html). OTP supervisors separate observation from policy and bound restart intensity so a repeatedly failing child eventually escalates rather than looping forever. [Official supervision principles](https://www.erlang.org/doc/system/sup_princ.html).

Take:

- A per-session monitor reference and explicit `peer_died(reason)` transition.
- A session incarnation/epoch. Capabilities from a dead incarnation never authorize its replacement.
- Separate restart policy (`never`, `on_failure`, bounded attempts) from liveness detection.
- Revocable, opaque reply routes resembling process aliases.

Do not mistake process monitoring for delivery confirmation. A live process may be wedged or may accept input without beginning a turn. AWF still needs harness heartbeats/progress evidence and mandatory deadlines. Do not adopt Erlang distribution or supervision trees wholesale.

### Cap'n Proto RPC — granted routes as object capabilities

Cap'n Proto treats an interface reference as a capability: it both designates an object and confers permission to call it. New capabilities are initially held only by their creator, and the wire ID is scoped to the connection over which it was granted. On disconnect, capabilities served by that connection become disconnected; callers must reconnect and obtain new ones. [Official RPC protocol: distributed objects, security, and disconnects](https://capnproto.org/rpc.html).

Take:

- Replace ambient `send(agentName, ...)` with an opaque route granted by `Messaging.allow`.
- Bind each route to operation, source, destination, allowed verbs, expiry, session incarnation, and optionally a response obligation/use count.
- Give a request a private reply capability; correlation is then authority-bearing, not just a guessable string.
- Reject stale, cross-operation, closed, and over-scoped capabilities at admission.

Do not adopt Cap'n Proto RPC wholesale. Promise pipelining, distributed object tables, and three-party capability introduction are far beyond the local Stage 2 need. Copy the authority model into a small schema and state machine.

### HashiCorp `go-plugin` — local subprocess control-plane shape

`go-plugin` has the host launch a subprocess, read a one-line startup handshake from stdout, verify core/application protocol versions, then connect to the advertised local RPC address. Its client has a startup timeout, owns kill/cleanup, exposes explicit reattach configuration (`protocol`, `version`, address, PID), and can use checksums and TLS. [Protocol and handshake internals](https://github.com/hashicorp/go-plugin/blob/main/docs/internals.md), [client lifecycle and reattach source](https://github.com/hashicorp/go-plugin/blob/main/client.go), [architecture](https://github.com/hashicorp/go-plugin#architecture).

Take:

- Engine ownership of child process plus control connection.
- Explicit endpoint discovery and protocol-version negotiation.
- Startup timeout, process-exit channel, graceful-close deadline, forced termination fallback.
- Explicit reattach metadata rather than pretending reconnection is transparent.
- Explicitly paired brokered callback connections as an implementation analogue for granted routes, not ambient process reachability.

Do not copy the stdout handshake literally: terminal coding agents are not plugin RPC servers, and stdout belongs to their UI/transcript. Also, `go-plugin` calls its magic-cookie handshake a UX feature, not a security feature. AWF needs a cryptographically random operation capability; a shared static cookie is not authentication. [Official tutorial warning](https://github.com/hashicorp/go-plugin/blob/main/docs/extensive-go-plugin-tutorial.md#handshake).

### NATS Core and JetStream — acknowledgement vocabulary and failure tests

Core NATS request/reply uses a reply inbox and can return `no responders` immediately when no subscriber exists; that is better than waiting for a deadline, but it proves only subscription presence. Core delivery is at-most-once. JetStream adds persistence and at-least-once delivery: a publish acknowledgement means the server stored the message, while a consumer acknowledgement advances consumer state; absent acknowledgement causes redelivery. Its acknowledgement protocol also distinguishes retry now (`nak`), terminal non-retryable failure (`term`), and “still working” (`in-progress`), with a bounded maximum-delivery policy. [Official request/reply and no-responders docs](https://docs.nats.io/learn/core-nats/request-reply), [official Core versus JetStream semantics](https://docs.nats.io/concepts/jetstream), [official publishing semantics](https://docs.nats.io/learn/jetstream/publishing), [official acknowledgement semantics](https://docs.nats.io/learn/jetstream/acknowledgment).

Take:

- Unique reply subjects as the model for correlated private reply routes.
- Fast `no_listener`/`peer_gone` when known, while retaining a deadline for races and stalls.
- Separate “persisted by engine” from “acknowledged by consumer”.
- Explicit `retry`, `permanent_failure`, and `in_progress` outcomes; bounded redelivery of unacknowledged messages; consumer-side deduplication.

Do not embed `nats-server` for a single engine and its child processes. It adds another daemon, persistence layer, authentication system, and recovery protocol while still being unable to prove that a non-deterministic terminal agent observed a prompt. Core NATS alone would reproduce AWF's current false-success failure; JetStream would durably preserve it, not solve observation.

## Recovery rules

1. Persist admission before replying `admitted`.
2. The harness writes `offered` and `observed` evidence through the engine; it never edits the run record directly.
3. On connection loss, mark outstanding work `disconnected`, inspect the child process separately, and reconnect only to the same verified session incarnation.
4. On process death, close all incarnation-bound capabilities and resolve waits as `peer_died`; a restart creates a new incarnation.
5. Re-offer admitted but unprocessed messages with the same `messageId`. Consumers deduplicate; result settlement remains atomic.
6. Never retry a non-idempotent action under a new ID. If execution may have happened, surface `maybe_processed` for workflow policy to resolve.
7. Heartbeats report adapter/session progress, not generic process existence. A missed heartbeat is suspicion; process exit is fact; a deadline is the terminal workflow bound.

## Minimum conformance tests

- A successful socket write with no transcript observation never becomes `observed`.
- Kill the agent before offer, during offer, after observation, and after processing but before confirmation; each produces a distinct outcome.
- Duplicate `messageId` is processed at most once per session incarnation, including after engine restart.
- Wrong, stale, expired, closed, cross-operation, and wrong-verb capabilities are rejected.
- A crossing send atomically satisfies the earlier response obligation and creates the new one.
- Disconnect/reconnect cannot reuse a capability from the prior incarnation.
- Every request wait expires at its declared deadline; the post-dispatch case can report `maybe_processed`.
- Backpressure prevents an unresponsive agent from accumulating an unbounded inbox.

## Source checkout shortlist

Clone only the repositories worth source inspection into `~/dev/ref-repos`, outside AWF:

| Priority | Repository | Open first | Why |
| --- | --- | --- | --- |
| 1 | [`akka/akka-core`](https://github.com/akka/akka-core) | `akka-docs/src/main/paradox/typed/reliable-delivery.md`; `akka-actor-typed/src/main/scala/akka/actor/typed/delivery/` | Closest state machine for delivery versus processing confirmation |
| 2 | [`erlang/otp`](https://github.com/erlang/otp) | process/monitor docs; `lib/stdlib/src/supervisor.erl` | Death monitoring and bounded restart policy |
| 3 | [`hashicorp/go-plugin`](https://github.com/hashicorp/go-plugin) | `docs/internals.md`; `client.go`; `runner/` | Local child lifecycle, handshake, reconnect metadata |
| 4 | [`capnproto/capnproto`](https://github.com/capnproto/capnproto) | `doc/rpc.md`; `c++/src/capnp/rpc.capnp` | Capability-scoped routing and disconnect semantics |
| 5 | [`nats-io/nats-server`](https://github.com/nats-io/nats-server) and [`nats-io/nats.docs`](https://github.com/nats-io/nats.docs) | `server/`; request/reply and JetStream acknowledgement docs | Failure-semantics oracle; likely not an AWF dependency |
