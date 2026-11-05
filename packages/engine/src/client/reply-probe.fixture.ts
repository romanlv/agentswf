// Run by client.test.ts in a process of its own: a program that replies to a run, and says
// whether the engine's author surface was served to it, which only the loader does.
import { authorSurfaceServed } from "../workflow-loader";
import { clientWith } from "./index";

const [file, home] = process.argv.slice(2) as [string, string];
const review = (await import(file)).default;
const result = await clientWith({ home, launch: async () => {} }).emit(
  review,
  "a",
  "thread:reply",
  {
    text: "ok",
  },
);
console.log(JSON.stringify({ outcome: result.outcome, served: authorSurfaceServed() }));
