---
title: Public docs for awf-lab's terms, layout and command line
summary: A public page that defines awf-lab's vocabulary, says where each thing lives, and walks through evaluating, developing and viewing, written for any domain with reviews as the first example.
type: story
status: done
discovered_in: "story 008, Terms and where things are"
depends_on: ["008"]
---

# Public docs for awf-lab's terms, layout and command line

Done 2026-09-29: [`packages/lab/docs/reference.md`](../../../packages/lab/docs/reference.md) is the page, with
every item below.

Why it matters: people outside this repository, and the agents they run, will learn `awf-lab` from
its words. Today those words are defined only in story 008, alongside the history of how they were
chosen, and some are still being renamed. Readers coming from Inspect, Braintrust, LangSmith,
promptfoo or Harbor need to see which of their words ours correspond to.

Notes:

- Write it once the terms and command line in story 008 ("Terms and where things are", "The
  command line, revised") are decided and built. Documenting today's words would teach names about
  to change.
- Contents:
  - the glossary, each term with the other tools' words for it;
  - the workspace layout;
  - how to write a variant file and a scorer file;
  - the selection grammar and addresses;
  - the `--json` formats and `awf-lab schema`;
  - the exit codes;
  - one worked session for each job: evaluate, develop, view.
- Keep the generic part separate from the review part: dataset, case, trial, scorer and score are
  generic. Findings, issues and labels belong to reviews, the first kind of dataset.
- Use only public examples: `examples/single-agent-review` and the synthetic set in
  `tests/review-lab.test.ts`. No private project, dataset or case ids.
- Decide where it lives: a page under `docs/` that the package README links to, or the package's
  own README.
