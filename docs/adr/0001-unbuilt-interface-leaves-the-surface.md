# 0001 — Unbuilt interface leaves the published surface

**Decided:** 2026-09-22. **Replaces:** the part of `foundation.md` §12 Stage D that gave fork an
adapter capability flag, and the author-surface types that described behaviour nothing ran.

## What was decided

These came out of `contract` and `harness`:

- `HarnessSession.capabilities.nativeFork` and `NativeForkCapability`.
- `ModelSettings` and `settings` on `ExecutionConfig` and `ExecutionRequirements`.
- `AgentOpenSpec.lifecycle`, with `RetentionPolicy`, `RecoveryPolicy` and `AgentLifecycle`.
- `HarnessSpec.interactiveResume` and `HarnessSpec.confirmed`.
- `HarnessActivation.skills`.

`AgentOpenSpec.skills` stays, because `examples/feature-delivery.ts` is written against it, and the
runner still refuses a non-empty list.

## Why

Nothing implemented any of them. The runner rejected `settings`, non-workflow retention, and crash
recovery at runtime with "not implemented", so a published type promised what a call refused. That
is the trade `foundation.md` warns against: a surface that is plausible rather than right, and
costly to change once workflows compile against it.

The fork flag was also the wrong shape. E7 found that whether a fork is worth taking depends on
(harness, backend), from about the cost of a resume to eleven times a cold agent in a pane
([`findings/`](../findings/README.md)). A boolean cannot carry that. Fork would land as a native
primitive in `harness` and a logical branch in `engine`, with no interface until that cost split is
settled.

## What would bring them back

An implementation and a workflow that needs it, in the same change. Retention and recovery also
need the pane-release measurement that Story 001 defers.
