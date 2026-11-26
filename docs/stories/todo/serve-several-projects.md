---
title: One server for several folders, each at its own prefix
type: story
status: todo
priority: P2
epic: operator
discovered_in: "story 045 review, 2026-11-26"
depends_on: ["045"]
---

# One server for several folders, each at its own prefix

[[045-http-api|Story 045]] serves one project per `awf serve`. A dashboard that watches several
projects would need one server, and one base URL, per project. This todo puts them behind one
server, each project's API unchanged at `/{prefix}/api/…`. Develop it alongside a real dashboard:
the dashboard will show which views across projects are worth building before any are designed.

## Settled in 045

- **Prefixes, not a `?project=` parameter.** One process can't load two engines (ADR 0015), so
  each project is served by its own `awf serve --port 0 --json` child, handed over to its engine,
  and a gateway proxies `/{prefix}/api/*` to it. A parameter would need the same children, change
  every URL, and force the server to merge documents from engines of different versions.
- 045 leaves room for this: a frontend takes its base URL as one opaque string, `GET /api` lists
  paths relative to it, no response carries an absolute URL, and refs are confined to the served
  project (`--this-project`). The token is per user, so one token serves the gateway and every
  child.

## To design

- `awf serve {dir}...`, or the projects in `~/.awf/projects`. Prefixes taken from folder names,
  with collisions settled.
- `GET /api/projects`: each prefix, its project and its engine's version. A project on an engine
  that predates `serve` is listed but not served.
- The children's lifecycle: start, health, restart, and shutdown with the gateway. The token is
  one file per user, so `--new-token` anywhere rotates it for the gateway and every child.
- **One merged inbox stream** at the gateway, each item tagged with its project. A browser holds
  six HTTP/1.1 connections per origin, so a stream per project won't scale past a few. This is the
  one route the gateway would have that isn't a proxy. Whether a runs list across projects needs
  one too is for the dashboard to show.
