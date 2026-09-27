---
name: ticket-doc
description: Write or revise an implementation-ready ticket document. Use when asked to create, update, or keep current the ticket doc for a feature.
---

# Ticket doc

A ticket doc is the decision record for one feature. Keep it in the repository, in Markdown, and
keep it current as the work changes.

It has these sections, in order:

1. **Outcome** — what a user or system can observe when the work is done, and why it matters now.
2. **Current behavior** — what the code does today, verified by reading it, with paths.
3. **Proposed change** — the smallest coherent change: the modules, interfaces and invariants it
   touches, and the alternatives rejected with a reason each.
4. **Acceptance** — checks a reviewer can run, each with its expected result.
5. **Open questions** — what is not settled, and what each one blocks. Write `None.` when empty.

Verify every claim about current behavior against the code before writing it. Name files and
symbols, not line numbers alone. When the implementation departs from the doc, update the doc in
the same change and say why.
