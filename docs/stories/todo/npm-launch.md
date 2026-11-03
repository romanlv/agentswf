---
title: Release from CI, and settle what the beta left open
type: story
status: todo
priority: P3
epic: launch
discovered_in: "story 009; the 0.1.0 betas, 2026-10-31 to 2026-11-01"
depends_on: ["009"]
---

# Release from CI, and settle what the beta left open

agents.wf is public and published: `agentswf` and `@agentswf/*` at 0.1.0-beta.4, released by hand
with `scripts/release.ts`. What the launch plan of 2026-09-28 still holds open:

- **Trusted publishing.** pi and codex publish from CI on a `v*` tag through npm's OIDC trusted
  publishing; npm trusts a publisher only for a package that already exists, which the betas now
  are. Configure it, so the next release is CI's.
- **Unstable exports.** `./testing` on `agentswf`, `contract`, `engine`, `harness` and `sandbox`:
  mark them unstable, or hold them to the same promise as the rest.
- **`engines.bun`** is `>=1.4.0` on every package, the only version tried: the minimum tested, or
  `BUN_VERSION`? `os: ["darwin", "linux"]` is on none.
- **"charged"**: `output.json`'s `charged` for a headless claude is a harness rule, not a bill
  anyone saw. Rename it, with a record version, while the project is in evaluation; the design is
  [[billing-provenance]].
- **Prerelease tags.** Betas go out under `latest`, so a plain install gets the newest
  (`scripts/release.ts`); tag prereleases by id once out of beta.
