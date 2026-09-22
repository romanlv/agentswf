# Archived experiments

E1–E3 and E5–E6, frozen. The scripts still run; the raw results beside them are the evidence
[`docs/findings/`](../../docs/findings/) is written from, and the only copy of it — the
per-experiment reports were removed once their prose was distilled. **Do not refactor this to
taste** — rewriting an experiment is editing evidence.

Three kinds of thing live here.

- **Measurement scaffolding** — `trial.ts`, `runner.ts`, and the per-experiment scripts. Built
  to produce the numbers, not to survive into the engine.
- **E2 vocabulary** — `return-method.ts` and `fake-reporting.ts`. E2 measured three ways for an
  agent to hand a value back and all three worked; production settles through one, so the other
  two stay here rather than in the engine's surface.
- **Shelved but working** — `journal.ts` and its tests. E6 built it, it passes, and it is
  deliberately not wired in. `docs/foundation.md` §12 puts it after messaging and composition.

[`deps.ts`](deps.ts) is the one place these files reach into the packages. It exists so that a
package move does not mean editing evidence, and it imports public entrypoints only.

## Running the live experiments

Each spends real money on real agents. From this directory:

```sh
sh e2/run-all.sh                          # the full E2 matrix
bun run e2/report.ts e2/results/e2.jsonl  # delivery, timing and cost tables
bun run e3.ts --run e3 --reps 5           # the three call shapes, four harnesses
bun run e5.ts                             # per-field errors against a bare refusal
```

Panes use the `wf-lab` Herdr session, never `review-loop`. Start that server from a shell with
no `CLAUDE_*` variables set, or claude panes record no usage — see the E1 findings.
