import Type from "typebox";

/**
 * The review fixture format from story 005. Each schema is the single definition: the TypeScript
 * type is derived from it, files are validated against it, and `schema/*.schema.json` is generated
 * from it.
 */

const Sha = Type.String({ pattern: "^[0-9a-f]{40}$" });
const Timestamp = Type.String({ minLength: 1, description: "ISO 8601" });
const Ordinal = Type.Integer({ minimum: 1 });
const Text = Type.String({ minLength: 1 });

export const FIXTURE_FORMAT = "awf.review-fixture/1";
export const KEY_FORMAT = "awf.review-key/1";
export const SET_FORMAT = "awf.fixture-set/1";

export const FixtureSchema = Type.Object(
  {
    format: Type.Literal(FIXTURE_FORMAT),
    id: Type.String({ pattern: "^[a-z0-9][a-z0-9._-]*$" }),
    source: Type.Object(
      {
        forge: Type.Enum(["gitlab", "github"]),
        project: Text,
        number: Type.Integer({ minimum: 1 }),
        url: Text,
        state: Type.Enum(["merged", "open", "closed"]),
      },
      { additionalProperties: false },
    ),
    snapshot: Type.Object(
      {
        version: Ordinal,
        base: Sha,
        head: Sha,
        at: Timestamp,
        start: Type.Optional(Sha),
      },
      { additionalProperties: false },
    ),
    request: Type.Object(
      {
        asOf: Timestamp,
        removed: Type.Array(Type.Object({ by: Text, what: Text }, { additionalProperties: false })),
      },
      { additionalProperties: false },
    ),
  },
  {
    additionalProperties: false,
    description:
      "Where an MR came from and the version review started on. The title and description are in request.md.",
  },
);

const Location = Type.Object(
  { path: Text, start: Type.Integer({ minimum: 1 }), end: Type.Integer({ minimum: 1 }) },
  { additionalProperties: false, description: "Lines in the frozen code, both ends included." },
);

const CommentRef = Type.Object(
  { discussion: Text, note: Type.Integer() },
  { additionalProperties: false, description: "A note in key/evidence/gitlab/discussions.json." },
);

const RunRef = Type.Object(
  { run: Text, finding: Type.Integer({ minimum: 0 }) },
  { additionalProperties: false, description: "A finding from an awf review run, by position." },
);

const CommitRef = Type.Object(
  { commit: Sha },
  {
    additionalProperties: false,
    description: "A later push's commit that fixed a problem nobody commented on.",
  },
);

/** Where a problem came to light: a review comment, a later fix, or a run that found it. */
const SourceSchema = Type.Union([CommentRef, CommitRef, RunRef]);
const Sources = Type.Array(SourceSchema, { minItems: 1 });

const Confirmation = Type.Union([
  Type.Object(
    { basis: Type.Literal("fixed"), version: Ordinal, commit: Sha },
    { additionalProperties: false, description: "A later version changed the code to fix it." },
  ),
  Type.Object(
    { basis: Type.Literal("accepted"), note: CommentRef },
    { additionalProperties: false, description: "The author agreed it was a problem." },
  ),
  Type.Object(
    { basis: Type.Literal("verified"), how: Text },
    { additionalProperties: false, description: "Traced in the frozen code; `how` says how." },
  ),
]);

export const SEVERITIES = ["must-fix", "should-fix", "could-fix", "nit"] as const;
export const CATEGORIES = [
  "correctness",
  "security",
  "performance",
  "tests",
  "design",
  "maintainability",
  "docs-style",
  "slop",
] as const;

const KnownIssueSchema = Type.Object(
  {
    id: Type.String({ pattern: "^K[0-9]+$" }),
    mechanism: Type.String({
      minLength: 1,
      description: "What goes wrong, when, and what it causes; never the fix.",
    }),
    visibleIn: Type.Enum(["diff", "file", "repo"]),
    severity: Type.Enum([...SEVERITIES]),
    category: Type.Enum([...CATEGORIES]),
    scope: Type.Enum(["change", "context"]),
    locations: Type.Array(Location),
    confirmation: Confirmation,
    sources: Sources,
  },
  { additionalProperties: false },
);

const RefutedClaimSchema = Type.Object(
  {
    id: Type.String({ pattern: "^R[0-9]+$" }),
    claim: Text,
    reason: Type.Enum(["false-premise", "not-a-defect"]),
    why: Text,
    sources: Sources,
  },
  { additionalProperties: false },
);

const ExclusionSchema = Type.Object(
  {
    sources: Sources,
    reason: Type.Enum(["not-in-snapshot", "unconfirmed", "preference", "not-a-claim"]),
    claim: Type.String({
      minLength: 1,
      description:
        "What the comment asserted, in a sentence, so a finding repeating it is recognised.",
    }),
    detail: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

/** What the drafter writes. The rest of the key is filled in by code. */
export const KeyBodySchema = Type.Object(
  {
    issues: Type.Array(KnownIssueSchema),
    refuted: Type.Array(RefutedClaimSchema),
    excluded: Type.Array(ExclusionSchema),
  },
  { additionalProperties: false },
);

export const AnswerKeySchema = Type.Object(
  {
    format: Type.Literal(KEY_FORMAT),
    fixture: Text,
    revision: Ordinal,
    draftedBy: Text,
    procedure: Type.String({
      minLength: 1,
      description:
        "A hash of the drafting and voting instructions; a key with an old one is stale.",
    }),
    ...KeyBodySchema.properties,
  },
  { additionalProperties: false, description: "The answer key: never shown to a reviewer." },
);

export const FixtureSetSchema = Type.Object(
  {
    format: Type.Literal(SET_FORMAT),
    name: Text,
    builtAt: Timestamp,
    builder: Text,
    fixtures: Type.Array(
      Type.Object(
        {
          id: Text,
          at: Type.String({
            minLength: 1,
            description: "ISO 8601: when review started, the fixture's request.asOf.",
          }),
          digest: Type.String({
            pattern: "^sha256:[0-9a-f]{64}$",
            description:
              "SHA-256 of fixture.json and request.md as canonical JSON: the MR, its frozen head and the request, not the key. Stored with every score.",
          }),
        },
        { additionalProperties: false },
      ),
    ),
    excluded: Type.Array(
      Type.Object(
        { project: Text, number: Type.Integer({ minimum: 1 }), reason: Text },
        { additionalProperties: false },
      ),
      { description: "MRs considered and left out, and why, so a set says what it isn't." },
    ),
  },
  {
    additionalProperties: false,
    description: "The fixtures in a set, each pinned by a digest, and the MRs left out and why.",
  },
);

export const COLLECT_RECORD_FORMAT = "awf.collect-record/1";

/** What collect decided and why: `key/evidence/collect.json`, read by people checking a fixture. */
export const CollectRecordSchema = Type.Object(
  {
    format: Type.Literal(COLLECT_RECORD_FORMAT),
    collectedAt: Timestamp,
    reviewStart: Type.Object(
      {
        version: Ordinal,
        how: Type.Enum(["first-comment", "chosen"]),
        firstComment: Type.Optional(
          Type.Object(
            {
              discussion: Text,
              note: Type.Integer(),
              at: Timestamp,
              author: Text,
              path: Type.Union([Text, Type.Null()]),
              line: Type.Union([Type.Integer(), Type.Null()]),
            },
            { additionalProperties: false },
          ),
        ),
      },
      { additionalProperties: false },
    ),
    /** Commits GitLab no longer serves. */
    unavailable: Type.Array(Sha),
    notes: Type.Array(Type.String()),
  },
  {
    additionalProperties: false,
    description: "How collect froze a fixture. The raw GitLab data beside it is kept unvalidated.",
  },
);

export const VOTES_FORMAT = "awf.key-votes/1";

/**
 * Every vote behind a key: `key/evidence/votes.json`. Independent graders vote on whether each
 * drafted issue is real and how severe it is, and whether each refuted claim is wrong. Their
 * agreement is the only check on those judgements, so it is kept.
 */
export const VotesSchema = Type.Object(
  {
    format: Type.Literal(VOTES_FORMAT),
    procedure: Text,
    /** The graders; every item has one vote from each, in this order. */
    voters: Type.Array(Text, { minItems: 1 }),
    issues: Type.Array(
      Type.Object(
        {
          id: Type.String({ pattern: "^K[0-9]+$" }),
          real: Type.Boolean(),
          severity: Type.Enum([...SEVERITIES]),
          votes: Type.Array(
            Type.Object(
              {
                by: Text,
                real: Type.Boolean(),
                severity: Type.Enum([...SEVERITIES]),
                why: Type.String(),
              },
              { additionalProperties: false },
            ),
            { minItems: 1 },
          ),
        },
        { additionalProperties: false },
      ),
    ),
    refuted: Type.Array(
      Type.Object(
        {
          id: Type.String({ pattern: "^R[0-9]+$" }),
          wrong: Type.Boolean(),
          votes: Type.Array(
            Type.Object(
              { by: Text, wrong: Type.Boolean(), why: Type.String() },
              { additionalProperties: false },
            ),
            { minItems: 1 },
          ),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

export type Votes = Type.Static<typeof VotesSchema>;
export type CollectRecord = Type.Static<typeof CollectRecordSchema>;
export type Fixture = Type.Static<typeof FixtureSchema>;
export type AnswerKey = Type.Static<typeof AnswerKeySchema>;
export type KnownIssue = Type.Static<typeof KnownIssueSchema>;
export type KeyBody = Type.Static<typeof KeyBodySchema>;
export type Source = Type.Static<typeof SourceSchema>;
export type FixtureSet = Type.Static<typeof FixtureSetSchema>;
