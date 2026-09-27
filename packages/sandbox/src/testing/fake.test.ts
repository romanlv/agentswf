import { sandboxConformance } from "./conformance";
import { createFakeSandboxProvider } from "./fake";

// A fake confines nothing; the rest of the suite still holds, which is what engine tests lean on.
sandboxConformance("fake", { provider: createFakeSandboxProvider().provider, confines: false });
