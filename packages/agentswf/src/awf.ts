#!/usr/bin/env -S bun --no-env-file
import { dirname } from "node:path";
import { handOver } from "@agentswf/engine/hand-over";
import manifest from "../package.json" with { type: "json" };

// Before the engine loads: a project at another version runs on its own (ADR 0014).
await handOver({ dir: dirname(import.meta.dir), version: manifest.version });
const { main } = await import("@agentswf/engine/cli");
await main();
