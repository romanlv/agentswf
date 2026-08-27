# Review of `messaging.md`

Notes on the current draft. The design is a large improvement on what it replaced: one verb, no
rosters, no `grant`/`revoke`, permissions held by the workflow. The response obligation, with the
engine refusing `wf result` while one is outstanding, is the strongest part — it turns "you owe an
answer" into a state the engine enforces instead of a convention the prompt hopes for.

Disposition notes below evaluate the original review against the current `messaging.md`; the review
text is retained so the reasoning remains inspectable.

Three problems below are structural. The first one breaks the flagship scenario.

## Issues

### The review-until-convergence scenario cannot run as written

The diagram has the reviewer idle until the implementer's first message arrives. Nothing in the CLI
lets it idle. `receive` is deferred to a planned extension on the grounds that no current scenario
needs an agent to wait without first sending — but this scenario needs exactly that.

The reviewer's prompt tells it to message the implementer with a response expectation,
unconditionally, at the start of its run, before anything has been implemented. Its choices are to
send a meaningless first message purely to enter the exchange, to spin, or to return. `receive` is
not an extension; it is the missing half of the protocol.

**Disposition: accepted in substance.** The implementation now finishes before the reviewer starts.
The reviewer owns the revision loop, and each message wakes the idle retained implementer. This
does not require `receive`: inbound delivery creates an engine-owned message operation whose task is
the route purpose and authenticated message.

### Delivery to a working agent is unspecified

"Messages arriving while the recipient works remain in its inbox" — and then what reaches the
model? Injection into the pane, an appended tool result, or only an explicit `receive`? This is the
central mechanic and it is the one thing the document does not state.

Everything downstream depends on the answer: whether the reviewer notices a revision mid-review,
and whether a `--expect-response` sent to a busy agent can be answered before its deadline.

**Disposition: already addressed.** The current design presents messages at the next safe model
continuation and adds `HarnessTurn.deliver` to the internal harness seam. Required messages keep the
bound result slot open and cause the same operation to resume when direct injection is unavailable.

### Crossing expectations deadlock until the deadline

Nothing enforces the strict alternation the diagram shows. If both agents send with
`--expect-response` before either reads its inbox, each blocks waiting for a message the other has
already sent. An obligation is satisfied by the recipient's *next* accepted send, so a message
already sitting in the inbox does not count, and neither agent is generating, so neither can send
again. Both burn the full timeout and fail.

The fix is small: let an unread message from the target satisfy the obligation when it was accepted
after the obligation's own message. It has to be decided either way. Open question 4 treats the
aftermath as unresolved while the main scenario depends on it.

**Disposition: already addressed.** Send acceptance is atomically ordered. A later crossing send
satisfies the earlier obligation and creates the reverse obligation, so the first sender resumes.
The earlier request remains scheduled for delivery; matching does not pretend the model read it.

## Smaller points

- **Ten minutes is probably the ceiling, not a choice.** Claude Code's shell tool caps at ten
  minutes, so `--expect-response 10m` sits exactly at the limit and nothing longer works in a pane.
  Worth recording as a harness constraint rather than leaving open question 1 to discover it.

  **Disposition: rejected as a portable contract.** A tool timeout is harness-specific and may
  change independently of this interface. The engine owns a bounded default and maximum for each
  supported adapter; examples do not present ten minutes as a universal capability. Adapters that
  cannot hold an invocation open may suspend and resume the same operation instead.
- **A refused response send strands the obligation.** If the recipient's reply hits a message or
  spend limit, the recipient gets a CLI error and the sender waits out the deadline for a reply the
  engine itself blocked. A refusal of a send that would have satisfied an obligation should surface
  to the waiter.

  **Disposition: accepted.** A rejected reply now ends the obligation and returns the same failure
  to the waiter when the engine can identify the intended peer.

- **Oldest-first matching silently captures unrelated messages.** On a `between` route, if B owes A
  a response, any message B sends A becomes that response. The document forbids this for the
  temporary single-use permission but not for the case where the route already permits the send.
  State it as the known cost of having no correlation id.

  **Disposition: accepted.** The document now states that every accepted send to the waiting peer
  counts and identifies this as the deliberate cost of hiding correlation ids.

- **`allow` idempotency is keyed on purpose,** so two grants for the same pair with different
  purposes are two routes. What does the agent then see — both purposes? The same question applies
  to a `between` that overlaps an existing `from`/`to`.

  **Disposition: already addressed.** Each directed pair has one purpose. A conflicting purpose
  rejects atomically rather than creating another route or partially expanding `between`.

- **"Stopping" an agent** appears once and is never defined against cancellation.

  **Disposition: accepted.** Stopping removes the logical agent's routes; cancelling an operation
  fails only obligations bound to that operation and leaves later queued work possible.

- **A grant to a running agent is invisible to it** until its next run, though the engine enforces
  it immediately. The document says to grant before starting; the asymmetry is worth one line.

  **Disposition: accepted.** Active instructions are not rewritten. The agent discovers a new route
  through `wf peers` or an authenticated inbound envelope.

## Improvements worth taking

### Make the duration optional and let the recipient's run bound it

The engine already refuses the recipient's `wf result` while it owes a response, so the natural
deadline is: the recipient responds, settles, or fails, subject to an engine ceiling. A model
picking wall-clock minutes out of a prompt is guessing at how long a review takes; the engine is
not. Keep an explicit duration as an override.

**Disposition: partially accepted.** `--expect-response` now uses an engine-defined deadline, with
`--timeout` as an optional bounded override. The recipient's run cannot be the only bound because
the engine also prevents that run from returning while it owes a response; without an independent
deadline, an idle or stuck recipient could keep both operations open indefinitely.

### Promote `receive` into the design

Beyond fixing the first issue, it removes the asymmetry: the reviewer receives, works, and responds;
the implementer sends and expects. That is the whole protocol in two verbs. It also makes the
distinction the document already worries about easier to hold, because intentional waiting becomes
an explicit operation rather than something inferred from an idle agent.

**Disposition: rejected for the current interface.** The reviewer can inspect completed work
immediately, and its inbound message wakes the retained implementer without a workflow prompt or an
active operation waiting in `receive`. Adding `receive` would serve the different case where an
already active operation must pause for unspecified future input. That case remains a planned
extension.

### Name the fallback for open question 1

If a harness cannot hold a shell invocation open, the alternative is the turn-boundary form: the
send ends the sender's turn, and the engine resumes it with the reply as its next turn. The workflow
sees no difference, since the run stays pending either way, but the sender is not executing while it
waits. That is a different shape, and it should be named now, because the result of that experiment
decides which design ships.

**Disposition: accepted.** The adapter seam now names blocked invocation and suspended continuation
as equivalent strategies. Both preserve the same `AgentRef.run`, result slot, context, and usage
record.

## Verification against the current `messaging.md`

Checked each disposition against the document. All three structural issues and all six smaller
points are resolved. Two of the three improvements were taken; the third was taken in the design but
has no disposition note above.

### Structural issues

- **Review sequencing — resolved.** The implementer completes its initial workflow run before the
  reviewer starts. The reviewer has real work at t=0, and its first send wakes the retained
  implementer in an engine-owned message operation. No placeholder send or passive receive is
  needed.
- **Delivery to a working agent — resolved.** "Delivery and failure" now separates ordinary from
  required messages, `HarnessTurn.deliver` gives the adapter the continuation hook, and required
  messages hold the result slot open until presented. This is specified further than the objection
  asked for.
- **Crossing expectations — resolved.** Atomic acceptance ordering, with the later send satisfying
  the earlier obligation and creating the reverse one. One agent is always runnable.

### Smaller points

Ten-minute ceiling: rejected as a portable contract, and correctly — the suspended-continuation
adapter form removes the cap entirely, so it is not an interface concern. Refused reply stranding
the waiter: fixed explicitly, including the case where a local input error cannot identify the peer.
Oldest-first matching: fixed more strongly than proposed — at most one outgoing obligation per
operation removes the ambiguity rather than documenting it, and the residual cost is stated. `allow`
purpose conflicts: fixed, a conflicting redeclaration rejects atomically. Stop versus cancel: both
defined. Grant invisible to a running operation: stated, with `wf peers` as the recovery.

### Improvements

The response deadline is now engine-owned with `--timeout` as a bounded override. The counter-point
in the disposition is right and the original suggestion was circular: the recipient's run cannot be
the only bound, because the engine also prevents that run from returning while it owes a reply.

Rejecting `receive` follows from the rewritten scenario: inbound work wakes an idle retained agent,
while the reviewer starts with completed work it can inspect. `receive` remains useful only if an
active operation later needs to wait for unspecified input.

Naming the fallback for the waiting strategy was accepted in the design but has no disposition note.
The adapter seam now names both blocked invocation and suspended continuation, and the open question
asks which one each harness can support.

## Further findings from the rewrite

- **A crossing reply may predate the message it answers — resolved.** The waiting sender receives
  an authenticated crossing notice stating that the peer sent its message before seeing the
  request and that the message must not be interpreted as an answer to it.
- **A refusal for "no response-capable operation" has no place to go in the scenario — resolved.**
  An expected-response send can now create a message operation for an idle retained recipient. The
  send is refused only when the target cannot own such an operation, such as after it is stopped or
  its retention expires.
- **`deliver` returned after queueing rather than presentation — resolved.** Its promise now
  resolves only after the engine-authored prompt has been presented in the continued operation.
- **The planned-extension example used the harness ceiling as its timeout — resolved.** The
  example now uses an ordinary bounded override rather than the known pane ceiling.
