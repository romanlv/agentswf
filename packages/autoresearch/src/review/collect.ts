import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { descriptionAt, stripMarkedBlocks, titleAt } from "./description";
import { COLLECT_RECORD_FORMAT, type CollectRecord, FIXTURE_FORMAT, type Fixture } from "./format";
import { branchTip, remoteOf, Scratch } from "./git";
import type { MergeRequestSource } from "./gitlab";
import type { MergeRequestData } from "./gitlab-types";
import {
  type CodeComment,
  codeComments,
  findReviewStart,
  type OrderedVersion,
  orderVersions,
} from "./review-start";
import { fixtureId } from "./set";
import { describeProblems } from "./validate";
import { SNAPSHOT_REF, verifyFixture } from "./verify";

export type CollectOptions = {
  /** GitLab project path, such as `group/name`. */
  project: string;
  mr: number;
  /** A full local clone of the project. It is read, never written. */
  clone: string;
  /** The set's folder; the fixture is written to `<out>/<id>/`. */
  out: string;
  /** Skip the review-start rule and freeze this version (1 for the first push). */
  version?: number;
  /** Where to fetch old commits from. Defaults to the clone's `origin`. */
  remote?: string;
};

export type Collected = {
  status: "collected";
  id: string;
  dir: string;
  version: number;
  /** Anything a person checking the fixture should know. */
  notes: string[];
};

export type Excluded = {
  status: "excluded";
  project: string;
  number: number;
  reason: "draft" | "no-review" | "code-unavailable";
  detail: string;
};

/**
 * Freezes one MR as a fixture: the code at the version review started on, the title and
 * description as the reviewer read them, and the raw data an answer key is later drafted from.
 * The fixture appears whole or not at all.
 */
export async function collect(
  options: CollectOptions,
  deps: { source: MergeRequestSource; log?: (stage: string) => void },
): Promise<Collected | Excluded> {
  const { project, mr: number } = options;
  const log = deps.log ?? (() => {});
  const id = fixtureId(project, number);
  const dir = join(options.out, id);
  if (existsSync(dir)) throw new Error(`${dir} already exists; remove it to collect again`);
  const excluded = (reason: Excluded["reason"], detail: string): Excluded => ({
    status: "excluded",
    project,
    number,
    reason,
    detail,
  });

  log("Fetch the MR from GitLab");
  const data = await deps.source.fetch(project, number);
  const { mr } = data;
  if (mr.state === "opened" && mr.draft) {
    return excluded("draft", "still a draft, so nobody has reviewed it");
  }

  const scratch = new Scratch(options.clone);
  const staging = `${dir}.partial`;
  try {
    log("Fetch every version's commits");
    const ordered = orderVersions(data.versions);
    const unavailable = scratch.fetch(
      remoteOf(options.clone, options.remote),
      ordered.flatMap((version) => [version.base_commit_sha, version.head_commit_sha]),
    );

    log("Find the version review started on");
    const start = chooseVersion(options.version, ordered, data);
    if (start.kind === "excluded") return excluded(start.reason, start.detail);
    const { version } = start;
    if (!scratch.has(version.head_commit_sha) || !scratch.has(version.base_commit_sha)) {
      return excluded("code-unavailable", `version ${version.ordinal}'s commits can't be fetched`);
    }

    log("Recover the title and description");
    const request = requestAt(start.readAt, data);
    const notes = [...start.notes, ...request.notes];
    if (unavailable.length > 0) {
      notes.push(`${unavailable.length} commit(s) GitLab no longer serves`);
    }

    log("Bundle the frozen code and later versions");
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(join(staging, "key", "evidence", "gitlab"), { recursive: true });
    const mainTip = branchTip(options.clone, data.project.default_branch);
    scratch.bundle(
      join(staging, "snapshot.bundle"),
      [{ name: SNAPSHOT_REF, sha: version.head_commit_sha }],
      mainTip,
    );
    const later = ordered.filter(
      (other) => other.ordinal > version.ordinal && scratch.has(other.head_commit_sha),
    );
    if (later.length > 0) {
      scratch.bundle(
        join(staging, "key", "fixes.bundle"),
        later.map((other) => ({
          name: `refs/versions/${other.ordinal}`,
          sha: other.head_commit_sha,
        })),
        mainTip,
      );
    }
    log("Write the fixture");
    const fixture: Fixture = {
      format: FIXTURE_FORMAT,
      id,
      source: {
        forge: "gitlab",
        project,
        number,
        url: mr.web_url,
        state: mr.state === "opened" ? "open" : mr.state === "merged" ? "merged" : "closed",
      },
      snapshot: {
        version: version.ordinal,
        base: version.base_commit_sha,
        head: version.head_commit_sha,
        at: version.created_at,
        start: version.start_commit_sha,
      },
      request: { asOf: request.asOf, removed: request.removed },
    };
    const record: CollectRecord = {
      format: COLLECT_RECORD_FORMAT,
      collectedAt: new Date().toISOString(),
      reviewStart: {
        version: version.ordinal,
        how: start.how,
        ...(start.first ? { firstComment: withoutBody(start.first) } : {}),
      },
      unavailable,
      notes,
    };
    await writeJson(join(staging, "fixture.json"), fixture);
    await writeJson(join(staging, "key", "evidence", "collect.json"), record);
    await Bun.write(join(staging, "request.md"), `# ${request.title}\n\n${request.description}\n`);
    const raw = join(staging, "key", "evidence", "gitlab");
    await writeJson(join(raw, "project.json"), data.project);
    await writeJson(join(raw, "merge-request.json"), mr);
    await writeJson(join(raw, "versions.json"), data.versions);
    await writeJson(join(raw, "discussions.json"), data.discussions);
    await writeJson(join(raw, "description-versions.json"), data.descriptions);
    // Proves the bundle restores from a main-branch clone, the way a review run will restore it.
    const problems = await verifyFixture(staging, { project, number, clone: options.clone });
    if (problems.length > 0) throw new Error(describeProblems(staging, problems));
    renameSync(staging, dir);
    return { status: "collected", id, dir, version: version.ordinal, notes };
  } finally {
    rmSync(staging, { recursive: true, force: true });
    scratch.dispose();
  }
}

type Choice =
  | {
      kind: "chosen";
      version: OrderedVersion;
      how: CollectRecord["reviewStart"]["how"];
      first?: CodeComment;
      /** When the reviewer read the title and description. */
      readAt: string;
      notes: string[];
    }
  | { kind: "excluded"; reason: "no-review"; detail: string };

function chooseVersion(
  chosen: number | undefined,
  ordered: OrderedVersion[],
  data: MergeRequestData,
): Choice {
  if (chosen !== undefined) {
    const version = ordered[chosen - 1];
    if (!version) throw new Error(`the MR has ${ordered.length} versions, not ${chosen}`);
    return {
      kind: "chosen",
      version,
      how: "chosen",
      readAt: version.created_at,
      notes: [`version ${chosen} was chosen by hand`],
    };
  }
  const found = findReviewStart(ordered, codeComments(data.discussions, data.mr.author.username));
  if (found.kind === "no-review") {
    return { kind: "excluded", reason: "no-review", detail: found.detail };
  }
  return {
    kind: "chosen",
    version: found.version,
    how: "first-comment",
    first: found.first,
    readAt: found.first.at,
    notes: [],
  };
}

function requestAt(time: string, data: MergeRequestData) {
  const { mr } = data;
  const notes: string[] = [];
  const systemNotes = data.discussions.flatMap((discussion) =>
    discussion.notes.filter((note) => note.system),
  );
  const title = titleAt(time, mr.title, systemNotes);
  const described = descriptionAt(
    time,
    { text: mr.description ?? "", updatedAt: mr.updated_at },
    data.descriptions,
  );
  if (described.asOf !== time) {
    notes.push("the description's history couldn't be read; it is the latest text");
  }
  const { text: description, removed } = stripMarkedBlocks(described.text);
  return { title, description, asOf: described.asOf, removed, notes };
}

function withoutBody({ body: _, ...comment }: CodeComment) {
  return comment;
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await Bun.write(file, `${JSON.stringify(value, null, 2)}\n`);
}
