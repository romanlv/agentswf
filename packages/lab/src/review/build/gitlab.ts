import type { DescriptionVersion, MergeRequestData } from "../fixtures/gitlab-types";

/** Read-only access to merge requests on one forge. Tests supply their own. */
export interface MergeRequestSource {
  fetch(project: string, iid: number): Promise<MergeRequestData>;
}

/** Runs `glab api <args>` and returns its standard output. */
export type GlabRunner = (args: string[]) => Promise<string>;

const PAGE = 100;

const DESCRIPTION_NOTES = `query($fullPath: ID!, $iid: String!, $after: String) {
  project(fullPath: $fullPath) {
    mergeRequest(iid: $iid) {
      notes(first: ${PAGE}, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          createdAt
          author { username }
          systemNoteMetadata { action descriptionVersion { description diff } }
        }
      }
    }
  }
}`;

type NotesPage = {
  data?: {
    project?: {
      mergeRequest?: {
        notes: {
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
          nodes: {
            createdAt: string;
            author: { username: string } | null;
            systemNoteMetadata: {
              action: string;
              descriptionVersion: { description: string | null; diff: string | null } | null;
            } | null;
          }[];
        };
      } | null;
    } | null;
  };
  errors?: { message: string }[];
};

/**
 * GitLab through `glab api`, so authentication is whatever the operator's glab already has and no
 * token passes through awf. Only GET requests and GraphQL queries are made.
 */
export function glabSource(
  options: { hostname?: string; run?: GlabRunner } = {},
): MergeRequestSource {
  const host = options.hostname ? ["--hostname", options.hostname] : [];
  const run = options.run ?? spawnGlab;
  const api = async <T>(args: string[]): Promise<T> =>
    JSON.parse(await run([...host, ...args])) as T;

  async function all<T>(path: string): Promise<T[]> {
    const items: T[] = [];
    for (let page = 1; ; page++) {
      const batch = await api<T[]>([`${path}?per_page=${PAGE}&page=${page}`]);
      items.push(...batch);
      if (batch.length < PAGE) return items;
    }
  }

  async function descriptions(project: string, iid: number): Promise<DescriptionVersion[]> {
    const versions: DescriptionVersion[] = [];
    let after: string | null = null;
    do {
      const page: NotesPage = await api([
        "graphql",
        "-f",
        `query=${DESCRIPTION_NOTES}`,
        "-f",
        `fullPath=${project}`,
        "-f",
        `iid=${iid}`,
        ...(after ? ["-f", `after=${after}`] : []),
      ]);
      if (page.errors?.length) {
        throw new Error(`GitLab GraphQL: ${page.errors.map((e) => e.message).join("; ")}`);
      }
      const notes = page.data?.project?.mergeRequest?.notes;
      if (!notes) throw new Error(`GitLab GraphQL: no merge request ${project}!${iid}`);
      for (const node of notes.nodes) {
        const version = node.systemNoteMetadata?.descriptionVersion;
        if (node.systemNoteMetadata?.action !== "description" || !version) continue;
        versions.push({
          createdAt: node.createdAt,
          author: node.author?.username ?? "",
          description: version.description ?? "",
          diff: version.diff,
        });
      }
      after = notes.pageInfo.hasNextPage ? notes.pageInfo.endCursor : null;
    } while (after);
    return versions;
  }

  return {
    async fetch(project, iid) {
      const path = `projects/${encodeURIComponent(project)}`;
      const mr = `${path}/merge_requests/${iid}`;
      const [info, request, versions, discussions, described] = await Promise.all([
        api<MergeRequestData["project"]>([path]),
        api<MergeRequestData["mr"]>([mr]),
        all<MergeRequestData["versions"][number]>(`${mr}/versions`),
        all<MergeRequestData["discussions"][number]>(`${mr}/discussions`),
        descriptions(project, iid),
      ]);
      return { project: info, mr: request, versions, discussions, descriptions: described };
    },
  };
}

async function spawnGlab(args: string[]): Promise<string> {
  const child = Bun.spawn(["glab", "api", ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const what = args.find((arg) => !arg.startsWith("-")) ?? "";
  if (code !== 0) throw new Error(`glab api ${what} failed (${code}): ${err.trim()}`);
  return out;
}
