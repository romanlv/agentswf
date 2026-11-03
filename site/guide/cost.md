---
title: Cost
description: "What a run took: its time, its tokens and an estimate at dated list prices; what is left of your plans; and how to keep runs cheap."
---

# Cost

**Will a run cost you money?** With the defaults, no more than your plans: agents run on your
Claude, ChatGPT, Cursor or pi logins and draw down those plans' allowance. Per-token billing
happens only where you opt into it: a headless claude with `metered: true`, pi signed in to a
provider with an API key, cursor past its plan into on-demand usage, and
[decisions](/guide/decisions), which bill your OpenRouter account.
[Harnesses](/guide/harnesses#subscription-and-metered) has the rules.

Either way, every run records how long it took and how many tokens each agent used, and prices
those tokens at dated list prices, so you can compare two runs or two workflows:

```text
✓ completed · review-loop 20261012-2117-0dc5 · 3 agents · 1m 36s · 412k tokens · ~$1.09 at list prices · subscription
  records  .awf/runs/review-loop/20261012-2117-0dc5
```

That is the closing block `awf run` prints; the figures are only an example. `~$1.09` is what
those tokens would cost at list prices, not your bill.

To get a feel for what your workflow costs, get its logic right with [`awf test`](/guide/testing),
which starts no agent, then do one small real run and read its line in `awf runs`.

## What a run shows

The closing line gives, in order:

- **The agents** the run opened, and the **time** it took, start to end.
- **Tokens**: every token the agents' usage reports, input, cache reads and writes, and output,
  their own subagents' included.
- **The estimate**, `~$1.09 at list prices`, and `<$0.01` for a cost under a cent.
- **`{amount} charged`**, only where something reported a cost: a metered claude or pi agent's
  harness, or OpenRouter for decisions. It is what they reported as the cost, not your bill.
- **Billing**: `subscription`, `metered` or `unknown`, in the words
  [Harnesses](/guide/harnesses#subscription-and-metered) defines; `mixed` when agents whose
  billing is known disagree.

A gap is named, never shown as zero:

| On the line | Means |
| --- | --- |
| `no usage known` | no agent's usage could be read |
| `usage known 2/3` | one agent's usage couldn't be read; its tokens aren't in the total |
| `fully priced 1/3` | an agent used a model the price table lacks; only its priced part is in the estimate |
| `unpriced: {model}` | that model's tokens are counted, and not priced |
| `billing known 1/2` | how one agent was billed couldn't be told; the billing word is the others' |

Where the time and tokens went:

- **A run with stages** keeps each stage's row in its stage list, with what that stage's agents
  used: `2 agents · 180k tokens · ~$0.40`.
- **A run without stages** whose agents fall in more than one group prints a row per group under
  the closing line. The group is the part of an agent's key before the first `:`, which a key
  [no longer takes](/reference/workflow-api#deprecated): a key with `-` is a group of its own.
- **[Decisions](/guide/decisions)** get a line of their own, since a decision is not an agent:
  `4 decisions · 3k tokens · <$0.01 at list prices`.
- **A continued run** adds the whole run after its attempt's figures:
  `run: 2 attempts, 3m 10s, ~$1.30`. An attempt that was interrupted says so, and its cost is
  unknown.

`awf runs` lists each run's time and estimate, so you can compare runs at a glance:
[Following runs](/guide/following-runs#awf-runs-where-a-run-stands).

## Where the numbers come from

After the run ends, awf reads each agent's tokens from its harness's own session files and prices
them with the price table built into awf: one list price per model, read from the vendors' pricing
pages on a date. A newer awf brings a newer table; a finished run keeps the estimate it was given.
`output.json` names the table it used, as `list prices 2026-10-07`, beside the totals, each stage's,
model's and agent's share, and every turn's tokens by model.

The same table prices every agent, on a plan or per token. A plan isn't billed per token, but its
allowance is drawn down roughly in proportion to what the tokens would cost, so one estimate
compares any two runs whoever pays for them.

Long-context surcharges, which some models have past a prompt size, aren't modelled, so a very
long session is under-estimated.

### In the workflow

Tokens and prices come after the run. While it runs, `wf.usage()` lists every turn that has
finished so far in this workflow and the workflows it called, in the order they were sent. Each
gives the agent's key, its harness, model and effort, its stage, the harness's session ids, and
two times: `deliveredAt`, when the harness took the prompt, and `settledAt`, when the turn ended.

<<< @/../examples/site/guide/cost.ts#usage

A line from `wf.log` shows in the run's progress and in `awf logs`.

## Plan allowance

`awf allowance` shows what is left of each harness's plan, as the harness itself shows it. Nothing
asks a model.

```text
$ awf allowance
claude  Max 20x ($200/mo) · session 37%, resets 17:19 · week (Fable) 12.5%, resets Oct 8 12:00
codex   Pro 100 ($100/mo) · week 93%
pi      no allowance: pi has no plan usage command (0.87.1); its OAuth logins draw on claude's and codex's plans, which their own readers show
cursor  Team · Included 1%, Auto 1%, resets Oct 21
```

Each window is a limit of the plan's that resets, and its percentage is how much of it is
**used**: this codex plan has 7% of its week left. A window named for some models limits only
those: `week (Fable)` is claude's weekly limit on its Fable model alone. A plan's monthly price is
the vendor's list price on the date the help names, not what you pay. Name harnesses to read
only those, `awf allowance claude`; `--json` prints one document for scripts.

A workflow reads the same with `wf.allowance(harness)`, on the same logins its agents run on.
Its `read` is `"plan"`, with the plan's `windows`, each a `usedPercent` and the `models` it alone
limits where it has any; or `"none"`, with a `reason`. This one writes on claude while its plan
has room, and on a small codex model otherwise:

<<< @/../examples/site/guide/cost.ts#allowance

The `"claude"` alias opens claude's sonnet, so the check leaves out windows of some models only,
such as Fable's. A `none` means awf couldn't tell, not that there is room to spare. The read isn't
recorded, so a continued run reads again.

## Keeping runs cheap

A runtime for a small job:

<<< @/../examples/site/guide/cost.ts#cheap

- **A small model for a small job.** List prices differ by about a hundred times between the
  smallest and largest models awf prices. Listing files, reformatting, or a one-line summary needs
  no large model.
- **Lower effort.** Effort is how much the model reasons, and reasoning is output, priced at five
  or more times input.
- **Keep the session.** A later turn on the same agent reads its context from the provider's
  cache, which costs a tenth of fresh input or less. A [fork](/guide/agents#compact-switch-fork)
  starts from its parent's cache too. Switching an agent's model loses it. A session grown long
  can be compacted.
- **claude in its TUI**, the default, stays on your plan; headless claude is per token
  ([why](/guide/harnesses#subscription-and-metered)).
- **A decision instead of an agent.** A closed question about some text, such as which team owns
  a ticket, is a [decision](/guide/decisions): no agent starts, and it answers in about 200 ms.
  It bills your OpenRouter account per token, though far less than an agent's turn.
- **Test for free.** [`awf test`](/guide/testing) runs the workflow on scripted answers, so you
  get its logic right without starting an agent.
- **Watch the plan.** `wf.allowance` lets a workflow move work to another harness, or stop, before
  a plan runs out.

## Catches

- **The estimate is not a bill**, and neither is `charged` or `metered`. What you pay is whatever
  your provider bills for the login the agents used.
- **Some usage goes unseen.** A headless turn killed in the middle of a request can leave that
  request out, and an agent whose usage couldn't be read shows as `usage known`, not as zero.
- **cursor's billing is always `unknown`.** Nothing cursor reports tells usage within its plan
  from on-demand usage.
- **Prices move.** The table is dated, and a model released after it is `unpriced` until a newer
  awf names it.

## Next

- [Logging and usage](/reference/workflow-api#logging-and-usage) and
  [Plan allowance](/reference/workflow-api#plan-allowance) in the workflow API.
- [`awf allowance`](/reference/awf#allowance): its options and exit codes.
- [Harnesses](/guide/harnesses): models, effort, TUI or headless, subscription and metered.
