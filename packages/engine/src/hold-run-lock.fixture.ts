// Holds a run's lock from another process for `emit.test.ts`: `bun hold-run-lock.fixture.ts {file} {ms}`.
import { withRunLock } from "./run-lock";

const [file, ms] = process.argv.slice(2);
await withRunLock(file!, async () => {
  console.log("held");
  await Bun.sleep(Number(ms));
});
