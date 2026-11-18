#!/usr/bin/env -S bun --no-env-file
import { runCases } from "./cases/lab/cli";

if (import.meta.main) process.exit(await runCases(Bun.argv.slice(2)));
