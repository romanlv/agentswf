---
title: Decisions
description: Asking a decision model closed questions about some text, getting a probability for every answer in about 200 ms, and handing the unsure ones to an agent.
---

# Decisions

Not every step needs a coding agent. Which team owns a ticket, whether a comment reports a bug,
how urgent an issue is: these are closed questions about a piece of text. A decision model
answers them in about 200 ms with a probability for every possible answer. No agent starts,
nothing reads your repository, and there is no turn to wait on.

Ask the model first, keep what it is sure of, and send the rest to an agent:

<<< @/../examples/site/guide/decisions.ts#route

The ticket goes to the agent when the model is unsure of the team or of bug-or-not, or when the
decision fails. The whole sample, with its test, is
[`examples/site/guide/decisions.ts`](https://github.com/romanlv/agentswf/blob/main/examples/site/guide/decisions.ts).

## A decision or an agent

| Use a decision | Use an [agent](/guide/agents) |
| --- | --- |
| The answer is one of a few you can list | The answer is open, or is work |
| Everything it needs is in the text you pass | It has to read code, run a command, look something up |
| You ask the same question many times | It's asked once, and getting it right is worth minutes |

A decision model judges the text you give it, nothing else. Measured on awf's own questions, it
was reliable at matching text to a list of options, and not at anything that needed reading code:
the [findings](https://github.com/romanlv/agentswf/blob/main/docs/findings/system-one-models.md)
have the numbers. So the shape above is the usual one: a threshold on the probability, and an
agent behind it.

## The call

`wf.decisions.decide` takes one state and any number of questions about it, and returns an answer
for each:

- **`key`** names the call in the run's record. The part before the first `:` groups its usage when
  the run has no stages, so `triage:1`, `triage:2` and so on count together. Keys need not be
  unique.
- **`model`** is the alias of a decision model. `jev` is the one awf installs.
- **`state`** is what every question is about: a string, an object or an array. The model reads it
  once per call however many questions you ask, so ask them together rather than one call each.
- **`questions`** are at least one, keyed by the name you read the answer by. Each is answered on
  its own and doesn't see the others' answers.
- **`deadline`**, optional, `{ unixMilliseconds }`, is an earlier deadline for this call than the
  one around it.

There are three kinds of question, imported from `agentswf/workflow`:

<<< @/../examples/site/guide/decisions.ts#kinds

| Question | Gives | Its answer |
| --- | --- | --- |
| `choice(instructions, options)` | options by name, each with a description, or `null` when the name says enough | `choice`, the most likely name, typed from your options; `probabilities` by name |
| `score(instructions, levels)` | ordered levels, lowest first | `level`, the most likely index; `expected`, the probability-weighted level; `probabilities`, one per level |
| `yesNo(instructions, criteria?)` | optionally what counts as yes and as no | `yes`, the probability of yes |

On a tie, `choice` is the first option and `level` the lowest. Every answer keeps the whole
distribution as the model gave it, not renormalised: the top pick is a convenience, and the
probabilities are what you decide on.

Instructions and descriptions can be structured text, an object, as well as a string.

## Choosing a threshold

Set your own threshold on the probabilities. It depends on the question and what a wrong answer
costs you:

- A **choice**: the top probability, `team.probabilities[team.choice]`; a **score**'s is
  `urgency.probabilities[urgency.level]`.
- A **yes/no**: how far `yes` is from 0.5. A confident no, `yes` at 0.05, is as sure as a confident
  yes.
- A **score** read as a number: `expected` and cut points of your own often say more than `level`.

The model is close to deterministic but not quite: the same call can move a probability by a few
hundredths. On matching, answers at 0.9 or above were right 117 times in 118 in the measurements
above.

## The model and its key

`jev` is [Jev](https://docs.typesafe.ai/concepts/system-one) through OpenRouter. It needs
`OPENROUTER_API_KEY`, set in the environment or in a `.env` in the folder where you run `awf`.
That is the only name awf reads from `.env`.

The engine makes the calls and holds the key; it is removed from every agent's environment, so no
agent can read it. A run without the key starts as usual; only asking for `jev` is refused.

Each call's record goes into the run's `output.json`: the key, the model and the versioned
snapshot that answered, the outcome, the attempts, and tokens as far as the provider reported
them. The request and its answers are kept beside it, in `decisions/{n}.json` in the run's
directory, so you can fit a threshold on real answers later. A threshold holds for the snapshot it
was fitted on.

## When a decision fails

- **Refused before it is sent.** An unknown alias, no questions, a question with no options, or
  `jev` without a key rejects with an `Error` that says what to fix, for example
  `decision model "jev" is unavailable: OPENROUTER_API_KEY is not set`. Nothing is sent or
  recorded.
- **Retried.** When OpenRouter can't be reached, is rate limited or has a server error, awf tries
  again, up to three requests in all, waiting longer each time, and not past the deadline. Each
  request may be billed, so the record counts them as `attempts`.
- **Failed.** Any other error, or an answer that skips a question or whose probabilities don't add
  up, rejects with `DecisionError`. You never get a partial answer. The error's `record` is the
  call's record, which the run keeps too.
- **Out of time.** A decision runs under the deadline around it, the run's `--timeout` or a
  `parallel`'s, and rejects with `DeadlineExceededError` when it passes. See
  [Deadlines](/guide/deadlines).

Uncaught, any of these fails the run like any other thrown error. To hand the item to an agent
instead, catch `DecisionError`, as the sample at the top does, and let anything else through: a
missing key then fails the run rather than quietly sending every item to an agent.

The provider sets its own limits on the number of options and levels and the size of the state,
and refuses past them with an error that says which; awf passes it on as a `DecisionError`.

## Testing

`awf test` never calls the model. You script each decision's answers by key, as a probability per
option, a level's probabilities, or just the answer you want:

<<< @/../examples/site/guide/decisions.test.ts#script

A decision with no script fails the test. [Testing](/guide/testing) covers the rest, and the
[testing API](/reference/testing-api#decisions) every form a scripted answer takes.

## See also

- [Decisions](/reference/workflow-api#decisions) in the workflow API.
- [`examples/triage`](https://github.com/romanlv/agentswf/tree/main/examples/triage): tickets
  triaged in parallel, three questions per call, the unsure answers flagged, with its test.
- [Parallel](/guide/parallel): decisions are fast enough to ask for every item of a list at once.
