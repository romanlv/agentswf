---
title: Pane layout
type: design
story: "[[026-pane-layout]]"
---

# Pane layout

Where a workflow's pane agents appear on screen, and whether a pane stays open after its agent is
done. The workflow says it per agent, with two options: `layout` (a new tab, or beside another
agent's pane) and `keepPane`.

Read in order: the picture, the author API, when a pane is placed, the rules, then a pane's life,
keeping, sessions and workspaces, marks, and what stays out.

## Why

Today every pane agent gets a tab of its own in its run's workspace, in the headless `awf` Herdr
session, and the tab closes when the agent is done. That is readable but fixed:

- An agent the operator wants to watch can't be put where the operator is looking.
- Agents that belong together, a lead and its reviewers, can't share a tab.
- A pane that failed is gone before anyone could read it.

A first sibling-panes layout stopped being readable at five agents, because each split halved the
root ([[001-multi-agent-review]]). The answer here is not a smarter automatic layout: the workflow,
which knows which agents belong together, says so, one pane at a time.

## The model in one picture

```
session    the run session, `awf` (default), or one named: session: "work"
  workspace  "run"             the run's own (default)
             { name: "review" } one by that name, found or made
             "origin"          the one `awf run` was typed in, in its own session
    └─ tab   "review"   layout: { workspace: "origin", tab: "review" }   ← lead
       ├─ beside lead,     side "right"                                ← security
       └─ beside security, side "below"                                ← style
```

```
┌────────────┬────────────┐
│            │  security  │
│    lead    ├────────────┤
│            │   style    │
└────────────┴────────────┘
```

A pane is placed once, when its agent opens: either in a **new tab**, or **beside the pane of an
agent already open**, which it splits. Nothing names a pane that does not exist yet.

"Placement" keeps its meaning, `pane | headless`. Layout is only about where a pane agent's pane
goes.

## The author API

Two options on `agents.open` and on `fork` (`AgentForkSpec` gains them):

The `?: never` fields only make the two shapes exclusive: a layout is a new tab or a pane beside
another, never both.

```ts
type Layout =
  | {
      /** The Herdr session. Default: the run session, `awf` or `AWF_HERDR_SESSION`. */
      session?: string;
      /** Where the new tab opens in it. Default "run". */
      workspace?: "run" | "origin" | { name: string };
      /** The new tab's label. Default: the agent's key. Every `tab` is a new tab. */
      tab?: string;
      beside?: never; side?: never; share?: never;
    }
  | {
      /** The key of another agent of this run, whose pane this one splits. */
      beside: AgentKey;
      /** The side of that pane the new one goes on. */
      side: "right" | "below";
      /** The new pane's share of the space it splits, 0.2 to 0.8. Default 0.5. */
      share?: number;
      session?: never; workspace?: never; tab?: never;
    };

/** Whether the pane stays after its agent is done. Default "never". */
type KeepPane = "never" | "on-failure" | "always";

interface AgentOpenSpec { /* … */ layout?: Layout; keepPane?: KeepPane }
interface AgentForkSpec { /* … */ layout?: Layout; keepPane?: KeepPane }
```

Without `layout`, an agent is placed as today: a tab of its own, labelled by its key, in the run's
workspace.

```ts
const lead = await workflow.agents.open({
  key: "lead",
  runtime: "claude",
  layout: { workspace: "origin", tab: "review" },
  keepPane: "on-failure",
});
await lead.run({ prompt: "Read the change and plan the review." });

const security = await lead.fork({ key: "security", layout: { beside: "lead", side: "right" } });
const style = await lead.fork({ key: "style", layout: { beside: "security", side: "below" } });

await workflow.parallel([security, style], (agent) => agent.run({ prompt: "Review it." }));
```

`share` is the new pane's part. To stack three panes evenly right of a lead: `a` beside the lead,
`right`; `b` beside `a`, `below`, `share: 0.67`; `c` beside `b`, `below`, `share: 0.5`. Shares nest, and the arithmetic stays in the workflow where it can be
read. (Herdr's `--ratio` is the other pane's part, measured: `--ratio 0.3` gave the pane split 70 of
234 columns. The adapter passes `1 - share`.)

The words are the ones Herdr, tmux (where a tab is a window), Zellij and WezTerm share. No Herdr id
or command reaches the workflow, so the design README's rule still holds: a workflow never names the
host that serves its panes. A `session` or workspace `name` is a name on one machine, so it is
optional, and where it can't be used the agent falls back, so the workflow still runs elsewhere.

A named workspace is `{ name }`, not a bare string, so a workspace called `run` or `origin` is not
mistaken for the keywords.

### Same key again

- **Not inherited.** A fork takes its parent's harness, model and placement, but not `layout` or
  `keepPane`: a parent's `tab` would open a second tab, and its `beside` would split the parent's
  neighbour. A fork without `layout` gets a tab of its own; `beside: parent.key` puts it next to its
  parent, falling back like any `beside` when the parent has no pane.
- **A reopen compares them as written**, never where the pane ended up, so a fallback never makes a
  reopen conflict. `agents.open` with an existing key: omitted, they don't constrain; different, the
  open rejects, as a different `runtime` does. A fork with the same key and parent repeats its whole
  spec, `layout` and `keepPane` included, as ADR 0009 already requires. `attach` names neither.

## When a pane is placed

**At open, for every pane agent.** `agents.open` and `fork` place the agent's pane before they
resolve, and the pane holds a shell until the agent's first operation starts its harness there.
Today a pane opens at the first operation; moving it to open is what makes a layout follow the
workflow's code, and doing it for every pane agent, not only those with a `layout`, is what lets any
agent be a `beside` target from the moment it is open (Q3).

In order:

1. A fork's native fork runs first, as today, so a fork that fails places nothing.
2. The pane is placed, bounded by the open's deadline; a fork, which has none of its own, by the
   deadline of the scope it was called in.
3. The open resolves. If anything after step 2 fails, the pane is closed, never kept.

An agent opened and never run shows an idle shell, labelled by its key, until it is stopped or the
run ends, when its pane closes whatever `keepPane` says.

The order panes appear in is the order the workflow's `await`s give. A pane `beside` a key opened
earlier lands the same way every run. A pane beside a sibling opened in the same `parallel` is a
race: if its target's pane is being placed, it waits for it; if the target has not started opening,
it falls back to a tab of its own.

## The rules

### Refused at open

These are fixed by the workflow's code and the agent's own spec, so the `open` or `fork` rejects with
the reason, and nothing is placed. The types already refuse mixing the two shapes of `Layout`.

| Case | Result |
| --- | --- |
| `beside` names this agent's own key | rejected |
| `share` outside 0.2 to 0.8; `tab` or a workspace `name` empty | rejected |
| `session` that Herdr could not use as a session name (as `AWF_HERDR_SESSION` is checked) | rejected |
| `session` together with `workspace: "origin"` | rejected: `"origin"` is in its own session |
| `layout` or `keepPane` on a headless agent, or on a fork made headless | rejected: it has no pane |
| `layout` or `keepPane` on an agent in a sandbox | rejected, for now; see Sandboxes |

Labels are display only: one longer than 32 characters, a `tab` or a defaulted key, is cut to 32,
not refused.

### Fallen back from, when placed

These depend on what else the run has opened, how it was started, or what is on screen. They never
fail the agent, whose work matters more than where it is shown: it gets a **tab of its own**, in the
target's workspace if it has one, else the run's, and the run's output says which agent and why.

| Case | Why it can't be refused at open |
| --- | --- |
| `beside` a key this run has not opened, or not yet | a stage skipped by `--continue` (ADR 0011) never opens its agents; a `parallel` opens in any order |
| `beside` an agent with no pane: headless, in a sandbox, or whose pane closed (done and not kept, or a failed `set`) | known only once that agent is open, and changes as it runs |
| `beside` the calling session's key | the caller's pane is the operator's (ADR 0010); see `"origin"` |
| The split would leave either pane under 1/8 of the tab's width (`right`) or height (`below`), as Herdr lays the tab out now | depends on what the tab holds, and which of its panes have closed |
| `workspace: "origin"` that can't be used | see Sessions and workspaces |
| `session` that is not running, and not one awf starts; or that doesn't answer, or runs another Herdr version | depends on the machine; the agent goes to the same workspace in the run session |
| Herdr refuses the tab or the split | if a tab in the run's workspace fails too, the open fails, as today |

The size check is best effort, so it is the one rule not the same on every run: which neighbour took
a closed pane's space depends on which agents finished first. It exists because Herdr never refuses a
split itself, and shrinks panes to zero columns, where no harness's startup screen can be read. The
workflow testing host (ADR 0006) has no geometry; it records each agent's layout as written and
applies every other rule.

### One change at a time

Every change to a tab's panes, a placement, a relaunch's replacement, a close, goes through one queue
per Herdr session the run uses, so a `beside` never splits a pane that is being replaced or closed.
Today's queue covers placements in the run's workspace; relaunches and `"origin"` join it. Two
agents beside the same target both land; which is nearer the target follows which opened first.

## A pane's life

awf closes, renames and resizes only the panes and tabs it created. It closes an agent's **pane**,
never its tab: Herdr closes a tab with its last pane (measured), so a tab of several agents goes when
the last of them does, and a tab in `"origin"` the operator split too stays as long as their pane
does.

| Event | What happens |
| --- | --- |
| The agent's first operation | its harness starts in the pane placed at open |
| The harness relaunches (`set` changes model or effort) | replaced in place: the old pane is split, the old half closed, and the harness started in the new one, which by then has the old pane's exact size and position (measured). A later `beside` that names this agent finds the new pane |
| A relaunch or first start whose harness doesn't start | the pane closes. Nothing is kept: there is no harness in it |
| An operation is cancelled | the agent is done (ADR 0008): closed, or kept by `keepPane` |
| `agents.stop`, or the run ends | the agent is done: closed, or kept by `keepPane` |
| A pane others were split from closes | Herdr gives its space to a neighbour; the panes split from it stay (measured) |
| `"origin"`'s Herdr session stops mid-run | its agents' harnesses die with it, and their operations fail as any harness's death does |

At the run's end, awf closes every pane and tab it created and does not keep: agents' panes, a
sandbox's watch tab, and the workspace's first pane if no agent took it. A run workspace left with
nothing in it closes as today; one with kept panes stays open.

Each pane is labelled with its agent's key (`pane rename`, after the split, best effort), so a tab of
several panes says who is who.

## Keep

`keepPane` is decided when the agent is done, and applies only to a pane with a harness running in
it. A pane whose harness never started, failed to start, or died is closed whatever it says.

- **`never`** (default): the pane closes, as today.
- **`on-failure`**: kept when the agent's last operation ended other than `answered`: `unanswered`,
  `blocked`, `timed-out`, `failed`, or `cancelled`, including cancelled because the run was. It reads
  only this agent's last outcome: an agent that answered in a run that then failed is closed.
- **`always`**: kept.

**A kept pane is left with its harness running**, so the operator can read it and type into it.
Stopping the harness and keeping only its scrollback was rejected: stopping cleanly is different in
each harness, and a full-screen harness leaves an empty terminal when it exits.

Before it is kept, the agent is **released**:

- **If its last operation was not answered and its harness is still working**, awf interrupts it and
  waits, bounded, for it to settle. One that does not settle is closed instead, and the output says
  so: a kept agent must not go on editing files. An answered operation already waited for its
  harness to release (ADR 0008).
- **Its result channel is revoked** at that moment, not when the run ends, so a `wf result` from it
  fails. It is done: its later operations in this run fail. What the operator types into it is in
  nobody's usage or spend.

Kept panes stay until the operator closes them:

- **The run's output** lists each kept pane once, with how to reach it: `herdr session attach
  {session}` and its workspace's label, for a pane in a session awf started; the workspace's label
  alone otherwise.
- **A later `beside` a kept pane** is allowed: kept is about the agent, not the pane.
- **A continued run** (`--continue`, ADR 0011) has new agents. The panes an earlier attempt kept are
  that attempt's, left as they are.
- **A run workspace that holds a kept pane** counts as in use, as any open run workspace does today,
  so a stale `awf` server is not restarted after a Herdr update until it closes.

## Sessions and workspaces

| `session` | `workspace` | The tab opens in |
| --- | --- | --- |
| — | `"run"` or none | this run's workspace in the run session, as today |
| `"work"` | `"run"` or none | this run's own workspace in `work`, opened at its first tab, closed at the run's end as the run's workspace is |
| — or `"work"` | `{ name: "review" }` | the workspace labelled `review` in that session, found or made |
| — | `"origin"` | the workspace `awf run` was typed in |

### A named session

Resolved once per run, at the first agent that names it, and the answer kept for the run:

- **Running**: used, if it answers and runs the Herdr version the adapter drives.
- **Named `awf-…` and down**: started by awf, as the run session is: from the allowlisted
  environment and the quiet config, its dead runs' panes swept, and restarted after a Herdr update
  when nothing runs in it. An `awf-…` session is awf's by its name.
- **Any other name, down**: not started. Bringing an operator's stopped session back headless is not
  awf's call, as for `AWF_HERDR_SESSION` today. Fallback.

An agent in a session awf did not start has that session's environment, less what awf withholds, as
in `"origin"` below.

### A named workspace

The workspace in that session whose label is exactly the name, the first in Herdr's order if there
are several; made when there is none, under a lock per session and name in `~/.awf/herdr`, so two
runs opening it at once make one.

A named workspace is shared: by later runs, and by whatever the operator puts in it. So awf treats it
as it treats `"origin"`: it only adds tabs, labelled `{tab} · {run id}`; never closes the workspace, or a
pane it didn't create. It needs no owner: Herdr closes a workspace with its last pane (measured), so
it goes when the last pane in it does.

### `"origin"`

`"origin"` is the Herdr workspace `awf run` was typed in: what makes "show this agent here"
possible. It is resolved **once a run**, at the first agent that names it, from the environment `awf run` started with, so a run that never uses it never asks Herdr. If any step fails, every `"origin"` in the run
falls back to the run's workspace, said once in the output:

1. **Which pane.** For `awf run --here`, the calling session's pane, as `--here` already finds it
   before the workflow starts. Otherwise the shell's `HERDR_PANE_ID`, believed only if that pane's
   process is an ancestor of `awf run` (`pane process-info`): under codex, a shell inherits the
   shared daemon's `HERDR_PANE_ID`, which names another pane (E8).
2. **Which session.** The Herdr session whose socket is the shell's `HERDR_SOCKET_PATH`, matched in
   `herdr session list`, as `--here` does. awf drives it as `--session {name}`. If that is the run
   session (`awf` or `AWF_HERDR_SESSION`), it falls back: a workspace there belongs to some run, and
   that run's end or sweep would close it.
3. **Usable.** It answers, and its server runs the Herdr version the adapter drives, as a sandbox's
   Herdr is checked today. A shell in a sandbox, which has the variables but no socket, fails here at
   once, not at each open.
4. **Which workspace.** The pane's `workspace_id`, read from Herdr, never `HERDR_WORKSPACE_ID`, which
   has the same flaw under codex.

In `"origin"`, awf only adds: new tabs, and splits beside its own agents' panes. It never closes the
workspace, never splits or closes a pane it didn't create, and never takes focus. A tab it opens
there is labelled `{tab} · {run id}`, cut to 32 characters, so the operator can tell which run made
it. The tab comes first: a run's label, `awf {workflow} {id} #{attempt}`, fills 32 characters on its
own. Two runs in one workspace each
get their own tabs, even with the same `tab`.

Not even the calling session's pane is split. ADR 0010 has the engine drive it but never own it;
a pane beside it would put an awf agent in the operator's tab. `layout: { workspace: "origin" }`
puts the agent one tab over.

**Its environment is the operator's, less what awf withholds.** awf empties the variables it
withholds in `awf`, the metered credentials, `OPENROUTER_API_KEY` and the calling session's own, on
every tab and split it makes there (measured: `--env FOO=` on a split empties `FOO`). The rest is
what the operator's Herdr server was started with, as for an agent they start there themselves, and
as for every pane agent before story 024. The `awf` session's allowlist is not lost here: it keeps
one run's shell from reaching every later run through a server that outlives them, and the operator's
session is not one awf shares between runs. It was never a boundary for an unsandboxed agent, which
runs as the operator and can read what the operator can.

## Marks

Today a run's mark names its workspace in the `awf` session, and the next run's sweep closes the
workspace of a run that died. Layout changes what a mark must say, so this is a **record format
change**: `WORKSPACE_MARK_VERSION` goes to 2. Version 2 awf still reads version 1 marks, and sweeps
older dead runs as today. An older awf ignores version 2 marks: it lists a newer run's workspace as
unclaimed and leaves it open. In the moment between a newer run writing its mark and creating its
workspace, an older awf with a stale server sees neither, and may restart the `awf` server under it;
that run's open then fails as any open on a restarting server does. Running two awf versions at once
is the only way to meet it.

A version 2 mark names each pane the run created, with its session, its id, and its
terminal's id (`terminal_id`), and which are kept. Herdr's pane ids are short counters that repeat
after a session restarts; the terminal id does not, so the sweep acts on a pane only when both match.

**A mark outlives its run while it names a kept pane.** Today a run removes its mark at its end. With
kept panes, the run's end rewrites the mark to name only those, and the sweep removes it once they
are gone. So the sweep sees two kinds of mark: a dead run's, and an ended run's kept panes.

The sweep runs at every run's start, in every session a mark names, and for each `awf-…` session at
its start too. For each mark whose run is no longer running:

- **Its panes that are not kept are closed**, in whatever session they are in, `"origin"` included.
  Without this, an awf killed mid-run would leave harnesses in the operator's workspace that nothing
  ever stops.
- **A session that is gone** (not running) took its panes with it: they leave the mark. One that
  doesn't answer, or a pane recorded without its terminal, is left in the mark for the next sweep,
  never closed; a kept pane there still keeps its workspace open.
- **Kept panes are left, and listed**, with the run that kept them. A pane gone from Herdr leaves the
  mark; a mark with nothing left is removed.
- **Its `awf` workspace** closes once nothing in it is kept, not before.

## Sandboxes

A pane agent in a sandbox runs in the sandbox's own Herdr; the run's workspace only shows a tab
attached to it. Splitting across two Herdr servers is not possible, and placing the attached tab is
not yet wanted, so `layout` and `keepPane` are refused on a sandboxed agent, and `beside` one falls
back. Placing the attached tab is cheap to add later.

## What the run records

`output.json` gains `panes`, one entry per pane agent: its layout and `keepPane` as written, and
where it was placed: the session, the workspace (`run`, `origin`, or its name), its tab label or
the key it went beside, a fallback's reason, and whether it was kept, or why a pane asked to be kept
was closed instead. The run's closing lines name each fallback, each pane closed instead of kept,
and each kept pane with how to reach it, once each.

## What changes elsewhere

- **The author surface**: `AgentOpenSpec` and `AgentForkSpec` gain `layout` and `keepPane`;
  `docs/workflow-api.md`'s reference lines for `open` and `fork` change with them.
- **ADR 0008**: "a pane that was closed is not reopened" becomes "a pane agent that is done is not
  driven again": closed or kept, its later operations fail.
- **The Herdr host**: a pane exists from open, before its harness, so its state tells *placed* from
  *launched*; a cancel with nothing launched cancels nothing. Closing an agent closes its pane, not
  its tab. A relaunch replaces its pane in place, through the topology's queue. The run's end closes
  its workspace only when nothing in it is kept.
- **The mark format**, above.
- **The run session's start, sweep and restart** apply to every `awf-…` session a workflow names, not
  only the one `AWF_HERDR_SESSION` names.

## Not in this design

Each waits for a workflow that needs it:

- **A pane beside the calling session's.** Above; it needs ADR 0010 amended.
- **Moving or resizing a pane after it opens.** Herdr can, but a pane that moves under the operator
  is hard to follow, and moving a target has rules of its own.
- **Arrangements such as columns or a grid.** Each is a sequence of `beside`s a workflow can write;
  a named one is shorthand to add once the same sequence shows up twice.
- **Child workflows** (`workflow.call`, not built). `beside` names a key in the workflow's own scope.
- **Focus.** awf never takes it.

## Decided

- **Q1.** A kept pane keeps its harness running, rather than stopping it. *Decided 2026-10-06.*
- **Q2.** Agents in `"origin"` see the operator's environment less the withheld variables, as an
  unsandboxed agent effectively does anywhere; see `"origin"`. *Decided 2026-10-06.*
- **Q3.** Every pane agent's pane opens at `open`, so an agent not yet run shows an idle shell.
  *Decided 2026-10-06.*
- **Q4.** A workflow may name a Herdr session and a workspace, optionally; where it can't be used,
  the agent falls back. *Decided 2026-10-06.*

## To measure

- **M1.** How long a harness takes to settle after an interrupt, to bound releasing a kept pane.
- **M2.** That a `pane close` from awf, and a session restart, never reuse a `terminal_id`.
- **M3.** That `pane process-info` names the pane's shell, so an ancestor check finds the pane
  `awf run` was typed in, under each harness's shell and a plain one. *Measured 2026-10-06 under
  claude: its `shell_pid` is an ancestor of a command the harness runs; a run started detached,
  whose parent is then pid 1, is refused, and falls back.* Under codex, still to measure.
