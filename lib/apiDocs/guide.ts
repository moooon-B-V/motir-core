// The getting-started guide and the published stability policy, AS DATA
// (Story 11.4 · Subtask 11.4.8 — MOTIR-2189).
//
// ── Why data and not prose in a `.tsx` ──────────────────────────────────────
// The card's sharpest criterion: *"Every endpoint, parameter, status and header
// the guide names is asserted against the shipped API by a test — so the guide
// cannot document a route, a query parameter or a header that does not exist."*
// A paragraph cannot be checked against a registry; a declared `endpoint` and a
// declared `parameters` list can. So each step carries the FACTS it claims
// alongside the words, `tests/api-docs/guide-truth.test.ts` walks them against
// the shipped operation registry, `DOMAIN_ERROR_STATUS` and the rate-limit
// headers, and a guide that drifts from the API fails the build.
//
// That is the same argument the whole story rests on, applied one level up: a
// hand-written description of an API is a second artifact, and the only version
// worth shipping is one a check can refuse.
//
// ── English, per ADR Amendment 4 Q4 ─────────────────────────────────────────
// The amendment's line is: *"if a client could parse it, it is English; if only
// a human reads it, it is localized."* Long-form documentation prose is the
// second case — but it lives HERE rather than in `messages/*.json` because it is
// a document, not chrome: a catalog entry per paragraph would make the guide
// unreadable to edit and would put `curl` samples inside a localization file.
// The page CHROME (nav labels, headings around the content) is localized in the
// catalogs as the rest of the surface is. Localizing this document is a
// deliberate later decision, and the note says so rather than leaving a reader
// to conclude it was forgotten.

import { EXAMPLE_TOKEN } from '@/lib/apiDocs/reference';

/** One block inside a step — the rhythm the design draws (Panel 4). */
export type GuideBlock =
  | { kind: 'prose'; text: string }
  | { kind: 'code'; caption: string; code: string; copyable?: boolean }
  | { kind: 'callout'; tone: 'info' | 'warning'; text: string };

/** One numbered step of the guide. */
export interface GuideStep {
  id: string;
  title: string;
  /**
   * The `METHOD /path` this step's example actually calls, when it calls one.
   *
   * The guide's claim on the API, in the form the truth test can check against
   * the registry. A step that names no endpoint (minting a token) has none.
   */
  endpoint?: { method: string; path: string };
  /** Query parameters the step tells the reader to send. Checked per endpoint. */
  parameters?: string[];
  /** HTTP statuses the step shows. Checked against the status vocabulary. */
  statuses?: number[];
  /** Response headers the step shows. Checked against what the wrapper sets. */
  headers?: string[];
  blocks: GuideBlock[];
}

const ORIGIN = 'https://app.motir.co';

/** The five steps, in order. Each ends in something the reader can see happen. */
export const GUIDE_STEPS: readonly GuideStep[] = [
  {
    id: 'mint-a-token',
    title: 'Mint a token',
    blocks: [
      {
        kind: 'prose',
        text: 'Every call is authenticated with a personal access token. Mint one in Settings → Account → API tokens, choose the workspace it is bound to, and grant it the scopes it needs.',
      },
      {
        kind: 'prose',
        text: 'A token carries a set of scopes: `read` for every read in this guide, `work_items:write` to create or change work items, `work_items:archive` to archive and restore, and `sprints:write` for sprint lifecycle and membership. Grant the narrowest set that does the job — a scope narrows your own role and never widens it, so a token cannot do something you could not.',
      },
      {
        kind: 'callout',
        tone: 'warning',
        text: 'The secret is shown ONCE, when the token is created. Copy it then; there is no way to read it again, and a lost token is replaced rather than recovered.',
      },
    ],
  },
  {
    id: 'first-call',
    title: 'Your first authenticated call',
    endpoint: { method: 'GET', path: '/api/v1/me' },
    statuses: [200, 401],
    blocks: [
      {
        kind: 'prose',
        text: 'Make this call first. It answers who the token is, which workspace it is bound to, and exactly which scopes it carries — so you learn what your own credential may do without probing endpoints and collecting 403s.',
      },
      {
        kind: 'code',
        caption: 'curl',
        copyable: true,
        code: `curl ${ORIGIN}/api/v1/me \\\n  -H "Authorization: Bearer ${EXAMPLE_TOKEN}"`,
      },
      {
        kind: 'code',
        caption: '200 · application/json',
        code: `{
  "user": { "id": "usr_…", "name": "Ada", "email": "ada@example.com" },
  "workspaceId": "wsp_…",
  "scopes": ["read"]
}`,
      },
      {
        kind: 'prose',
        text: 'A missing, malformed, unknown, revoked or expired token all return the same 401 with the same message. That is deliberate: distinguishing them would turn the endpoint into an oracle that answers “does this secret exist?”.',
      },
    ],
  },
  {
    id: 'paginate',
    title: 'Paginate a collection',
    endpoint: { method: 'GET', path: '/api/v1/projects/{projectKey}/work-items' },
    parameters: ['limit', 'cursor'],
    statuses: [200, 422],
    blocks: [
      {
        kind: 'prose',
        text: 'Collections are cursor-paged. Ask for a page size with `limit` (the default is 50 and anything larger is clamped to 100, not rejected), then send the previous response’s `nextCursor` back as `cursor`. A `nextCursor` of `null` is the last page.',
      },
      {
        kind: 'code',
        caption: 'curl · the first page',
        copyable: true,
        code: `curl "${ORIGIN}/api/v1/projects/MOTIR/work-items?limit=2" \\\n  -H "Authorization: Bearer ${EXAMPLE_TOKEN}"`,
      },
      {
        kind: 'code',
        caption: '200 · application/json',
        code: `{
  "items": [ { "key": "MOTIR-1", … }, { "key": "MOTIR-2", … } ],
  "nextCursor": "eyJjIjoid29ya0l0ZW1zIiwicCI6…"
}`,
      },
      {
        kind: 'code',
        caption: 'curl · the next page',
        copyable: true,
        code: `curl "${ORIGIN}/api/v1/projects/MOTIR/work-items?limit=2&cursor=$CURSOR" \\\n  -H "Authorization: Bearer ${EXAMPLE_TOKEN}"`,
      },
      {
        kind: 'callout',
        tone: 'info',
        text: 'The cursor is OPAQUE and signed. Do not parse it, construct one, or carry it between collections — a cursor issued elsewhere is a 422, never a silently wrong page. Send back exactly what you were given.',
      },
      {
        kind: 'prose',
        text: 'One asymmetry surprises people, so it is worth knowing before you meet it: **some collections also report a `totalCount` and most deliberately do not.** The backlog, a sprint’s members and a work item’s comments carry one, because the read behind them already computes it as a bounded aggregate. Projects, sprints, workspaces and the ready set omit the field ENTIRELY — absent, never `null` and never `0`, so a client can always tell “no total was promised” from “the total is zero”.',
      },
    ],
  },
  {
    id: 'read-an-error',
    title: 'Read an error',
    endpoint: { method: 'GET', path: '/api/v1/work-items/{key}' },
    statuses: [404, 403, 422, 500],
    blocks: [
      {
        kind: 'prose',
        text: 'Every failure returns the same body: a machine `code` and a human `error`. Branch on `code` — it is stable, and changing one is a breaking change. Never parse `error`; it is a sentence for a developer reading a terminal and is reworded freely.',
      },
      {
        kind: 'code',
        caption: '404 · application/json',
        code: `{ "code": "WORK_ITEM_NOT_FOUND", "error": "Work item not found." }`,
      },
      {
        kind: 'prose',
        text: 'A 404 means the resource does not exist **or** is outside the workspace your token is bound to — the same answer on purpose, so the API cannot be used to enumerate another tenant’s data. A 403 means the opposite kind of refusal: your token is valid, and it lacks the scope this operation requires. A 422 is a request you can fix, and its `code` names which part.',
      },
      {
        kind: 'callout',
        tone: 'warning',
        text: 'A 500 is the one failure with NO `code`. An unexpected fault has no stable contract, so the body carries a message and nothing else — do not branch on it.',
      },
    ],
  },
  {
    id: 'rate-limits',
    title: 'Read the rate-limit headers',
    endpoint: { method: 'GET', path: '/api/v1/me' },
    statuses: [429],
    headers: ['X-RateLimit-Limit', 'X-RateLimit-Remaining', 'X-RateLimit-Reset', 'X-Request-Id'],
    blocks: [
      {
        kind: 'prose',
        text: 'The budget is per TOKEN, and the headers ride EVERY response — a success, a 403, a mapped error and a 500 alike. You never have to make a request to find out where you stand; the last one already told you.',
      },
      {
        kind: 'code',
        caption: 'response headers',
        code: `X-RateLimit-Limit:     600
X-RateLimit-Remaining: 594
X-RateLimit-Reset:     1785312000
X-Request-Id:          c7771231-e18c-48bc-90c9-c1a9720436a4`,
      },
      {
        kind: 'callout',
        tone: 'warning',
        text: 'On a 429, back off until `X-RateLimit-Reset` — a Unix timestamp in SECONDS. There is no `Retry-After` header, deliberately: an absolute instant cannot go stale in transit the way a relative duration can.',
      },
      {
        kind: 'prose',
        text: '`X-Request-Id` is on every response too. Quote it if you ever need to ask us about a specific call — it is the one identifier that finds it.',
      },
    ],
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// The published stability + deprecation policy
// ─────────────────────────────────────────────────────────────────────────────
//
// ⚠️ ONE PROMISE IN TWO PLACES. ADR §8 is the INTERNAL record; `/docs/stability`
// is the PUBLISHED commitment. They must never say different things, so each item
// below carries `adrPhrase` — a distinctive substring of the §8 bullet it
// publishes — and `tests/api-docs/guide-truth.test.ts` asserts every phrase is
// present in §8 AND that neither list has grown an item the other lacks. An edit
// to either side that leaves the other behind fails the build.

/** One item of the policy's additive or forbidden list. */
export interface PolicyItem {
  /** The published sentence. */
  text: string;
  /** A distinctive substring of the ADR §8 bullet this publishes. */
  adrPhrase: string;
}

/** Where the internal record lives, for the page's cross-link. */
export const ADR_PATH = 'docs/decisions/public-api-conventions.md';

/** Allowed inside `v1`, without notice. */
export const POLICY_ADDITIVE: readonly PolicyItem[] = [
  { text: 'A new endpoint.', adrPhrase: 'a new endpoint' },
  { text: 'A new OPTIONAL query parameter.', adrPhrase: 'a new optional query parameter' },
  { text: 'A new field on a response object.', adrPhrase: 'a new field on a response object' },
  {
    text: 'A new value on a field documented as open-ended.',
    adrPhrase: 'a new enum value on a field documented as open-ended',
  },
  { text: 'A raised rate-limit budget.', adrPhrase: 'a raised rate-limit budget' },
];

/** Forbidden inside `v1` — these need a new major. */
export const POLICY_FORBIDDEN: readonly PolicyItem[] = [
  { text: 'Removing a field.', adrPhrase: 'removing a field' },
  { text: 'Renaming a field.', adrPhrase: 'renaming a field' },
  {
    text: 'Changing a field’s type or nullability.',
    adrPhrase: "changing a field's type or nullability",
  },
  {
    text: 'Removing or re-purposing an error `code`.',
    adrPhrase: 'removing or re-purposing an error',
  },
  {
    text: 'Changing an existing status for an existing condition.',
    adrPhrase: 'changing an existing status for an existing condition',
  },
  { text: 'Tightening a limit.', adrPhrase: 'tightening a limit' },
  {
    text: 'Making an optional parameter required.',
    adrPhrase: 'making an optional parameter required',
  },
];

/** The prose sections of the policy page, in reading order. */
export interface PolicySection {
  id: string;
  title: string;
  blocks: GuideBlock[];
}

export const POLICY_SECTIONS: readonly PolicySection[] = [
  {
    id: 'the-guarantee',
    title: 'What `v1` guarantees',
    blocks: [
      {
        kind: 'prose',
        text: 'While `v1` lives, its paths do not move, an error `code` does not change meaning, an existing condition does not change status, and a field does not change type or nullability. Anything that would break those is a `v2`, not a `v1` release.',
      },
    ],
  },
  {
    id: 'your-obligation',
    title: 'Your side of the promise',
    blocks: [
      {
        kind: 'callout',
        tone: 'warning',
        text: 'A client MUST tolerate unknown fields and unknown enum values, and MUST NOT parse the human `error` sentence. This is the other half of the promise: a client that rejects a field it does not recognise will break on a change this page calls safe, and a client that parses `error` will break on a reworded sentence.',
      },
    ],
  },
  {
    id: 'deprecation',
    title: 'Deprecation',
    blocks: [
      {
        kind: 'prose',
        text: 'A deprecated operation or field is marked `deprecated: true` **in the specification**, and carries the reason and its replacement in its description. The spec is the announcement channel because it is the one artifact every client already reads — so a code generator surfaces the deprecation without anyone having to have seen a blog post.',
      },
      {
        kind: 'prose',
        text: 'The old behaviour keeps working for the announced window. A field is never removed as a surprise.',
      },
    ],
  },
  {
    id: 'how-v2-arrives',
    title: 'How a `v2` would arrive',
    blocks: [
      {
        kind: 'prose',
        text: 'As a SECOND document at a second path, served alongside `v1` — not as a rewrite of it. `v1` does not stop working the day `v2` ships, and deprecating `v1` is itself an announcement under the same window.',
      },
      {
        kind: 'prose',
        text: 'The `info.version` in the specification is the API contract’s version, not the app’s release number: its major is the path version, its minor increments on an additive change from the list above, and its patch on a documentation-only correction.',
      },
    ],
  },
];
