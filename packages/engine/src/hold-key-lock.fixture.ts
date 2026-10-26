// Holds a key's lock from another process for `emit.test.ts`: `bun hold-key-lock.fixture.ts {file} {ms}`.
import { withKeyLock } from "./key-lock";

const [file, ms] = process.argv.slice(2);
await withKeyLock(file!, async () => {
  console.log("held");
  await Bun.sleep(Number(ms));
});
