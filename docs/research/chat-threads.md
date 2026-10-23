# Chat threads for runs: what to plug in, what to build

Research for [[032-run-coordinator|story 032]], first drafted as a run-thread story whose Q1–Q6 are cited below; the chat app it covers now lives outside awf. Checked 2026-10-22. Repositories were read at:

| Repository | Commit | Version |
| --- | --- | --- |
| `openclaw/openclaw` | `74ca496b` | `2026.10.5` in `package.json`; latest release `v2026.10.6` |
| `nanocoai/nanoclaw` (`qwibitai/nanoclaw` redirects here) | `27a0ef7` | `2026.10.1-rc.1` |
| `NousResearch/hermes-agent` | `8237c7f8` | latest release `v0.22.4` (2026-10-21) |
| `vercel/chat` | `5781d46` | `chat` 4.43.0 |

Claims about Slack, Claude Code, Codex and the durable-wait systems come from their official docs, linked
inline. "Unverified" means no primary source confirmed it.

## Recommendation

No existing system does what the story needs: a thread that outlives the run that opened it, with
awf's record as the source of truth. OpenClaw, NanoClaw and Hermes all have this feature, but they get
it by owning everything: sessions, memory, agents and the process that listens. Adopting one of them
would give awf a second record. So **plug in only at the chat-platform layer, and build the rest with
patterns copied from these systems.**

### (a) Chat platform adapter: depend on Vercel Chat SDK, behind an awf seam

Use `chat` with `@chat-adapter/slack` inside a provider package, the way sandbox providers sit behind
`@agentswf/sandbox`. The contract gets a small, pure platform seam: post, reply in thread, read a
thread since {ts}, and an inbound message carrying {platform, thread, author, ts, text}. Only the
Slack provider imports `chat`.

Why Chat SDK:

- It already does Socket Mode, retry dedup and thread IDs (`slack:{channel}:{thread_ts}`). It posts
  markdown, cards and streams, and reads history with pagination
  (`vercel/chat@5781d46:packages/adapter-slack/src/index.ts`, `apps/docs/content/docs/threads-messages-channels.mdx`).
- Socket Mode retries are routed like first deliveries and deduped by message id, "so
  missed-while-disconnected events recover" (`packages/adapter-slack/src/index.ts`, `startSocketMode`).
- `bot.thread("slack:C…:ts").post(…)` works from outside an inbound handler, which is what a run needs.
- NanoClaw made the same choice. Its channels go through a Chat SDK bridge, and it wrote its own
  SQLite `StateAdapter` in 269 lines (`nanocoai/nanoclaw@27a0ef7:src/channels/chat-sdk-bridge.ts`,
  `src/state-sqlite.ts`). That is the precedent for an awf state adapter that writes files.
- A second platform later is an adapter swap, not new code.

Where it fights awf's model, and what awf must do about it:

- **State.** Chat SDK wants a `StateAdapter` for subscriptions, locks, dedup, queues and thread state
  (`apps/docs/content/docs/state-adapters.mdx`). awf provides a file-backed one under its own
  directory. awf must not use `thread.setState` for anything it relies on: that state has a 30-day TTL
  and is not the record. The subject-to-thread map lives in awf's record.
- **Concurrency.** The default `drop` strategy throws `LockError` on a second message to a busy
  thread (`concurrency.mdx`). Set `queue`. Whether a reply interrupts a busy agent is awf's decision,
  not the adapter's.
- **`chat/workflow` `requestApproval`.** It needs Vercel Workflow SDK as its durable runtime
  (`approvals.mdx`). Don't use it. Copy its shape instead: an `approvers` list, an edit in place on
  resolve, and a `timedOut` result.
- **Runtime.** `chat` declares `node >=20`, and its test kit is built on Vitest (`testing.mdx`). Bun is
  unverified for `@slack/socket-mode`. Probe it before committing (M3 below). If it fails, the
  fallback is Bolt for JS 5.1.0 with the same seam, at the cost of writing dedup and history ourselves.
- **Churn.** The package went from 4.41.1 (NanoClaw's pin) to 4.43.0 within weeks. Pin it exactly.

### (b) The listener: awf owns it, as an operator-started service

Something must hold the Socket Mode connection. It must be awf's process, because it writes into run
records and starts runs. Make it `awf service` (name open), the resident process `ideas.md` already
asks for to run schedules later. Don't use OpenClaw's or Hermes' gateway as a sidecar. Both own the
session map and the agents, and that map is exactly what Q1 needs awf to own.

What to copy:

- **Catch up after sleep from the platform, not from retries.** Slack does not document what happens
  to Socket Mode events while no socket is open; its only statement is that you "may lose events
  until you establish a connection" ([Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode/)).
  HTTP retries end about 6 minutes after the first failure, or after 24 hours with Delayed Events
  ([Events API](https://docs.slack.dev/apis/events-api/)). So on start and on wake, the service reads
  every open thread with `conversations.replies` from the last ts it recorded. It dedups by message
  ts. OpenClaw does the same: "Admitted channel and group turns fetch a recent window from Slack,
  including after a Gateway restart" (`openclaw@74ca496b:docs/channels/slack/threads-and-sessions.md`).
- **Restart with bounded backoff, and fail fast on auth errors.** OpenClaw backs off from about 2 s to
  30 s, and invalid or revoked tokens fail fast (`docs/channels/slack/transports.md`).
- **One connection per app.** Slack may deliver each payload to any of up to 10 open connections
  ([Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode/)). Two machines running the
  service with one app would split events between them. One Slack app per host, as OpenClaw warns.
- **Rate limits.** An internal app keeps Tier 3 (50+ per minute) on `conversations.replies`. The 2025
  Tier 1 limit of 15 objects applies only to apps "commercially distributed outside of the
  Marketplace" ([changelog](https://docs.slack.dev/changelog/2025/05/29/rate-limit-changes-for-non-marketplace-apps/)).
  Socket Mode apps can't be listed in the Marketplace at all. That is fine for an operator's own app.

### (c) Durable wait, resume, and the thread-to-run map: awf owns it, as files

Every durable-wait system has the same four parts. There is a wait record, a correlation key, an
outside deliverer that writes the event durably and then wakes the run, and a timeout that resolves
to a value rather than an exception. awf can build all four on its run directory without a server.

What to copy:

- **Buffer early events (Cloudflare Workflows).** Events sent before the wait are "buffered and
  delivered when the Workflow reaches the `waitForEvent` step"
  ([Cloudflare](https://developers.cloudflare.com/workflows/build/events-and-parameters/)). Inngest
  documents the opposite, and it is a trap: "A matching event sent earlier will not resume this wait"
  ([Inngest](https://www.inngest.com/docs/features/inngest-functions/steps-workflows/wait-for-event)).
  awf: each thread gets an append-only inbox in the record. A wait scans it before blocking.
- **Start on a miss (Temporal Signal-With-Start).** "If a running Workflow with the given Workflow Id
  exists, it is Signaled. Otherwise, a new Workflow Execution starts"
  ([Temporal](https://docs.temporal.io/sending-messages)). Every other system loses a reply that arrives
  after the run ended. That is exactly the story's case 3, so the deliverer must start or continue a
  run on a miss.
- **Name the policy for a reply that arrives while the agent is busy (LangGraph "double texting").**
  The options are `reject`, `enqueue` (the default), `interrupt` and `rollback`
  ([LangSmith](https://docs.langchain.com/langsmith/double-texting)). awf: `enqueue` by default.
  `interrupt` waits on mid-turn delivery.
- **Use a reconstructible correlation key that is not a credential (Vercel Workflow hooks).** "A hook
  token ... is not an authentication mechanism"
  ([Vercel](https://workflow-sdk.dev/docs/api-reference/workflow-api/resume-hook)). awf keys on the
  platform thread (`slack:{channel}:{thread_ts}`), and trust comes from the sender check (Q5).
- **Put the deadline in the wait record**, so whichever process next touches the run can resolve the
  wait with `timedOut`. Temporal's `condition(fn, timeout)` returns `false`, and Inngest returns `null`.

What to reject:

- **Temporal and Vercel Workflow as dependencies.** They need deterministic replay of workflow code.
  A coding agent's turn cannot be replayed, and the history caps (Temporal terminates at 51,200 events
  or 50 MB, [limits](https://docs.temporal.io/cloud/limits)) buy awf nothing.
- **Inngest and LangGraph Platform as dependencies.** Each brings a server and a second record.
- **Holding a process open for days.** OpenClaw's `ask_user`, Hermes' `clarify` and NanoClaw's
  `ask_user_question` all keep a live tool call open. Hermes rewrites a card "orphaned by a gateway
  restart" to say re-ask (`hermes-agent@8237c7f8:website/docs/user-guide/messaging/slack.md`), so the
  wait does not survive a restart. That is acceptable for the short wait in Q1, but not for days.

**The thread map.** awf owns one map, from subject key to {platform thread, opening run, the runs that
answered, and per agent its native session id}. A reply is routed through it. That is where Q1 (b)
gets the session id to reopen.

### (d) Memory: the workflow's own files; awf owns only the subject-to-thread map

This was decided with the user. Every agent platform surveyed keeps memory as plain Markdown that the
agent edits: OpenClaw's `MEMORY.md` and `memory/YYYY-MM-DD.md`, NanoClaw's `memory/index.md`, and
Hermes' `MEMORY.md` and `USER.md` with character caps. None keeps memory in a database the agent can't
read. awf should give the workflow a state directory that persists between runs, and nothing more.
See [Subject memory layout](#subject-memory-layout).

### What most changes the story

- **Claude Tag already uses model (b).** "That thread binds to its own session from then on". The
  transcript is kept so "the session can pick up where it left off whenever someone replies", and the
  sandbox is released "a few minutes after" each turn and resumed in a fresh one
  ([how it works](https://claude.com/docs/claude-tag/concepts/how-it-works)).
- **NanoClaw does the same with an opaque continuation per session.** It resumes the Agent SDK
  session with `resume`, or Codex with `resumeThread`. It drops a transcript over 12 MB or older than
  14 days, so a cold resume isn't killed loading it (`docs/agent-runner-details.md`). That is an answer
  to M1 ready to copy: reopen when the session is small and fresh, otherwise fall back to (c).
- **Hermes does (c), and opens a thread per run by default.** A "continuable" cron job seeds its
  delivered brief into the thread's session, so "a reply in-thread continues with full context". It
  does not reopen the investigating session. A recurring job "opens a fresh thread per run"
  (`website/docs/user-guide/features/cron.md`). That is the empty-thread problem Q2 rejects.
- **Claude Code transcripts are swept after 30 days by default** (`cleanupPeriodDays`,
  [claude-directory](https://code.claude.com/docs/en/claude-directory)). A thread can outlive the
  session it needs. awf must either keep its own copy of the transcript or treat a missing session as
  the (c) fallback.

## How this maps to the story

| Story item | Answer from the survey | Main evidence |
| --- | --- | --- |
| Q1 What answers a late reply | (b), reopening the native session, while it is reachable and under a size and age cap. Otherwise (c), a responder run seeded with the thread, the record and the subject files. Never (a) for days. | Claude Tag (b); NanoClaw continuation rotation; Hermes continuable cron (c); Temporal Signal-With-Start |
| Q2 Thread per run or per subject | Per subject, keyed by a workflow-chosen key with aliases. Hermes' thread-per-run default is the counter-example. | Sentry fingerprint, PagerDuty `dedup_key`, Datadog `error.fingerprint`; Hermes cron |
| Q3 Memory | Decided: workflow files. awf keeps only the subject-to-thread map. | OpenClaw, NanoClaw, Hermes memory docs |
| Q4 Who listens | An operator-started awf service holding Socket Mode, through the Chat SDK Slack provider. It catches up with `conversations.replies` on wake. | Slack Socket Mode docs; OpenClaw transports and history; Chat SDK socket retry routing |
| Q5 Who may speak | An allowlist of Slack user IDs, denying everyone by default. Others are fenced as untrusted. Bot and own messages are ignored. Slack Connect users are external. | Hermes `SLACK_ALLOWED_USERS` (deny if none set); OpenClaw `users` and `wrapExternalContent`; NanoClaw `sender_scope`; Chat SDK `approvers`; Slack Connect docs |
| Q6 What a reply can make the run do | The workflow decides the tools. A few stop or close commands are handled by awf itself, never by the agent. Tools can differ by sender. | OpenClaw gateway-local `/acp close` and `toolsBySender`; Hermes `!stop` in threads; NanoClaw host-side approvals |
| M1 Reopen claude or codex days later | From the docs: both resume by id from any cwd on the same machine. Claude needs v2.1.223+; codex prompts for the cwd. A compacted Claude session reloads only the summary and later turns. The cache is cold, so the whole prefix is written again. Still needs a live probe for "does it still know". | [sessions](https://code.claude.com/docs/en/sessions); [prompt caching](https://code.claude.com/docs/en/prompt-caching); [codex CLI](https://developers.openai.com/codex/cli/reference) |
| M2 Socket Mode on a sleeping laptop | Slack doesn't document queueing while disconnected. Assume events are lost and backfill from `conversations.replies`. This still needs a probe: sleep for 10 minutes, then 2 hours, then compare. | [Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode/); [conversations.replies](https://docs.slack.dev/reference/methods/conversations.replies/) |
| M3 (new) Chat SDK on Bun | Socket Mode, posting and history under Bun. If any fails, use Bolt. | `chat` `engines: node >=20`; Bun compatibility is unverified |

## Subject memory layout

The user decided on one thread per subject, a finding such as `checkout-api/5xx`, not per run. Systems
that group repeated events all split a **mutable summary** from an **append-only occurrence log**,
joined by a key the reporter can choose.

### How grouping systems model "one issue, many events"

- **Sentry.** Events with the same fingerprint form an issue
  ([event grouping](https://docs.sentry.io/concepts/data-management/event-grouping/)).
  - The SDK can set the fingerprint, or extend the default with `{{ default }}`
    ([SDK fingerprinting](https://docs.sentry.io/platforms/javascript/usage/sdk-fingerprinting/)).
  - One issue can hold many hashes, and a merge moves fingerprints under one issue
    ([grouping internals](https://develop.sentry.dev/backend/application-domains/grouping/),
    [merging](https://docs.sentry.io/concepts/data-management/event-grouping/merging-issues/)).
  - The issue carries `count`, `userCount`, `firstSeen`, `lastSeen`, `status` and `substatus`
    ([issue API](https://docs.sentry.io/api/events/retrieve-an-issue/)).
  - After a plain resolve, a new event is a regression
    ([states](https://docs.sentry.io/product/issues/states-triage/)).
  - Splits lose data because events are immutable. "The system does not cope particularly well with
    merges and splits."
- **PagerDuty.** The client sets `dedup_key`. While an alert is open, later triggers append to its log.
  After resolve, the same key opens a new alert
  ([send alert event](https://docs.pagerduty.com/developer/send-alert-event),
  [event management](https://docs.pagerduty.com/incident-management/incidents/event-management)).
  Fuzzy grouping into incidents happens one level up.
- **Datadog Error Tracking.** Errors are grouped by service, error type, a normalized message and the
  top stack frame. `error.fingerprint` overrides this "as-is"
  ([error grouping](https://docs.datadoghq.com/error_tracking/error_grouping/)).
  - States are For Review, Reviewed, Ignored and Resolved. Resolved is set automatically after 14 days
    without the error ([issue states](https://docs.datadoghq.com/error_tracking/issue_states/)).
  - A recurrence after resolve goes back to For Review, tagged Regression
    ([regression detection](https://docs.datadoghq.com/error_tracking/regression_detection/)).
  - Multi-alert monitors key on group-by tag values
    ([monitors](https://docs.datadoghq.com/monitors/configuration/)).

### How agent platforms lay out memory files

- **OpenClaw.** `MEMORY.md` holds curated durable facts and is loaded at session start.
  `memory/YYYY-MM-DD.md` holds daily working notes that are searched, not injected (`docs/concepts/memory.md`).
- **NanoClaw.** `memory/index.md` holds a short "Core Memory" plus a map of linked concept files, and
  is always loaded. Detail goes in linked files (`docs/memory.md`).
- **Hermes.** `MEMORY.md` is capped at 2,200 characters and `USER.md` at 1,375. When a write would
  overflow, it errors and the agent consolidates
  (`website/docs/user-guide/features/memory.md`).

The common pattern is a small index that is always loaded and points to detail files that are read
when needed.

### Recommended layout

In the workflow's state directory, which the workflow owns:

```text
subjects/
├─ index.md                      # one line per open subject: key, title, status, last seen
└─ checkout-api--5xx/            # directory name is the key, slug-safe
   ├─ subject.md                 # the mutable summary
   ├─ occurrences.jsonl          # append-only, one line per sighting
   └─ notes.md                   # investigation: hypotheses, evidence, links, conclusions
```

`subject.md` front matter holds `key`, `aliases`, `title`, `status`
(`open | resolved | ignored`), `first_seen`, `last_seen`, `count` and `last_run`. The body describes
what it is, where it shows up, and the current conclusion. Each line of `occurrences.jsonl` holds
`at`, `run`, `where` (service, environment, query or monitor link), `what` (a one-line summary), the
numbers seen (rate, count, baseline) and `sample` (a log line or trace id).

Rules taken from the systems above:

- **The agent proposes the key, normalized, and keeps aliases.** A later run that finds the same
  problem under a new key adds an alias instead of a new subject. That is Sentry's GroupHash and
  merge. Similarity matching may suggest an existing subject for a new key, but it never splits one.
- **Occurrences are append-only. The summary is the only file rewritten.** Totals in `subject.md` are
  a cache of the log, so they can be rebuilt from it.
- **Decide on purpose what happens after resolve.** Sentry and Datadog reopen the same issue as a
  regression; PagerDuty opens a new one. For a thread per subject, reopening and posting into the same
  thread fits better.
- **Keep the always-loaded index bounded**, as Hermes does with its caps. Old resolved subjects drop
  out of `index.md` but stay on disk.
- **The thread binding is not in these files.** awf's map holds subject key to thread. The workflow
  passes the key when it posts, and awf finds or opens the thread.

## OpenClaw

**What it is.** A personal-assistant gateway with more than 20 channels. It is one Node process that
owns sessions, memory, cron, agents and channel plugins. It runs Claude Code, Codex and others through
ACP, or uses them as CLI backends.

**Mechanism.**

- **Session keys.** A channel session is keyed `agent:{agentId}:slack:channel:{channelId}`, and a
  thread appends `:thread:{threadTs}`. A bot-posted root that is expected to start a thread is seeded
  into the thread key, so the root and its replies share one session.
- **Mention gating.** `requireMentionInBotThreads: false` allows unmentioned replies in threads the
  bot started (`docs/channels/slack/threads-and-sessions.md`, `access-control.md`).
- **Session lifetime.** Sessions never reset by default; compaction manages context. Idle or daily
  resets are opt-in (`docs/concepts/session.md`).
- **History after restart.** A new thread session fetches the last 20 thread messages, and after a
  restart a recent window is read from Slack. "There is no separate OpenClaw message archive"
  (`threads-and-sessions.md`).
- **ACP binding.** A thread can be bound to an ACP session (Claude Code, Codex) whose follow-ups route
  to it, and `resumeSessionId` replays the harness history through `session/load`. Built-in thread
  binding covers Discord and Telegram, not Slack (`docs/tools/acp-agents/bindings.md`, `delivery.md`).
- **Who may speak.**
  - DMs: `dmPolicy` is `pairing` by default. A pairing code is 8 characters, expires after 1 hour, and
    at most 3 can be pending (`docs/channels/pairing.md`).
  - Channels: `groupPolicy` allowlist keyed by channel ID, plus a per-channel `users` allowlist and
    `toolsBySender`.
  - Socket Mode senders count as verified, while relayed senders stay "asserted".
  - Outside content is wrapped in `<<<EXTERNAL_UNTRUSTED_CONTENT id="…">>>` markers with a random
    id, and spoofed markers are stripped (`src/security/external-content.ts`).
- **Asking a person.** `ask_user` holds the turn open. A plain-text reply answers it when the replier's
  permissions match the creator's (`docs/tools/ask-user.md`).
- **`openclaw mcp serve`.** It exposes routed conversations to an outside Claude Code or Codex over
  MCP (`events_wait`, `messages_send`). But "when the client disconnects, the bridge exits and the
  live queue is gone" (`docs/cli/mcp/serve.md`).

**Taken.**

- Catching up from Slack history after a restart, instead of trusting redelivery.
- Gating on stable user IDs, not names; name matching is a `dangerously…` flag.
- Fencing untrusted content with random-id markers, and stripping look-alike markers from the input.
- Handling a few thread commands in the gateway, never as prompts to the agent (`/acp close`, `/status`).
- One Slack app per gateway when using Socket Mode.

**Rejected.**

- The gateway as a sidecar. Its session map, memory and transcripts would be a second record, and
  the thread-to-session map is the thing awf must own.
- Never resetting sessions plus compaction as the long-thread strategy. It works for one assistant,
  but a run's investigation needs a record the run owns.

**Unmined.**

- `docs/channels/slack/setup.md` and `manifest-and-scopes.md`, a full app manifest to start from.
- Relay mode (`transports.md`): one trusted ingress forwarding typed events to several gateways, if
  awf ever runs on more than one host.
- `docs/automation/cron-jobs/`: delivery failure as its own status, separate from run failure.

## NanoClaw

**What it is.** A small, fork-and-customize alternative to OpenClaw. A host process routes channel
messages into per-session Docker containers that run the Claude Agent SDK (or Codex, OpenCode,
Cursor). Channels are installed on demand by skills. The canonical repository is now
`nanocoai/nanoclaw`.

**Mechanism.**

- **Routing.** A channel adapter returns {platform channel id, platform thread id}. The host maps
  those to agent group and session. `session_mode` is `shared`, `per-thread` or `agent-shared`
  (`docs/architecture.md`, `docs/isolation-model.md`).
- **Two SQLite files per session, each with one writer.** The host writes `inbound.db` and the
  container writes `outbound.db`. It uses `journal_mode=DELETE`, not WAL, because WAL coherency does
  not cross VirtioFS mounts.
- **Resume.** The agent runner stores one opaque `continuation` per provider: the Claude session id,
  or the Codex thread id. It resumes with it, and rotates it when the transcript passes 12 MB or
  14 days (`docs/agent-runner-details.md`). Containers are killed when idle and respawned on the next
  message.
- **Who may speak.** `unknown_sender_policy` is `strict` (drop), `request_approval` (ask an admin) or
  `public`. `sender_scope` is `all` or `known`. Approvals go to a scoped admin's DM
  (`docs/db-central.md`, `architecture.md`).
- **Asking a person.** `ask_user_question` blocks the tool call and polls `inbound.db` for a row with
  the matching `questionId`. The default timeout is 300 s.
- **Memory.** `groups/{folder}/memory/`, with an always-loaded `index.md` (`docs/memory.md`).
- **Schedules.** `ncl tasks create --recurrence`, each task in its own system session, with optional
  script gates that skip the agent when there is no work (`docs/scheduled-tasks.md`).

**Taken.**

- Chat SDK as the platform layer, with an own `StateAdapter` (`src/state-sqlite.ts`).
- An opaque continuation per agent and provider, with a size and age cap that falls back to a fresh
  session.
- One writer per file across a sandbox mount. This matches awf's run-directory discipline.
- Unknown senders: drop, ask or allow, as an explicit policy.
- A script gate before waking the agent. The watcher's "most runs find nothing" is this.

**Rejected.**

- Customization by editing a fork. awf is a library with seams.
- An SQLite pair per session as the IO channel. awf already has its wire and run directory.

**Unmined.**

- `docs/gateway-seam.md` and the credential gateway: agents never hold raw keys, which bears on
  awf's M3 (an agent acting as the operator).
- `src/channels/chat-sdk-bridge.ts` (1,304 lines): the real cost of wrapping Chat SDK.

## Hermes Agent

**What it is.** Nous Research's Python agent, with a messaging gateway (Slack through `slack-bolt` in
Socket Mode), cron, memory and many tools. The gateway is a daemon.

**Mechanism.**

- **Session keys.** Keys are deterministic, and a group thread is
  `agent:main:{platform}:group:{chat_id}:{thread_id}`, shared by all participants. Gateway
  conversations never reset on idle; `/new` resets (`website/docs/user-guide/sessions.md`).
- **Continuable cron.** With `mirror_delivery` or `attach_to_session`, a cron job's delivered brief is
  written into the thread's session as a labelled user turn (`[Cron delivery: {task}]`), so a reply
  in the thread continues with the brief in context. On thread-capable platforms each run opens its
  own thread (`website/docs/user-guide/features/cron.md`).
- **Cron execution.** The gateway ticks every 60 s, and each job runs in a fresh, isolated session.
  Delivery failure is a separate status, `delivery_failed`.
- **Who may speak.** Per-platform allowlists (`SLACK_ALLOWED_USERS`), DM pairing, or a global
  allow-all. "If no allowlists are configured … all users are denied"
  (`website/docs/user-guide/security.md`).
- **Asking a person.** `clarify` renders buttons and expires on `agent.clarify_timeout`. A card
  orphaned by a restart tells the user to re-ask.
- **Memory.** Capped `MEMORY.md` and `USER.md`, injected as a frozen snapshot at session start.

**Taken.**

- Deny by default when no allowlist is set.
- Seeding a delivered post into the thread's conversation as a labelled turn. This is the minimum
  behind Q1 (c).
- `!cmd` in threads, because Slack blocks slash commands in thread replies (`messaging/slack.md`).
  Any stop or close command awf supports in a thread must be plain text.
- Memory caps that force consolidation.

**Rejected.**

- A thread per run for recurring jobs: the empty-thread problem Q2 names.
- Waits held in process memory.

**Unmined.**

- `website/docs/developer-guide/gateway-session-lifecycle.md` and `cron-internals.md`: how cron
  workers survive a gateway restart (`systemd-run --user --scope`).

## Vercel Chat SDK

**What it is.** A TypeScript library (`chat`) with adapters for Slack, Teams, Google Chat, Discord,
Telegram, GitHub, Linear and others, and pluggable state (memory, Redis, Postgres). MIT licensed.

**Mechanism.**

- **Threads.** A `Thread` has `post`, `subscribe`, `messages` / `allMessages` (paginated history) and
  `schedule`. Thread ids look like `adapter:channel:thread`. Subscriptions live in the state adapter
  and route every later message to `onSubscribedMessage`.
- **Messages.** A message carries `author.userId`, `isBot` and `isMe`
  (`apps/docs/content/docs/threads-messages-channels.mdx`).
- **Slack transports.** Webhook mode, Socket Mode, or socket forwarding: a short-lived listener acks
  events and forwards them to a webhook (`packages/adapter-slack/README.md`). Event ids are recorded
  so redeliveries can be dropped, and socket retries are routed like first deliveries
  (`packages/adapter-slack/src/index.ts`).
- **Concurrency.** `drop` (the default), `queue`, `debounce`, `burst` or `concurrent`, each with a
  per-thread lock (`concurrency.mdx`).
- **Durable approvals.** `requestApproval` in `chat/workflow`, on Vercel Workflow SDK, with
  `approvers`, `timeout` and an edit in place on resolve (`approvals.mdx`).
- **Testing.** `@chat-adapter/tests` provides mock adapter, state and message factories for Vitest.

**Taken.**

- As the dependency for layer (a), inside a provider.
- `approvers`, and an edit in place on resolve that leaves an audit line and stops stale clicks.
- An explicit concurrency strategy per thread.

**Rejected.**

- Its state as a record: thread state has a 30-day TTL.
- `chat/workflow` and Workflow SDK.
- `@chat-adapter/tests` as awf's test surface. It is Vitest-specific. `awf test` should script
  replies at the awf seam: "a reply at turn N, or none".

**Unmined.**

- `packages/state-memory/src/index.ts` (323 lines), the reference for a file-backed state adapter.
- Streaming (`streaming.mdx`) through Slack's native `chat.startStream`, for posting an agent's
  progress into the thread.

## Slack platform

**Mechanism.**

- **Socket Mode.** Events come only over the WebSocket. Each one is acked by `envelope_id`. There can
  be up to 10 connections, and any one may receive a payload. It needs an app-level `xapp-` token
  with `connections:write`, and Socket Mode apps cannot be in the Marketplace
  ([Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode/)).
  - Slack's SDKs read `retry_attempt` and `retry_reason` on the envelope, though the narrative docs
    don't mention them
    ([python SDK](https://docs.slack.dev/tools/python-slack-sdk/reference/socket_mode/request.html)).
  - Whether events queue while nothing is connected is undocumented.
- **HTTP Events API.** A 2xx is required within 3 s. There are 3 retries: immediately, after 1 minute,
  after 5 minutes. Hourly retries for 24 hours are opt-in, and events more than 2 hours late are
  otherwise not delivered. Subscriptions are disabled at 95% failures in 60 minutes, for apps above
  1,000 events an hour ([Events API](https://docs.slack.dev/apis/events-api/)).
- **`conversations.replies`.** Needs `channels:history` / `groups:history`. It is Tier 3, with
  `oldest`, `latest` and a cursor
  ([reference](https://docs.slack.dev/reference/methods/conversations.replies/)).
- **Agent surfaces.** Since 2026-06-30, new apps get only the Agent messaging experience in DMs, and
  `agents.sessions.setStatus` replaces `assistant.threads.setStatus`
  ([changelog](https://docs.slack.dev/changelog/2026/06/30/agent-messages-tab/),
  [agent updates](https://docs.slack.dev/changelog/2026/08/20/agent-updates/)). Streaming with task and
  plan chunks works in channel threads
  ([chat.startStream](https://docs.slack.dev/reference/methods/chat.startStream/)).
- **Message metadata.** `{event_type, event_payload}` on `chat.postMessage` is visible to every
  workspace member, and is read back with `include_all_metadata` on `conversations.history`
  ([metadata](https://docs.slack.dev/messaging/message-metadata/)). Whether `conversations.replies`
  returns it is unverified.
- **Senders.** Bot posts carry `bot_id`. Slack Connect delivers messages from external teams, and
  "there is no single property to substantiate if the user is external"
  ([Slack Connect](https://docs.slack.dev/apis/slack-connect/)).

**Taken.**

- Socket Mode for a laptop or a host without a public URL.
- Catching up with `conversations.replies` and deduping by ts.
- An allowlist of user IDs. Ignore our own `bot_id`, and never trust channel membership.
- Tag the opening post with metadata `{event_type: "awf_subject", event_payload: {workflow, key}}`, so
  the map can be rebuilt from Slack in an emergency. Metadata is public to the workspace, so put no
  secrets in it.

**Rejected.**

- The Agent DM surface for the watcher: the story wants channel threads.

**Unmined.**

- Delayed Events, if awf ever runs HTTP mode on a server.
- `agent_session_stopped`, a user's stop button, as a stop signal for a run.

## Durable wait and resume

**What they are.**

- **LangGraph:** `interrupt` and `Command({resume})`, with a checkpointer, keyed by `thread_id`.
- **Temporal:** signals and updates, `condition(fn, timeout)`, Signal-With-Start.
- **Inngest:** `step.waitForEvent` with `match` / `if`.
- **Cloudflare Workflows:** `waitForEvent` and `sendEvent`.
- **Vercel Workflow SDK:** `createHook` and `resumeHook`, with a token.

Details and sources are under [(c)](#c-durable-wait-resume-and-the-thread-to-run-map-awf-owns-it-as-files).

Two more details:

- **LangGraph** re-runs the whole node on resume, and matches multiple interrupts in one node by
  index ([interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts)). That is the same
  constraint awf's `--continue --from-stage` already accepts: idempotent work before the wait.
- **Vercel's Local World** keeps runs in a `.workflow-data/` directory
  ([deploying](https://workflow-sdk.dev/docs/deploying)). It is the nearest relative of awf's run
  directory, but it still replays the workflow function over an event log.

**Taken.** Buffering early events, start on a miss, a double-texting policy, a key that is not a
credential, and a deadline stored with the wait.

**Rejected.** Each of them as a dependency: replay determinism, a server, or a second record.

**Unmined.**

- Temporal's update validators (`setHandler(…, { validator })`): rejecting a reply before it is
  recorded. That could be the Q5 sender check.

## Claude Code, Agent SDK and Codex sessions

**Mechanism (docs only, no live probe).**

- **Claude Code transcripts.** `~/.claude/projects/{cwd-slug}/{session-id}.jsonl`.
  - `--resume {id}` works from any directory on the same machine, in v2.1.223 and later.
  - `-p` and SDK sessions resume by id.
  - `--mcp-config`, `--settings` and `--add-dir` are not restored, so pass them again.
  - Source: [sessions](https://code.claude.com/docs/en/sessions).
- **Compaction on resume.** Only the last summary and the turns after it are loaded.
- **Retention.** `cleanupPeriodDays` defaults to 30
  ([claude-directory](https://code.claude.com/docs/en/claude-directory)).
- **Cache.** The main-conversation cache lasts 1 h on a subscription and 5 min on an API key
  ([prompt caching](https://code.claude.com/docs/en/prompt-caching)), so a resume days later rewrites
  the whole prefix.
- **Agent SDK.** It has `resume`, `forkSession` and `persistSession: false`. A `sessionStore` adapter
  mirrors transcripts elsewhere, keyed by the cwd
  ([sessions](https://code.claude.com/docs/en/agent-sdk/sessions),
  [session storage](https://code.claude.com/docs/en/agent-sdk/session-storage)).
- **Codex.** `codex exec resume {id}` or `--last`, plus `codex fork`. Rollouts are stored under
  `~/.codex/sessions/YYYY/MM/DD/` (from source, `codex-rs/rollout/src/list.rs`). No retention policy
  was found (unverified). The default OpenAI cache lasts 30 minutes on GPT-5.6 and later
  ([prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)).
- **Claude Tag.** One thread is one durable session, resumed in a fresh sandbox on each reply. Anyone
  in the paired workspace may steer it by default, and an owner can restrict that
  ([how it works](https://claude.com/docs/claude-tag/concepts/how-it-works)). The older Claude Code
  in Slack opened a new cloud session per mention ([slack](https://code.claude.com/docs/en/slack)).
- **Claude Code channels** (research preview). An MCP server pushes `notifications/claude/channel`
  into a running session, gated by a per-plugin sender allowlist. "Events only arrive while the
  session is open", and are otherwise dropped silently. There is no Slack plugin
  ([channels](https://code.claude.com/docs/en/channels)).

**Taken.**

- Resume by stored session id as Q1 (b). Treat a missing transcript (swept after 30 days) or one
  over the cap as the signal to fall back to (c).
- Pass launch flags again on resume. awf already relaunches with its own flags.
- Claude Tag's model as the target experience.

**Rejected.**

- Channels as the delivery path. They need a live session and drop events otherwise, and they are a
  preview with no headless support (`--dangerously-load-development-channels` is ignored under `-p`).

**Unmined.**

- Agent SDK `sessionStore`: awf could mirror transcripts into the run record, so a thread survives the
  30-day sweep and the record holds what the agent saw.
- The channels permission relay (`permission_request` / `permission`), as a model for approving a
  tool from a thread.

## Sources

Repositories (shallow clones, 2026-10-22):

- `openclaw/openclaw@74ca496b`: `docs/channels/slack/{threads-and-sessions,transports,events,access-control}.md`,
  `docs/channels/pairing.md`, `docs/concepts/{session,memory}.md`, `docs/tools/ask-user.md`,
  `docs/tools/acp-agents/{bindings,delivery}.md`, `docs/cli/mcp/serve.md`,
  `src/security/external-content.ts`
- `nanocoai/nanoclaw@27a0ef7`: `README.md`, `docs/{architecture,isolation-model,agent-runner-details,db-central,memory,scheduled-tasks}.md`,
  `src/state-sqlite.ts`, `src/channels/chat-sdk-bridge.ts`, `package.json`
- `NousResearch/hermes-agent@8237c7f8`: `website/docs/user-guide/{sessions,security}.md`,
  `website/docs/user-guide/messaging/slack.md`, `website/docs/user-guide/features/{cron,memory}.md`
- `vercel/chat@5781d46`: `README.md`, `apps/docs/content/docs/{threads-messages-channels,state-adapters,concurrency,approvals,testing,history}.mdx`,
  `packages/adapter-slack/{README.md,src/index.ts,package.json}`, `packages/chat/{package.json,src/types.ts}`

Slack:

- https://docs.slack.dev/apis/events-api/
- https://docs.slack.dev/apis/events-api/using-socket-mode/
- https://docs.slack.dev/reference/methods/conversations.replies/
- https://docs.slack.dev/changelog/2025/05/29/rate-limit-changes-for-non-marketplace-apps/
- https://docs.slack.dev/changelog/2025/06/03/rate-limits-clarity/
- https://docs.slack.dev/changelog/2026/06/30/agent-messages-tab/
- https://docs.slack.dev/changelog/2026/08/20/agent-updates/
- https://docs.slack.dev/ai/developing-agents/
- https://docs.slack.dev/reference/methods/chat.startStream/
- https://docs.slack.dev/tools/bolt-js/concepts/socket-mode/
- https://docs.slack.dev/tools/bolt-js/concepts/using-the-assistant-class/
- https://docs.slack.dev/messaging/message-metadata/
- https://docs.slack.dev/reference/events/message/bot_message/
- https://docs.slack.dev/apis/slack-connect/
- https://docs.slack.dev/tools/python-slack-sdk/reference/socket_mode/request.html

Claude and Codex:

- https://code.claude.com/docs/en/sessions
- https://code.claude.com/docs/en/claude-directory
- https://code.claude.com/docs/en/prompt-caching
- https://code.claude.com/docs/en/context-window
- https://code.claude.com/docs/en/agent-sdk/sessions
- https://code.claude.com/docs/en/agent-sdk/session-storage
- https://code.claude.com/docs/en/slack
- https://code.claude.com/docs/en/channels
- https://code.claude.com/docs/en/channels-reference
- https://claude.com/docs/claude-tag/concepts/how-it-works
- https://platform.claude.com/docs/en/build-with-claude/prompt-caching
- https://developers.openai.com/codex/cli/reference
- https://developers.openai.com/api/docs/guides/prompt-caching
- https://github.com/openai/codex/blob/main/codex-rs/rollout/src/list.rs

Durable wait:

- https://docs.langchain.com/oss/python/langgraph/interrupts
- https://docs.langchain.com/oss/python/langgraph/persistence
- https://docs.langchain.com/langsmith/double-texting
- https://docs.temporal.io/sending-messages
- https://docs.temporal.io/handling-messages
- https://docs.temporal.io/cloud/limits
- https://typescript.temporal.io/api/namespaces/workflow#condition
- https://www.inngest.com/docs/reference/functions/step-wait-for-event
- https://www.inngest.com/docs/features/inngest-functions/steps-workflows/wait-for-event
- https://www.inngest.com/docs/self-hosting
- https://developers.cloudflare.com/workflows/build/events-and-parameters/
- https://developers.cloudflare.com/agents/api-reference/run-workflows/
- https://workflow-sdk.dev/docs/foundations/hooks
- https://workflow-sdk.dev/docs/api-reference/workflow-api/resume-hook
- https://workflow-sdk.dev/docs/deploying
- https://chat-sdk.dev/docs/approvals

Grouping:

- https://docs.sentry.io/concepts/data-management/event-grouping/
- https://docs.sentry.io/platforms/javascript/usage/sdk-fingerprinting/
- https://docs.sentry.io/concepts/data-management/event-grouping/merging-issues/
- https://develop.sentry.dev/backend/application-domains/grouping/
- https://docs.sentry.io/api/events/retrieve-an-issue/
- https://docs.sentry.io/product/issues/states-triage/
- https://docs.pagerduty.com/developer/send-alert-event
- https://docs.pagerduty.com/incident-management/incidents/event-management
- https://docs.datadoghq.com/error_tracking/error_grouping/
- https://docs.datadoghq.com/error_tracking/issue_states/
- https://docs.datadoghq.com/error_tracking/regression_detection/
- https://docs.datadoghq.com/monitors/configuration/
