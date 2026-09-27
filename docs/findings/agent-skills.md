# Agent skills: what each harness loads, and how to narrow it

Story 007's refinement, run 2026-09-26 on macOS 26 (Darwin 25.6), Claude Code 2.1.283, codex-cli
0.157.1, pi 0.87.1. Each row ran once, from a throwaway script in a scratch directory outside any
repository, with one test skill, `awf-probe`, whose body holds a word the model cannot guess
(`ZEBRA-7731`). claude's lists come from the `init` event of `-p --output-format stream-json`,
which names every skill before the first request. codex and pi print no such event, so their lists
are the model's own answer to "list every skill available to you". Such a list proves what is
there, not everything that is: codex's `skill_search` may hold some skills back. The rows that
settle an exact set (K9, K10) are positive checks that nothing else was listed.

| # | Question | Result |
| --- | --- | --- |
| K1 | claude on the operator's home, no flags | **71 skills**: `~/.claude/skills` plus 18 bundled with claude. The operator's `SessionStart` hook ran first, and 7 claude.ai connectors were attached. |
| K2 | claude `--plugin-dir {dir}` holding `skills/awf-probe` | **Added, namespaced**: `awfprobe:awf-probe`. |
| K3 | claude `--add-dir {dir}` holding `.claude/skills/awf-probe` | **Added, under its own name**: `awf-probe`. A headless Haiku turn with awf's own `--allowed-tools Bash` used it and answered `ZEBRA-7731`, with no permission denial, for $0.019. |
| K4 | claude `--disable-slash-commands` | **Every skill gone**, the plugin's too, and the `Skill` tool with them. |
| K5 | claude `--setting-sources project,local --add-dir {dir}` | **The operator's skills and hooks gone**; `awf-probe` and the 18 bundled remain. The claude.ai connectors remain: they come with the login, not with a settings file. |
| K6 | claude with a fresh `CLAUDE_CONFIG_DIR` holding `skills/awf-probe` | **`awf-probe` and the 18 bundled**, nothing of the operator's. `init` only: there was no setup token to run a turn. |
| K7 | codex with a fresh `CODEX_HOME` holding `skills/awf-probe`, `HOME` the operator's | **`awf-probe`, 5 system skills, and `~/.agents/skills`**: codex reads that root from `HOME`, not from `CODEX_HOME`. `-c features.skip_host_skill_discovery=true` changed nothing; codex lists it as under development. |
| K8 | codex `-c skills.bundled.enabled=false` | **The 5 system skills gone.** |
| K9 | codex: as K7, with bundled off and `-c skills.config=[{path=…,enabled=false},…]` for each `~/.agents/skills/*/SKILL.md` by its real path | **Exactly `awf-probe`.** With `HOME` pointed at an empty directory instead, also exactly `awf-probe`, and the model used it and answered `ZEBRA-7731`. |
| K10 | pi `--no-skills --skill {dir}` on the operator's home | **Exactly `awf-probe`**, used, `ZEBRA-7731`. `--skill` without `--no-skills` adds it to the 25 the operator has. |
| K11 | Can codex be given a skill root by a flag or a config key? | **No.** Its roots are `$CODEX_HOME/skills`, `~/.agents/skills`, a system cache, a project's `.codex/skills`, the repository's `.agents/skills` between its root and the working directory, plugins, and roots its app server passes at run time (`codex-rs/ext/skills/src/host_roots.rs`). A skill it can see from the command line has to be in its home. |
| K12 | What does a public skill's name point at? | **A folder with a `SKILL.md`, in a git repository.** The skills CLI (skills.sh) accepts `owner/repo`, a GitHub URL, a tree URL with a ref and a subpath, any git URL and a local path, with `--skill {name}` to pick one. It has no option for where to install: only each harness's home, or `-g` for the operator's. Its lockfile records the source, the path of `SKILL.md` in the repository, and a hash of the folder. |

What changed the design:

- Every harness can be given an exact set of skills, but each by a different mechanism, and codex
  only through its home (K9, K11). Resolution per harness is therefore the harness's business, as
  foundation §7 placed it; the author names sources, not flags.
- The harness's bundled skills are separate from the operator's. codex's can be turned off (K8);
  claude's go only with every other skill (K4).
- Narrowing claude outside a sandbox also drops the operator's hooks and other user settings (K5).
- A public skill is a pinned folder in a repository, which the engine can fetch itself (K12).
