# How comparison tools are configured and named

Checked 2026-09-27 for [story 008](../stories/008-review-scorer.md), section "The command line". We
read the docs of Playwright Test, Vitest, DVC, promptfoo, Inspect AI, Harbor and Turborepo, and the
source of Vitest 5.0, promptfoo, Harbor and Inspect as of their main branches on 2026-09-26.
Orchestration and records are in [`eval-orchestration`](eval-orchestration.md); this page is about
the workspace config, the command line and the name.

The short version: tools split by what their config holds. Where the config holds code (plugins,
fixtures, hooks), it is TypeScript: Playwright, Vitest. Where it holds data and points at code, it
is YAML or JSON with a schema: DVC, promptfoo, Harbor, Inspect's run config, Turborepo. Our
workspace config holds only names, paths and a budget. The code (`read`, the judge's argv) is
already in the variant and judge files, so the config belongs to the second family. Keep the
variant and judge files in TypeScript, and make the config small: a JSON file with a generated
schema, with variants and judges found by file glob, not listed. No test or eval tool we read walks
up for its config; git and DVC walk up to their root, and the story's walk-up is right for a workspace. "eval" clashes with this
repository's own word for `*.eval.ts`, which may be why the name grates.

## 1. Playwright Test

- **Format and discovery.** `playwright.config.{ts,js,mjs,cjs}` with `defineConfig`, looked for in
  the current directory only. `-c/--config` takes a file or "a test directory with optional
  playwright.config" ([CLI](https://playwright.dev/docs/test-cli)). TypeScript because the config
  carries code: `webServer`, `globalSetup`, device presets spread into `use`.
- **Named variants.** `projects: [{ name, use }]` runs one suite under several settings.
  `--project` selects them and "supports '\*' wildcard". A project can depend on another
  ([projects](https://playwright.dev/docs/test-projects)).
- **Files by convention.** Tests are found by `testDir` and `testMatch`, a glob with a default. The
  config says where to look, not what exists
  ([configuration](https://playwright.dev/docs/test-configuration)).
- **Per run.** Flags narrow the run: `--repeat-each {n}`, `--last-failed` ("Only re-run the
  failures"), `--only-changed [ref]`, and `--list` ("Collect all the tests and report them, but do
  not run"). `--pass-with-no-tests` exists because an empty selection fails by default.
- **Output.** Reporters are chosen by name and combine: `list` locally, `dot` on CI, `json`, `junit`,
  `html`, and `blob` for merging shards. File outputs come from `outputFile` or an env var such as
  `PLAYWRIGHT_JSON_OUTPUT_NAME`. Artifacts go to `outputDir` (default `test-results`), and
  `show-report` opens the HTML report later ([reporters](https://playwright.dev/docs/test-reporters)).

## 2. Vitest

- **Format and discovery.** `vitest.config.*`, then `vite.config.*`, in the root only. The source
  checks `resolve(root, name)` for each name, with no walk-up (`findConfigFile` in
  [`resolveConfig.ts`](https://github.com/vitest-dev/vitest/blob/main/packages/vitest/src/node/config/resolveConfig.ts)).
  JS or TS only: it "doesn't support `json`" ([config](https://vitest.dev/config/)).
- **Named variants.** `test.projects` takes inline configs, files or globs: `['packages/*']` makes
  every folder a project "even if it doesn't have a config file inside". A file is accepted only if
  its name matches `vitest.{name}.config.*`. `--project` takes `*` and `!` patterns
  ([projects](https://vitest.dev/guide/projects)). The old separate workspace file was deprecated in
  3.2 for this key in the one config.
- **Comparison.** Vitest 5 removed `bench --compare` and `--outputJson`. A bench now writes its
  result with `writeResult`, and `bench.from(name, path)` reads a stored one into `bench.compare()`,
  so "the original benchmark code can be deleted once the artifact is committed"
  ([benchmarking](https://github.com/vitest-dev/vitest/blob/main/docs/guide/benchmarking.md),
  [migration](https://github.com/vitest-dev/vitest/blob/main/docs/guide/migration/index.md)). That is a
  comparison against stored results, not a rerun of both sides, as in our design.

## 3. DVC experiments

- **Format.** `dvc.yaml` declares stages with `cmd`, `deps`, `params`, `outs` and `metrics`.
  Parameters live in `params.yaml`, and `${}` substitutes them into stages. `foreach` and `matrix`
  expand one stage into named copies (`train@cnn-feature1`)
  ([dvc.yaml](https://doc.dvc.org/user-guide/project-structure/dvcyaml-files)). The code stays in
  scripts, and YAML only names it.
- **Identity and reuse.** `dvc.lock` records the hash of every dependency and parameter per stage.
  `repro` reruns only the stages whose hashes changed. The run cache in `.dvc/cache/runs` keeps
  earlier signatures, so a stage "run with the same dependencies and outputs" restores its outputs
  without running ([run cache](https://doc.dvc.org/user-guide/pipelines/run-cache)). `repro --dry`
  "only print[s] the commands that would be executed". `--force` runs everything, and
  `--no-run-cache` exists for stages that are not deterministic
  ([repro](https://doc.dvc.org/command-reference/repro)).
- **Per run.** `dvc exp run -S train.lr=0.01` edits `params.yaml` "on-the-fly before execution".
  The override becomes part of the experiment's recorded state, not a flag that vanishes. `--queue`
  with `-S a,b` builds a grid
  ([running experiments](https://doc.dvc.org/user-guide/experiment-management/running-experiments)).
- **Output.** `dvc exp show` prints a table of metrics and params, and has `--json`, `--csv`, `--md`,
  `--only-changed` and `--sort-by` ([exp show](https://doc.dvc.org/command-reference/exp/show)).
  `dvc params diff` and `metrics diff` compare two revisions.
- **Discovery.** DVC finds its project root by walking up to `.dvc/`, like git.

## 4. promptfoo

- **Format and discovery.** `promptfooconfig.{yaml,yml,json,cjs,cts,js,mjs,mts,ts}`, tried in that
  order, in the current directory only
  ([`config/extensions.ts`](https://github.com/promptfoo/promptfoo/blob/main/src/util/config/extensions.ts),
  [`config/default.ts`](https://github.com/promptfoo/promptfoo/blob/main/src/util/config/default.ts)),
  or `-c` for one or more files. YAML is the documented default, with
  `# yaml-language-server: $schema=https://promptfoo.dev/config-schema.json` for the editor
  ([reference](https://www.promptfoo.dev/docs/configuration/reference/)).
- **Code from data.** `file://` points anywhere code is needed: `file://provider.js`,
  `file://transform.js:customTransform`, and tests from CSV, JSONL or TS
  ([guide](https://www.promptfoo.dev/docs/configuration/guide/)).
- **Variants.** The matrix is prompts × providers × tests, all listed in the config.
  `--filter-providers` and `--filter-pattern` narrow it, and `--var k=v` overrides a variable.
- **Output.** `-o` writes csv, json, jsonl, yaml, html or junit.xml. `promptfoo view` serves the
  stored results. `eval` exits 100 on failed tests or a pass rate below the threshold, and
  `PROMPTFOO_FAILED_TEST_EXIT_CODE` changes it
  ([command line](https://www.promptfoo.dev/docs/usage/command-line/)). Nine config extensions is
  the cost of never saying no.

## 5. Inspect AI

- **Format.** Tasks are Python functions under `@task`, and their parameters are the variants:
  `-T system=researcher.txt`, or `--task-config` as YAML or JSON. Tasks are found by
  `file.py@name`, by scanning a directory, or by package entry points
  ([tasks](https://inspect.aisi.org.uk/tasks.html)).
- **Run config.** `--run-config` is one YAML or JSON file with task, model, model roles, generate
  config, solver and eval config. "Explicit CLI flags override values from this file." The order is
  task defaults, then `task_with()`, then env and `.env`, then CLI
  ([run config](https://inspect.aisi.org.uk/tasks.html#run-config)).
- **Env.** Every flag has an env twin, `INSPECT_EVAL_{FLAG}`, and `.env` files "are searched for in
  parent directories" ([options](https://inspect.aisi.org.uk/options.html)). That walk-up is for
  `.env`, not for a config.
- **Reuse.** `eval-set` treats the log directory as the scope of finished work: "simply re-execute
  the same command and any work not yet completed will be scheduled"
  ([eval sets](https://inspect.aisi.org.uk/eval-sets.html)). Resume by rerun, as in story 008.

## 6. Harbor

- **Format.** A job config is YAML or JSON with the same controls as `harbor run` flags. `-c` can
  repeat, and "later configs override earlier ones. Additive lists append; [] clears them." Custom
  agents, environments and verifiers are referenced by `import_path` (`module:Class`). `harbor job
  init` writes a config from flags, `harbor job schema` prints its JSON Schema, and
  `--print-config` prints the resolved config and exits
  ([configs](https://docs.harborframework.com/core-concepts/jobs/configs),
  [`cli/jobs.py`](https://github.com/laude-institute/harbor/blob/main/src/harbor/cli/jobs.py)).
- **What would run.** `--diff {job}` "prints a reuse/regrade/rerun preview before running", and
  with `--dry-run` it only shows the comparison. `harbor job resume {dir}` continues from the job
  directory's `config.json`.

## 7. Turborepo, for the dry run

`turbo.json` is JSON with `$schema`. `turbo run --dry=json` prints, per task, its `hash`, `inputs`,
`outputs`, command and dependencies without running anything. `--summarize` writes the same
facts after a real run to `.turbo/runs/`, and `--force` ignores the cache
([run](https://turborepo.dev/docs/reference/run)). The hash in the dry run is what makes a cache miss
explainable.

## For awf

**(a) Format: data config, code in variant files.** The story rejects JSON because "`read` is code".
But `read` sits in the variant file, not in the config. The config is names, paths, a default set,
a default judge, an incumbent and a budget, which is the promptfoo, Harbor and Turborepo case.

| | TypeScript config | JSON with a schema | Convention only |
| --- | --- | --- | --- |
| a person | types from `defineEvalConfig`; can compute (a bad property for identity) | editor checks from `$schema`; no comments | nothing to write; names are file names |
| an agent in the loop | edits text; cannot safely rewrite it by program | reads and writes it as data | creates or renames a file |
| awf | must import it to read it | one generated schema, as for `set.json` | defaults can't express the incumbent or budget |

Recommendation: `{name}.json` at the workspace root, with `$schema` pointing at a schema generated
from the TS type, as `packages/lab/schema/` already is for fixtures. Support exactly one
format; promptfoo's nine extensions are a surface with no user. Keep `defineReviewVariant` and
`defineReviewJudge` in TS: those files carry code, and that is Playwright's and Vitest's reason.
If comments matter more than program edits, TOML is the other candidate: Bun imports it natively.
YAML adds a parser and its surprises for no gain here.

**(b) Discovery and overrides.** Walk up from the current directory to the first config, as git and
DVC find their roots. None of the test tools do it, but a workspace is a place you work inside, and
`scores/` is where you'll be. `--config {file}` (Playwright's `-c`) overrides it. No env twin
for every flag (Inspect's `INSPECT_EVAL_*`): env stays for the OpenRouter key and the like, which
is already how `.env` is read. No generic override like `-S` or `--var` either. DVC can offer one
because the override is written into `params.yaml` and becomes part of the experiment. Ours would
be an argv change outside any file, a variant with no file. To try an argument, copy the variant
file. The hash keeps the records apart, and the file is what `report` names. Add Harbor's
`--print-config` or a `list` command: the resolved workspace, each variant's name, path and
hash, the judges and sets. `plan` answers per fixture, and this answers "what does this workspace
see".

**(c) Discover variants and judges by glob, not by list.** Take Vitest's middle path. The config
names where to look, and a file's stem is its name:

```json
{
  "$schema": "https://…/eval-workspace.schema.json",
  "variants": ["../agent/workflows/*.variant.ts"],
  "judges": ["judges/*.judge.ts"],
  "set": "first",
  "judge": "panel",
  "incumbent": "catalogue",
  "budget": { "usd": 25 }
}
```

`sets: "fixtures"` and `scores: "scores"` become defaults that the file may override, since ADR
0003 already fixes `fixtures/{set}/`. The glob is needed because variants live in the workflows
repository, not in the workspace. Plain convention would not find them. "Give it a name in the
config" becomes "name the file", which a loop can do without editing JSON. Records are keyed by
hash, so a rename orphans nothing, as the story already says. The package's shipped judge answers
to a reserved name, and two files with one stem are an error naming both. A path on the command line
still works for an unnamed idea.

**(d) Output and exit codes worth copying.**

- `--json` on every command, as DVC's `exp show` has, and `--md` on `report` for a merge-request
  comment. Reporters by name (Playwright) are more than one report needs.
- `plan --json` as the dry run: per fixture and repeat, the action, why, and the hashes compared
  (Turborepo's `--dry=json`, Harbor's `--diff`). A reuse that can't be explained can't be trusted.
- stdout for the result and stderr for progress, as the story has.
- An empty selection is an error, as in Playwright, not a silent success.
- Exit codes: argparse and many CLIs use 2 for a usage error, and the story gives 2 to "stopped by
  the budget". Consider 0 done, 1 failure, 2 usage or config error, then separate codes for budget
  and declined. Keep "a variant lost" out of the exit code until gating exists; promptfoo's 100 is
  that gate, and `variant-matrix-runner` owns it.
- A `--force` equivalent in the spirit of DVC's `--no-run-cache` isn't needed: agent runs are not
  deterministic, and `--repeats` asks for more samples without discarding the ones already there.

**(e) The name.** Foundation §7 separates evals (`*.eval.ts`, "does this still work") from
autoresearch ("which combination is better"). `awf-eval` names this tool after the other thing.

- `awf-lab`: experiments on workflows with controls. `awf-lab plan`, `run` and `report` read well,
  and it covers the loop later.
- `awf-bench`: a workbench and a benchmark. Clear, but "bench" suggests speed timings (Vitest,
  Criterion).
- `awf-trial`: running candidates against known answers. It collides with Harbor's "trial", and
  with our run.
- `awf-exp`: DVC's word, short, but it also reads as export or exponent.
- `bakeoff`: variants head to head, which is what `report` does. It is memorable, but has no awf
  prefix, so it is harder to find.
- `awf-eval`: honest, and it matches Inspect and promptfoo, but it overloads the repository's own
  word.

**Git-style dispatch.** `git {x}` runs `git-{x}` from `PATH`, as do cargo
([custom subcommands](https://doc.rust-lang.org/cargo/reference/external-tools.html#custom-subcommands))
and kubectl ([plugins](https://kubernetes.io/docs/tasks/extend-kubectl/kubectl-plugins/)). A
fallback in `operator-cli.ts` that execs `awf-{x}` for an unknown verb names nothing from
autoresearch, so it keeps the letter of ADR 0002: the engine still doesn't learn about it. But
it is a published surface, the plugin protocol (argv, environment, exit codes, help and
completion), and ADR 0001 admits one only with its user in the same change. The user would exist.
The gain is two keystrokes and the risk of reading `awf lab run` as `awf run`. Ship the separate
binary now, and add the dispatch when a second `awf-{x}` exists.
