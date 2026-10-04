import { join } from "node:path";
import { harnessState } from "../state";
import { entries, safeId } from "./files";

/**
 * The directory chat `id` lives in under `home`: `chats/{workspace}/{id}`, its `store.db` and a
 * sidecar, the workspace a hash of the directory cursor ran in.
 */
export async function cursorChatDirectory(
  id: string,
  home = harnessState().cursor,
): Promise<string | undefined> {
  if (!safeId(id)) return undefined;
  const chats = join(home, "chats");
  for (const workspace of await entries(chats)) {
    if ((await entries(join(chats, workspace))).includes(id)) return join(chats, workspace, id);
  }
  return undefined;
}
