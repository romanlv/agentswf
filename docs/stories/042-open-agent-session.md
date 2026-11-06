---
id: "042"
title: "The operator opens any agent's session and asks it more"
summary: "awf open <run> <agent> opens a copy of the agent's latest session, made with no model turn, in its harness's own TUI, where the agent worked (its home, cwd, sandbox and model), or asks it one question with -p; --no-fork opens the session itself, and awf keeps every other writer out while it is open."
type: story
status: done
depends_on: ["041"]
---

# The operator opens any agent's session and asks it more

## Outcome

After a run, or during one, the operator often wants to know *why* an agent did something: why the
reviewer flagged this line, why the fixer left that file alone, what it read before it answered.
The answer is in the agent's context, and today the only way back into it is by hand: find the
session id in `run.jsonl`, work out the agent's cwd and model, `cd` there and type the harness's own
resume command. That resume writes into the session the run owns, while the run or a second resume
may be writing it too, which pi forks silently (E4–E7).

This story makes it one command:

```sh
awf open review/r7 fixer                                    # a copy of fixer's session, in its harness's TUI
awf open review/r7 fixer -p "why did you skip migrate.ts?"  # one question to a copy, the answer printed
awf open review/r7 fixer --no-fork                          # fixer's session itself, the run held meanwhile
```

`awf open` copies the agent's latest session without asking the model, in about half a second, and
opens the copy where the agent worked: its home and skills, its cwd, its sandbox, on the model and
effort it ran on, with the harness's own permission prompts. The run and its session are never
touched, so it works on a finished run, a parked one and a live one; a sandboxed agent's copy
is refused while an attempt runs or another `awf open` has its sandbox open, as reopening it
would break theirs.

`--no-fork` opens the session itself, for when what the operator says should stay with the agent:
steering a parked event run's agent by hand, say. awf then keeps every other writer out until the
harness exits: no attempt starts, no second `--no-fork` opens it, and an event that arrives waits in
`in.jsonl` and wakes the run once the operator is done.

It was an idea in [[ideas]] ("teleport to a specific session from workflow"). The operator's use is
inspecting a session and asking it more with its context. An agent the run keeps driving while the
operator talks to it is [[attended-agent]] and [[stopped-run-recovery]].

## How it works

```text
awf open <run> <agent> [--no-fork] [--session <id>] [-p <text>]
  │
  ├─ readRun(run) ── sessions.latest[agent] ──▶ { harness, session, operation, home?, sandbox?, skills? }
  │                  (--session: that line in sessions.all, or a copy, opened as is)
  │                  ops/{operation}/op.json ─▶ { cwd, execution: { model, effort } }
  │
  ├─ the agent's place, as it ran:  its home (skills in it), its cwd, and its sandbox reopened
  │                                  from the session line's spec: same provider, reach, network,
  │                                  image; the agent admitted with its existing home
  │
  ├─ default:    spec.forkSession(session), in that home ── no model turn ──▶ the copy's id
  │
  ├─ --no-fork:  under the run's lock: an attempt live, or {id}.open held ──▶ refused
  │              otherwise claim {id}.open (pid, process start) and let the lock go
  │
  ├─ in that place, on model and effort, on the copy or the session:
  │    no -p : spec.operatorResume(id)    the harness's TUI on the operator's terminal, its exit code
  │    -p    : spec.resumeTurn(text, id)  headless, as the agent's turns ran; the reply printed
  │
  └─ the sandbox closed; --no-fork: drop {id}.open, then, for a run with events, under the run's
     lock, wake it as awf tick would
     then: the command that opens it again (below)

meanwhile, while {id}.open is held by a live process:
  awf emit / awf send / awf tick ── wake() ──▶ { did: "none", why: "opened" }, the event kept in in.jsonl
  awf run --continue            ──▶ refused, naming the awf open that holds it
```

- **Which session.** The agent's latest `session` line in `run.jsonl`, the one a continue would
  resume. An agent opened by `agent.fork({ key })` has its own key and its own line. `--session
  {id}` names another: one of the agent's earlier lines in `sessions.all`, which is the run's and is
  forked or held as the latest is; or any other id, taken as a copy an earlier `awf open` made, which
  is the operator's and opens as is, never forked, nothing held, `--no-fork` refused as meaningless.
- **Again.** As the harness exits, awf prints the command that reopens what was open: for a copy,
  `awf open {run} {agent} --session {copy}`; for the session itself, `awf open {run} {agent}
  --no-fork`, with `--session` when it was not the latest. A native resume would reopen neither the
  sandbox nor the home.
- **Where it opens.** The cwd of the operation that recorded the session (`op.json`), on its
  `execution`'s model and effort. claude finds a session by its cwd, so this is not optional.
- **As it ran.** The session opens exactly where the agent worked (Q4): its home when it had one of
  its own, so its skills are there; its cwd; and, when it ran in a sandbox, a sandbox opened anew from
  the recorded spec (Q6): the same provider, reach, network and, on docker, the image digest it ran.
  An agent on the operator's home opens there.
- **Permissions.** The TUI differs from the agent's turns in one thing: the harness's own defaults,
  its approval prompts on, the unattended flags off (Q2). On the host that includes the harness's
  own sandbox: codex's, off in every run, is as its config sets it. In awf's sandbox it stays off,
  as on the agent's turns, since it may not nest, and awf's sandbox is the boundary (M10). pi has no approval prompts, as far as is known (M10), so its TUI runs what the model asks,
  as the agent's turns did. `-p` is a headless turn with no one to ask, so it runs exactly as the
  agent's turns did, unattended flags included: inside its sandbox when it had one, on the host with
  the reach the agent had there.
- **The operator's terminal in a sandbox.** A sandbox today gives an agent a headless command
  (`launch`) or a Herdr pane (`pane()`), never the terminal it was asked from. `launch` gains a
  terminal: srt runs it under a second profile with `allowPty`, as a pane's (a TUI sets its
  terminal raw, which srt otherwise refuses, M10); docker's `exec` adds `-t`; a provider that
  cannot refuses, and `awf open` names it.
- **A copy, by default.** Forked in that same home, so it opens in the same place and goes when that
  home does; awf records nothing of it. Each `-p` without `--session` makes a new copy; a second
  question to the same copy names it with `--session`.
- **The session itself, with `--no-fork`.** The operator's turns are then the agent's: `awf logs`
  shows them after the run's last event, and the next attempt resumes the session with them in it.
  A run's cost is settled per operation in `spend.json` as each ends, so they are not in it (M6).
- **The wake at exit.** Only a run with events is woken, as `awf tick` wakes only those: whatever
  waited is taken, and a failed or interrupted run is continued, as the next tick would anyway. A
  plain run is left as it was.
- **One writer.** codex refuses a second writer on a session, a TUI between turns included; pi lets
  both write and forks the conversation silently (E4–E7). awf does not rely on either: `{id}.open`,
  beside the run's lock and claimed the same way, makes `--no-fork` the session's one writer. It is
  per run, not per agent, because an attempt resumes any of the run's agents. A holder whose process
  is gone, by pid and start time, holds nothing, so a killed `awf open` leaves the run free and the
  next `awf tick` takes what waited. The run's lock itself is not held across the TUI: senders take
  it for an append and give up after two minutes.
- **What is not guarded.** A resume the operator types by hand, outside awf, and a kept pane whose
  harness is still running after its run (M9).

## Scope

In scope:

- `awf open <run> <agent> [--no-fork] [--session <id>] [-p <text>] [--cwd] [--run-root] [--json]`,
  addressing a run and agent as `awf send` does.
- A harness spec field for an attended resume: the harness's plain resume on a session, with its own
  permission prompts, on a given model and effort (Q2).
- The agent's place reopened as it ran: its home, its cwd, its sandbox from its recorded spec; the
  `session` line gains the sandbox the session lives in (Q6); a sandbox's `launch` gains the
  operator's terminal.
- `{id}.open`, and its check in `wake()` and `awf run --continue`; `opened` in the published
  `WakeWhy`.
- claude, codex, pi and cursor, on the host, in srt and docker sandboxes, with and without skills,
  as far as M1 allows.

Out of scope:

- An agent the run keeps driving while the operator talks to it: [[attended-agent]].
- A session as it was at an earlier operation: needs a cut of the session file, which no harness
  offers whole.
- A workflow handing a session to a person: the person participant's work.
- Placing the session in a Herdr pane: the command opens where it is typed, a pane included.
- Guarding resumes started outside awf.
- Recording the operator's opens or copies in the run.

## Context and evidence

- Fact: every run, not only one with events, writes a `session` line per agent as soon as its
  session is known: `{ agent, harness, session, operation, home? }` (`engine/src/session-lines.ts`).
  `readRun` returns them as `sessions.latest` by agent and `sessions.all`
  (`contract/src/run-lines.ts`). Seen in E1's run.
- Fact: `ops/{agent}.{n}/op.json` records the operation's `cwd` and `execution` (harness, model,
  placement, effort).
- Fact: `awf logs` reads each agent's session files from the start, bounded only by bytes and lines
  (`engine/src/run-read.ts`, `readActivity`).
- Fact: the engine reads no session usage after an operation ends; `spend.json` is written per
  operation (story 041).
- Fact: the run's lock, `{root}/{workflow}/{id}.lock`, is held only for a sender's append to
  `in.jsonl` and a wait's last look before it parks; a caller gives up after 120 s
  (`engine/src/run-lock.ts`). It is taken over from a holder whose process is gone.
- Fact: `wake()` is the one policy for what an event or `awf tick` does to a run, under the run's
  lock: start, continue, nudge, or `none` with a `WakeWhy` (`engine/src/wake.ts`). `WakeWhy` is
  published in `contract/src/records.ts`; `awf emit --json` prints it.
- Fact: every harness has a turnless `forkSession` (claude `--resume --fork-session` with `/cost`,
  codex `app-server` fork, pi `rpc --fork`, cursor a copy of the chat directory), story 016, and
  `callingSession` in `harness/src/adapters/fork.ts` forks a session it did not start, given harness,
  id and cwd (story 027). `copySession` copies one out of another home without following links.
- Fact: every harness has `interactiveResume`, but with the agent's unattended flags: codex
  `--sandbox danger-full-access --ask-for-approval never`, cursor `--force --trust`, claude
  `--allowed-tools Bash`. Opened for a person, these run the model's commands without asking.
- Fact: a skilled agent's home is under the run's `work/agents/{id}`, never removed; a sandboxed
  agent's is under its sandbox's directory, `homes/{id}` (`engine/src/sandboxes.ts`).
- Fact: what a sandbox was is recorded whole, `SandboxRecord` (provider; spec with cwd, reach and
  network; its directory; gitdirs; domains; `provided`, docker's image digest and srt's toolchain),
  and each agent's `agent-opened` names its cwd, home, sandbox key and skills. Both are in
  `log.jsonl`, which is best effort and read by nothing that acts (story 041); `out.json` has the
  sandboxes once an attempt settles, not while it runs. `op.json`'s `AgentOp` holds
  `{ agent, execution, cwd }` only.
- Fact: `readRun` checks only the fields it knows on a line (`contract/src/run-lines.ts`), so an
  optional field added to the `session` line is read past by an older reader, within `format` 1. The
  session line is also what `awf logs --json` gives as a handle's first line.
- Fact: a sandbox's occupant runs an agent through `launch`, headless (docker `exec -i`, no tty), or
  `pane()`, a Herdr pane, inside the box on docker (`sandbox/src/seam.ts`). Neither hands the
  operator's own terminal to a process inside.
- Fact: codex runs with its own sandbox off, `danger-full-access`, on every turn, TUI or headless.
- Fact: `awf tick` wakes only runs with events, and `wake()` continues an interrupted, failed or
  timed-out one (`engine/src/tick-command.ts`).
- Constraint: only `engine/src/operator-runtime.ts` imports a sandbox provider (boundary 4); `awf
  open` reopens one through it, as `awf run` does.
- Constraint: foundation keeps native session references out of workflow state as resume authority;
  ADR 0012 allows them for an event run's own continue. This is operator tooling reading the record.
- Constraint: never say an open "charged" or "spent" anything from awf's records.

### Experiments, 2026-11-05

A `quick-check` run on codex `gpt-6-luna` and pi on OpenRouter DeepSeek v4.1 Flash (two questions:
17 × 23, then add 9), then a probe that forks each recorded session through `callingSession`, asks
the copy a follow-up headless, and compares the original session file before and after.

| | E1 codex | E2 pi |
| --- | --- | --- |
| fork, no model turn | 0.58 s | 0.45 s |
| the copy's answer to "what two numbers did you answer earlier?" | "391 and 400" | "391 and 400" |
| original session file after | unchanged, 157,531 bytes | unchanged, 35,926 bytes |

The same session opened twice, on E1's and E2's originals: two processes, each told a codeword, then
a third asked which it knows. "At once" is two headless resumes started together; "TUI open" is the
harness's TUI held idle in a pseudo-terminal while a headless resume runs, then a question typed into
the TUI.

| | codex | pi |
| --- | --- | --- |
| E4 two at once | the second refused in 0.4 s: `thread … already has an active writer`; the file holds one turn | both answered; the file parses, both turns in it |
| E5 what the next resume knows | ALPHA, the one written | BRAVO only: ALPHA's turn is on a dead branch |
| E6 a TUI open, idle, while another resumes | the other refused, the same error, for as long as the TUI is open | the other answered DELTA; the TUI, typed into after, answered "BRAVO.": it never saw DELTA |
| E7 the file after E6 | one writer's turns | two branches from the same entry: a pi session is a tree (`id`, `parentId`), each writer appends to the leaf it holds, and a resume continues the last entry written |

So codex guards its session for the life of a process, and pi does not: there two writers fork the
conversation silently, each seeing only its own branch, and whichever wrote last is what the next
resume continues. Every file stays parseable, so `awf logs` shows both branches as one agent's.

- E3: the TUI on a session was not captured here (it needs a terminal); story 016 opens sessions in
  panes through `interactiveResume` on every harness, so the launch is established.
- claude and cursor were not probed live, to keep claude usage for development. M3, M4 and M7 check
  them.

## Code map

### harness

- `src/harnesses/define.ts` — the spec: add `operatorResume(sessionId, settings)`, built or absent
  with a reason, as story 019 requires of every capability.
- `src/harnesses/{claude,codex,pi,cursor}.ts` — each harness's attended resume: `claude --resume`,
  `codex resume`, `pi --session-id`, `cursor-agent --resume`, with model and effort, without the
  unattended flags (claude's `--allowed-tools Bash`, codex's `--ask-for-approval never`, cursor's
  `--force`). codex on the host takes its own config's sandbox and approvals; in awf's sandbox
  `-c sandbox_mode="danger-full-access" --ask-for-approval on-request` (codex 0.167 has no
  `untrusted`).
  The sandboxed arguments (`sandboxedArgs`) are added as for a run's turn.
- `src/adapters/fork.ts` — `callingSession`: reused for the copy, likely lifted into one
  `forkRecordedSession(harness, session, cwd, home?)`; `forkSession` already takes the home.
- `src/sandbox-needs.ts` — what a harness needs in a sandbox, as an admitted agent gets it.

### engine

- New `open-command.ts` beside `inbox-command.ts`: resolve the run as `send` does, read
  `sessions.latest` and the operation's `op.json`, reopen the agent's place, fork or claim
  `{id}.open`, then spawn with inherited stdio or run one `resumeTurn`; on exit close the sandbox,
  drop the claim and wake.
- `operator-runtime.ts` — the sandbox provider, resolved and given to `awf open` as to `awf run`.
- `sandboxes.ts`, `sandbox-homes.ts` — reopening a sandbox from a recorded spec, and admitting the
  harness with the agent's existing home: its credentials refreshed, nothing else reseeded.
- `session-lines.ts` — the session line carries the sandbox its session lives in (Q6) and the
  skills its harness was given (Q7).
- `run-lock.ts` — the claim and its stale holder, shared with `{id}.open`: `{id}.open` is a second
  file claimed the same way, held for as long as its process lives.
- `wake.ts` — `wake()`: a held `{id}.open` answers `none`, `opened`, before anything it would start.
  A nudge to a live attempt is unaffected: `--no-fork` refuses a live run.
- `runs.ts` `openedRefusal`, in `claimAttempt` and `run-prepare.ts`'s early check — an attempt,
  `awf run --continue` included, refused while it is held.
- `commands.ts`, `help/` — the command, its usage and `awf help reference`, under "Look at runs".

### contract

- `records.ts` — `WakeWhy` gains `opened`, a published type. The `session` line gains `sandbox?`:
  the `SandboxRecord` fields that reopen it (`provider`, `spec`, `directory`, `provided`), absent
  for an agent on the host (Q6), and `skills?` (Q7). An optional field on a public, stable record.
- `run-lines.ts` — the session line's `sandbox` checked as an optional object.

### sandbox

- `seam.ts` — `SandboxProcess` gains `terminal?: true`: the command gets the operator's terminal,
  stdio inherited. `testing/fake.ts` and `srt/` pass it through; `docker/` adds `-t`.

### Checked, no change

- the author surface: an attempt that runs is unchanged but for the session line's new fields,
  which `workflow-runner.ts` fills from the place it admitted the agent to and the skills it gave.

## Proposed design

The help is `packages/engine/src/help/open.txt`, as built.


```text
$ awf open review/r7 fixer
fixer · codex gpt-6-luna · srt · a copy of 01a1ac50…
… codex's TUI …
again: awf open review/r7 fixer --session 01a1ac51-e207-7063-a515-8cdde3c02612

$ awf open review/r7 fixer -p "why did you skip migrate.ts?"
It was generated: the header says not to edit it, and the change belongs in schema.sql.
again: awf open review/r7 fixer --session 01a1ac52-…

$ awf open review/r7 fixer --session 01a1ac52-… -p "and schema.sql?"
It has no migration for the new column; I left that to the reviewer.
again: awf open review/r7 fixer --session 01a1ac52-…

$ awf open triage/c41 investigator --no-fork
investigator · claude claude-sonnet-5-5 · session 7f3e…, the run held until you exit
… claude's TUI …
woke triage/c41: started, for an event that waited
again: awf open triage/c41 investigator --no-fork

$ awf open review/r7 fixer --no-fork
✗ review/r7 is running, and fixer's session may be written as you type; a copy opens anyway: awf open review/r7 fixer
$ awf open triage/c41 investigator --no-fork
✗ triage/c41 is open in awf open --no-fork (pid 4121); a copy opens anyway: awf open triage/c41 investigator
```

- `--json` with `-p`: `{ v, session, forkedFrom?, reply, again }` (narrowed in review: the rest
  describes the agent, which the caller named). Without `-p` it is refused: a TUI has no JSON.
- `-p` with no text reads stdin, as `awf send` does.
- `awf emit --json` on a held run: `{ … "did": "none", "why": "opened" }`; the event is accepted.

Errors, each naming the next step:

- no such run: as `awf send` says it;
- `--no-fork` on a live run, or one another `awf open --no-fork` holds: the command without it;
- an agent with no session line (never started a turn, or its harness never named one): the agents
  that have one;
- the cwd gone (a removed worktree): refused, naming it; claude cannot find the session elsewhere;
- the agent's own home gone (M1): refused, naming it;
- the sandbox cannot be reopened (docker's image digest gone, srt missing), or its provider cannot
  give a process the operator's terminal: the provider's reason;
- a session line written before it had `sandbox` (Q6), on an agent whose home is a sandbox's:
  refused, since where it ran is not recorded;
- `--session` naming a session the harness cannot find in the agent's place: its error;
- `--no-fork` with `--session` naming a copy: refused, a copy is already the operator's;
- `operatorResume` absent for the harness: its reason.

Alternatives rejected:

- **The original by default, `--fork` for a copy** (this draft's second version). Asking "why" is
  the common case and should leave the agent as it was; a copy needs no lock and works on a live
  run.
- **Hold the run's lock across the TUI.** Senders take it for every append and give up after two
  minutes, so an `awf emit` during a long conversation would fail.
- **A lock per agent session.** Finer, but an attempt resumes any of its agents, so the engine would
  check every agent's before starting one; a run held whole is one check where attempts start.
- **Refuse `--no-fork` on any run that can still wake.** Safe without an engine change, but leaves
  out the one case the original is for: steering a parked event run's agent.
- **The native interactive forks** (`codex fork`, `pi --fork`, `--fork-session`). One step for three
  harnesses, but cursor has none, the copy's id is known only after the TUI exits, and the turnless
  fork plus a resume is already built and tested.
- **Reuse `interactiveResume`.** Its unattended flags let the model run anything without asking a
  person who is right there (Q2).
- **A copy in the operator's home, on the host** (this draft's earlier recommendation for Q4).
  Simpler, but the agent would answer without its skills and outside its sandbox, so what it does
  there is not what it would have done in the run.
- **Read the sandbox from `log.jsonl` or `out.json`.** The log is best effort and nothing that acts
  reads it (story 041); `out.json` has the sandboxes only once an attempt settles, so a copy of a
  live run's agent could not open in its place.
- **A sandboxed TUI in a Herdr pane, through `pane()`.** Built already, but the command would open
  somewhere other than where it was typed, and only where Herdr runs; a terminal on `launch` is a
  small change in each provider.
- **Print the harness's own resume as `again`.** It would reopen neither the sandbox nor the agent's
  home; `--session` does.
- **`-p` with the harness's prompts.** A headless turn has no one to answer them, so the first
  command would fail the turn.
- **Record opens in `run.jsonl`.** A new line kind for something that is not the run's.

## Tasks at a glance

- [x] 1. An attended resume on every harness
- [x] 2. `awf open`, a copy, on the host
- [x] 3. `--no-fork`, the run held while it is open
- [x] 4. Sandboxed and skilled agents, as they ran, and a live run
- [x] 5. Docs and a live check on every harness

## Open questions

All decided by the operator on 2026-11-05.

### 1. An attended resume

- **Q2. Permissions.** Decided: the harness's own defaults, so the model asks before it runs a
  command, inside the agent's sandbox when it had one.

### 2. `awf open`

- **Q1. The command.** Decided: `awf open <run> <agent>` opens a copy; `--no-fork` the session
  itself.
- **Q3. `-p` in this story.** Decided: yes.

### 3. `--no-fork`

- **Q5. Concurrent writers.** Decided: awf prevents them on its side, where it can; the mechanism is
  `{id}.open` as above.

### 4. Sandboxed and skilled agents

- **Q4. Where a session opens.** Decided: exactly as the agent worked in the workflow: its home and
  skills, its cwd, and its sandbox when it had one; a copy too.
- **Q6. Where the sandbox an agent ran in is recorded.** Decided, as recommended: the `session`
  line in `run.jsonl` gains an optional `sandbox` (`provider`, `spec`, `provided`, and `directory`,
  added in implementation). That line already
  says where the session lives (`home`, a path inside the sandbox's directory), it is written once
  per session, after the sandbox is open, and `awf open` reads it first. `readRun` reads past a
  field it does not know, so this stays `format` 1. A session line written before it opens a
  sandboxed agent's session refused; an agent on the operator's home as before. Rejected: `op.json`'s
  `AgentOp` (the same spec repeated in every operation), a `sandbox` line kind (`format` 2), and
  reading `log.jsonl` (against story 041's rule).
- **Q7. Where an agent's skills on the host are recorded.** Decided 2026-11-05: the `session` line
  gains an optional `skills` beside `sandbox`: the names and the directory the harness was pointed
  at. codex on the host keeps its skills in a home of its own, which `home` already names, but
  claude and pi are given theirs by flags (`--add-dir`, `--skill`) into `work/agents/{uuid}`, which
  only the best-effort log recorded. Rejected: opening them without skills, and reading the log.

## To measure

- **M1.** A sandboxed agent's home after its run: does `homes/{id}` survive the sandbox closing, on
  srt and on docker, is the recorded cwd a host path the operator can open, and do its copied
  credentials still log in?
- **M2.** A copy made while the agent is mid-turn: headless codex and a claude pane. Does it open,
  and does it end at the last complete turn or partway through one?
- **M3.** claude: does `claude --resume {id}` find the session from the recorded cwd when that is a
  realpath (`/private/tmp` against `/tmp`)?
- **M4.** cursor: an original and a copied chat resumed attended, in the agent's home.
- **M5.** A sandbox reopened from its spec after the run: srt with the same reach, docker on the
  recorded digest; does the agent's home admit again, with credentials refreshed, and does a copy
  forked inside it open? While the run is live, can a second sandbox of the same spec open beside
  the agent's own?
- **M6.** After `--no-fork` on an interrupted run's agent, a continue that settles the interrupted
  operation: are the operator's turns read into its `spend.json`?
- **M7.** The same session opened twice on claude and cursor, as E4–E7: refused, forked silently
  as pi does, or broken? claude's session is also a tree (`parentUuid`), so pi's result is likely.
- **M8.** A held run's events: does each `awf emit` during `--no-fork` stay in `in.jsonl`, and does
  the wake at exit take all of them in one attempt? A timer due meanwhile is taken by that wake or
  the next `awf tick`.
- **M9.** A kept pane (`keepPane`, `--keep-panes`) whose harness still runs after its run: can
  `awf open --no-fork` tell, and refuse? Without it, pi's E6 applies.
- **M10.** The attended resume inside srt and docker, on each harness: with the harness's own
  sandbox off as in a run, do its approval prompts still ask (codex `on-request` under
  `danger-full-access`, claude's defaults, cursor without `--force`, pi, which has none), and does
  the TUI draw through docker's `exec -it`?

## Task execution rule

Process one task at a time. Every task repeats the checklist shown under its details. Do not begin
the next task because the current implementation merely compiles: its design must be recorded, its
diff reviewed by subagents, findings resolved, and focused verification complete.

After all tasks are complete, run story-level verification and request human review of the complete
deliverable.

## Task details

### 1. An attended resume on every harness

Outcome: each harness spec says how a person resumes a session, on a model and effort, with the
harness's own permission prompts (per Q2), or why it cannot.

Execution:

- [x] Plan: inspect the relevant code and tests, settle the cleanest module, interface, seam,
  invariants, failure behavior, and focused proof, and record material alternatives before coding.
- [x] Implement: make only this task's coherent change and add focused tests with it.
- [x] Review: have two read-only subagents review this task's actual diff and test output—one for
  architecture and scope, one for correctness and proof.
- [x] Resolve: fix or explicitly disposition every material finding; request targeted re-review
  when a fix changes the selected architecture.
- [x] Verify: run this task's focused checks and satisfy every `Done when` item before checking the
  task in `Tasks at a glance` or starting the next task.

Work:

- `operatorResume` in `define.ts`, built or absent with a reason; one per harness.

Done when:

- each harness's argv is tested: the session, model and effort present, no unattended flag;
- tsc refuses a harness that neither builds nor explains it.

### 2. `awf open`, a copy, on the host

Outcome: `awf open <run> <agent>` opens a copy of an unsandboxed agent's session in a TUI, and `-p`
prints a copy's answer; the run's files and the session are unchanged, on a live run too.

Execution:

- [x] Plan: inspect the relevant code and tests and record the architecture and focused proof.
- [x] Implement: make only this task's coherent change and add focused tests with it.
- [x] Review: obtain architecture/scope and correctness/proof subagent reviews of the actual diff.
- [x] Resolve: disposition findings and obtain targeted re-review after material design changes.
- [x] Verify: satisfy every `Done when` item before checking this task.

Work:

- the command, its usage, the group in `awf --help`, `awf help reference`;
- the run's session and operation read through `readRun` and `op.json`;
- the copy through the harness's `forkSession`, then `operatorResume` or `resumeTurn`.

Done when:

- tests on fake harness processes: the agent picked, the cwd and settings given, every error above;
- the run folder and the session file hash the same before and after.

### 3. `--no-fork`, the run held while it is open

Outcome: `--no-fork` opens the session itself; while it is open no attempt starts and no second
`--no-fork` opens it; an event arriving meanwhile waits and wakes the run when the harness exits.

Execution:

- [x] Plan: inspect the relevant code and tests and record the architecture and focused proof.
- [x] Implement: make only this task's coherent change and add focused tests with it.
- [x] Review: obtain architecture/scope and correctness/proof subagent reviews of the actual diff.
- [x] Resolve: disposition findings and obtain targeted re-review after material design changes.
- [x] Verify: satisfy every `Done when` item before checking this task.

Work:

- `{id}.open`, claimed as the run's lock is, under that lock, after the live-attempt check;
- `wake()` answers `opened` while it is held; `openedRefusal` refuses an attempt; `WakeWhy` gains `opened`;
- the wake at exit, as `awf tick` does for one run.

Done when:

- tests: a second `--no-fork` refused; `awf emit` while held accepted with `opened`, then the run
  woken at exit; `awf run --continue` refused while held; a holder whose process is gone ignored;
- a live check on codex and pi repeats E6 through `awf open --no-fork` and an `awf emit`, and the
  session file holds one branch.

### 4. Sandboxed and skilled agents, as they ran, and a live run

Outcome: a skilled or sandboxed agent's session, and a copy of it, opens where the agent worked: its
home and skills, its cwd, its sandbox reopened from the session line (Q4, Q6); a copy of a live run's agent
opens or is refused with a reason (M1, M2, M5, M9, M10).

Execution:

- [x] Plan: inspect the relevant code and tests and record the architecture and focused proof.
- [x] Implement: make only this task's coherent change and add focused tests with it.
- [x] Review: obtain architecture/scope and correctness/proof subagent reviews of the actual diff.
- [x] Resolve: disposition findings and obtain targeted re-review after material design changes.
- [x] Verify: satisfy every `Done when` item before checking this task.

Work:

- the session line records the sandbox its session lives in (Q6);
- the harness's home pointed at the session line's `home`, both ways; the copy forked inside it;
- the sandbox reopened through the operator runtime's provider, the home admitted, closed at exit;
- `launch` with the operator's terminal on srt, docker and the fake;
- what M2, M5, M9 and M10 find, made rules.

Done when:

- a skilled agent, an srt-sandboxed one and a docker-sandboxed one are opened both ways, use a skill
  they had, and are refused what their sandbox refused them.

### 5. Docs and a live check on every harness

Outcome: the site and `docs/` describe `awf open`, and one live check per harness proves the
attended path end to end.

Execution:

- [x] Plan: inspect the relevant code and tests and record the architecture and focused proof.
- [x] Implement: make only this task's coherent change and add focused tests with it.
- [x] Review: obtain architecture/scope and correctness/proof subagent reviews of the actual diff.
- [x] Resolve: disposition findings and obtain targeted re-review after material design changes.
- [x] Verify: satisfy every `Done when` item before checking this task.

Work:

- the site's CLI reference and the page on looking at runs; `opened` in the client API's wake results;
  `docs/status.md`;
- an `*.eval.ts`: a `quick-check` run, then `awf open -p` and `awf open --no-fork -p` on each agent,
  asking for both answers.

Done when:

- the eval passes on codex, pi and cursor, and on claude in its TUI by hand (claude headless is
  billed per token).

## Verification

Automated:

- [x] the command's tests on fake harnesses, each harness's `operatorResume` argv, and the held
  run's wake and continue (`open-command.test.ts`, `operator-resume.test.ts`, `emit.test.ts`)
- [x] `bun test`: 2,857 pass; one timing test under full-suite load fails now and then, a different
  one each run, each passing alone on the branch and on main
- [x] `bunx tsc --noEmit`
- [x] `bun run scripts/check-boundaries.ts`

Manual or live evaluation:

- [x] the task 3 and task 5 live checks: `tests/open.eval.ts` passes on codex, pi and cursor, a copy
  and the session itself each naming 391 and 400; `--no-fork` held a pi TUI while a second
  `--no-fork` was refused, and the pi session kept one branch
- [x] in a pseudo-terminal, not by hand: `awf open` into the TUI on claude, codex, pi and cursor on
  the host, pi and codex in srt and in docker; one question each, answered from the agent's
  context, exit, `again` reopens the same copy (checked on codex with `-p`)

## Review record

### Task 1

Reviewed with task 2. Architecture: a positional `sandboxed` flag on `operatorResume` was the wrong
seam; codex's in-sandbox flags moved to `sandbox-needs.ts` as `operatorArgs`, given through
`sandboxedOperatorArgs`. Fixed.

### Task 2

Two reviewers (architecture, correctness). Fixed:

- `--session` naming another agent's recorded session opened it as a copy, writing into the run's
  session: refused, naming the agent it is.
- The copy was made before refusals (metered claude `-p`, missing capability): every refusal now
  comes first, stdin read included.
- SIGTSTP was ignored around the TUI, which hangs job control: left alone; SIGINT and SIGQUIT go
  to the harness.
- A line without `operation` took another session's operation: now the agent's own latest.
- `usage` refusals exited 1: now 2, as the help says.
- `-p -` and a question starting with `-`; a `-p` that timed out read as an exit code.
- The env built by hand: now `hostHome(...).env`; `operator-runtime` hands `awf open` a withholding
  `{ run, attach }`; `callingSession` and `awf open` share `forkRecordedSession`.
- `OpenResultJson` narrowed; refusal codes documented; the header names each fact once and says
  the effort.

Kept: `within(workDir)` as the test of a home a line names without `sandbox` (old lines only).

### Task 3

One reviewer; no interleaving lets an attempt and a `--no-fork` both in. Fixed:

- An attempt's refusal checked "opened" before "completed"; the message promised a wake a plain run
  never gets; `--here`'s early refusal missed it. Now after `attemptRefusal`, worded per run, and in
  `run-prepare`'s early check.
- The session chosen before the hold could be stale: read again once held, refused if it moved.
- awf killed by SIGHUP or SIGTERM never released or woke: `runAttached` forwards both to the TUI and
  waits for it, so the ending runs.
- A throw in the re-check left the claim held: released.
- Tests: a copy while held; release after a failed `-p --no-fork`.

Disposition: a holder is awf's own process, so awf killed outright (SIGKILL) while the harness
stays up lets the next event in beside the operator. Stated, not fixed: recording the harness's pid
too is possible if it matters.

### Task 4

One reviewer. Fixed:

- Reopening shares the sandbox directory with the run's own sandbox, whose provider keeps its open
  state there: a sandboxed open on a live run, or two opens of one sandbox at once, would break the
  other. Refused: a live attempt, or `{directory}.open` held by another `awf open`.
- A docker box's lifetime is its deadline: it now follows the mode (the TUI's day, `-p`'s hour).
- `refreshHome` wrote through a hard link or blocked on a FIFO the agent left: now a new file
  renamed over it, at the home's top only.
- What docker's close moved aside is said; a pinned image gone says rebuilt or removed.

Dispositions: `directory` kept on `SessionSandbox` (Q6, below); an old host claude or pi line opens
without skills, as nothing says it had any; Ctrl-C while the sandbox reopens leaves the box to its
deadline.

### Task 5

The docs and the eval, checked by the site's build (every link resolves) and the eval's live run.

## Readiness

- [x] Outcome and boundaries are concrete.
- [x] Relevant implementation, callers, and tests are mapped.
- [x] Evidence and research support the proposed design. (M1, M3, M4, M5 and M10 measured; M2,
  M6, M7, M8 live and M9 not, as the implementation notes say)
- [x] Expensive interface, record-format, and stage-gate decisions are settled. (Q6, the session line's
  `sandbox`; `WakeWhy`'s `opened` is a published addition, accepted with Q5)
- [x] Tasks are ordered, coherent, and independently verifiable.
- [x] Open questions are resolved or explicitly moved out of scope.

## Implementation notes

- **Q6 shape.** `SessionSandbox` is `provider`, `spec`, `provided` and `directory`: reopening opens the
  provider in the directory the agent's home is in, which `dirname(dirname(home))` would only give by
  baking the `homes/{id}` layout into `awf open`. `awf logs --json` handle lines carry it, the resolved
  spec with no secret.
- **Q7 shape.** `SessionSkills` is `{ names, directory }`; whether they are a sandbox's and codex's own
  home on the host are derived from `sandbox` and `home`.
- **codex has no `untrusted`** (0.167: `on-request` and `never`). On the host a person's codex takes
  its config's sandbox and approvals; in awf's sandbox `-c sandbox_mode="danger-full-access"
  --ask-for-approval on-request`, which asks nothing in practice (M10).
- **A door that reaches no run.** A reopened sandbox admits the agent through a door whose `wfa`
  says it reaches nothing, so an old prompt's `wfa result` cannot answer into the run.
- **Credentials.** A reopened home's seeded files are refreshed from the operator's, and refreshed
  ones handed back, as a run's are.
- **What the measurements found:**
  - M1: homes survive the sandbox's close on srt and docker; the recorded cwd is a host path; codex
    and pi log in from refreshed credentials.
  - M3: claude resumed from the recorded cwd (a worktree path); the `/tmp` realpath case was not
    tried.
  - M4: cursor resumes a copied chat attended; its turns go to the copy. Its TUI writes the prompt
    into the parent's `prompt_history.json` (the up-arrow list, not the conversation) and on exit
    names the parent's id: `again` is the one to use.
  - M5: srt and docker (on the recorded digest) reopen after the run, the home admitted again (srt
    now keeps a home's own `gitconfig`), the copy forked and asked inside; a write outside reach is
    refused as in the run. On a live run a sandboxed open is refused rather than opened beside.
  - M10: srt refuses a TUI raw mode without a pty profile (fixed: a terminal launch uses one, as a
    pane does); docker `exec -it` draws pi's and codex's TUIs. codex in a sandbox ran a command
    without asking. cursor keeps "Run Everything" in the agent's chat (`isRunEverything`,
    `approvalMode: unrestricted` in its store), so a resumed cursor agent asks nothing whatever
    the flags. pi asks nothing.
  - codex's TUI leaves a turn running in its own daemon when it exits ("Any running work
    continues"): with `--no-fork`, exiting mid-turn wakes the run while codex still writes; codex
    refuses the second writer (E4), so the attempt's turn fails rather than forks.
  - Not measured: M2 (a copy mid-turn), M6 (spend after `--no-fork`), M7 (claude and cursor with two
    writers), M8 live (covered by tests), M9 (kept panes).
- **Review until clean (second pass).** Fixed:
  - a sandboxed claude's home bypasses every prompt in its settings: its resume adds
    `--permission-mode manual`, from `claude --help` (2.1.319); not run live;
  - the CLI's cancel reaches a fork and a `-p` question (SIGTERM and SIGHUP ended neither), and
    while a TUI has the terminal Ctrl-C is the TUI's, so a second one no longer ends awf with the
    TUI still writing a held session;
  - `runAttached` let go of its signal handlers when its command could not start;
  - a sandboxed home is refused unless it is a real directory in `{directory}/homes`: the sandbox
    can write `homes/`, and a home swapped for a link had the refresh write through it;
  - the reopened spec is checked against the operator's machine and coordinator paths, as the
    run's was;
  - the help, the refusal codes' docs, the guide and the data reference brought in line.
  Third pass:
  - a host agent's home of its own (codex with skills) opened on the login the run left in it: it
    is refreshed from the operator's first, and a refresh handed back at exit, as a sandboxed
    home's is; not while an attempt is live, which owns that login and may have rotated it;
  - `--session` on a copy placed it by the agent's latest line: a copy is now placed by the line
    whose home holds a file named for it, as an agent with a home of its own gets a new one each
    attempt;
  - a Ctrl-C while the place is made stops the open before the TUI starts;
  - a sandboxed agent's `--no-fork` refused on a live run no longer says a copy opens anyway.
  Known gap: a TUI launched in srt is not its own process group, so what it leaves running when it
  exits is not reaped at close (docker's is). It stays confined; the next attempt runs beside it.
- **Open for review:** cursor's prompts cannot be turned on by a flag. Rewriting the copy's chat
  store (`isRunEverything: false`) would do it for a copy, at the price of writing cursor's private
  format; left as is, and the site says so.

## Human review

- [x] Every task is complete and story-level verification passes.
- [x] Set the story status to `awaiting-human-review` and present the outcome, architecture
  decisions, task-level subagent findings and dispositions, exact verification results, deviations,
  and remaining risks.
- [x] Record the human's explicit approval or requested changes here: accepted on 2026-11-06,
  after the change below; claude in a sandbox, a host codex agent with skills and docker skills
  not run live.
  - 2026-11-06, trying it by hand (a copy, then `--no-fork`, on codex): `awf open {run}` with
    no agent was a usage error with the whole help. Changed: it asks which agent and prints the
    command that opens each of the run's agents with a session, the run named once, in the
    commands.
- [x] If changes are requested, return to the affected task and repeat its review and verification.
- [ ] Only after explicit approval, mark the story `done` and update `Stories at a glance`.
