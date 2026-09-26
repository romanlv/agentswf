/** The parts of GitLab's REST and GraphQL responses that collect reads. */

export type GitLabMergeRequest = {
  title: string;
  description: string | null;
  state: "opened" | "merged" | "closed" | "locked";
  draft: boolean;
  web_url: string;
  updated_at: string;
  author: { username: string };
};

export type GitLabProject = { default_branch: string };

export type GitLabVersion = {
  id: number;
  head_commit_sha: string;
  base_commit_sha: string;
  start_commit_sha: string;
  created_at: string;
};

export type GitLabPosition = {
  head_sha: string;
  new_path?: string | null;
  old_path?: string | null;
  new_line?: number | null;
  old_line?: number | null;
};

export type GitLabNote = {
  id: number;
  type: string | null;
  body: string;
  system: boolean;
  created_at: string;
  author: { username: string };
  resolvable?: boolean;
  resolved?: boolean;
  /** Where the comment is now: GitLab moves it to the newest version, so it can't date one. */
  position?: GitLabPosition | null;
};

export type GitLabDiscussion = { id: string; notes: GitLabNote[] };

/** A "changed the description" system note: `description` is the text after that edit. */
export type DescriptionVersion = {
  createdAt: string;
  author: string;
  description: string;
  /** GitLab's inline HTML diff against the version before; the only record of the original. */
  diff: string | null;
};

/** Everything collect reads about one merge request. */
export type MergeRequestData = {
  project: GitLabProject;
  mr: GitLabMergeRequest;
  versions: GitLabVersion[];
  discussions: GitLabDiscussion[];
  descriptions: DescriptionVersion[];
};
