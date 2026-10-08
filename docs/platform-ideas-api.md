# The platform ideas API

Story MOTIR-7662 · MOTIR-7675. The staff HTTP surface over the idea store: the
door the `motir-ideas` skill reads and writes through. It is a **platform**
surface, not part of the tenant API (`/api/v1`), so it is not in the OpenAPI
contract; this document is its contract.

## Who may call it

Every route is gated by `requirePlatformStaffForIdeas`
(`lib/platform/ideasGate.ts`), the one exception recorded in
`docs/decisions/platform-staff-auth.md` §2 (the 2026-10-07 amendment). A request
is admitted with either:

- **a personal access token** in `Authorization: Bearer motir_pat_…`, whose
  OWNER's current platform role is at or above the route's level. No token
  permission is consulted. A run token, a revoked, expired or unknown token, and
  a token of a suspended organization are all refused; or
- **the staff member's console session** (no `Authorization` header).

Every refusal, including "this route needs a higher level", is the same
**`404 { "code": "NOT_FOUND" }`**: the surface does not tell an outsider it
exists. Every write records the credential in its platform audit row
(`metadata.credential`: `{ "kind": "token", "apiTokenId": "…" }` or
`{ "kind": "session" }`).

Every response carries `Cache-Control: no-store`.

## Routes

| Method & path                            | Level          | Body / query                                                                               | Success                                                  |
| ---------------------------------------- | -------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------- |
| `GET /api/platform/ideas`                | operator       | `?status=active\|retired&kind=&category=&tag=&q=&cursor=&limit=` (limit 1–200, default 50) | `200 { items: StaffIdea[], nextCursor: string \| null }` |
| `POST /api/platform/ideas`               | operator       | `{ ideas: IdeaInput[] (1–20), reason? }`                                                   | `201 { slugs: string[] }`                                |
| `GET /api/platform/ideas/{slug}`         | operator       | —                                                                                          | `200 StaffIdea` (any status)                             |
| `PATCH /api/platform/ideas/{slug}`       | operator       | `IdeaPatch`                                                                                | `200 StaffIdea`                                          |
| `DELETE /api/platform/ideas/{slug}`      | **superadmin** | `{ reason }`                                                                               | `200 { deleted: slug }`                                  |
| `POST /api/platform/ideas/{slug}/retire` | operator       | `{ reason }`                                                                               | `200 StaffIdea`                                          |
| `GET /api/platform/ideas/tags`           | operator       | —                                                                                          | `200 StaffIdeaTag[]`                                     |
| `POST /api/platform/ideas/tags`          | operator       | `{ slug, label, description }`                                                             | `201 StaffIdeaTag`                                       |
| `GET /api/platform/ideas/runs`           | operator       | `?limit=` (1–100, default 10)                                                              | `200 IdeaResearchRun[]`                                  |
| `POST /api/platform/ideas/runs`          | operator       | `{ areasCovered, addedCount, retiredCount, reportMd }`                                     | `201 IdeaResearchRun`                                    |

A batch add is **all or none**: one invalid idea, one unknown tag or one taken
slug writes nothing.

## Bodies

`IdeaInput` (the schemas are `lib/ideas/schemas.ts`; the limits
`lib/ideas/limits.ts`):

| Field                 | Rule                                                                                                                                   |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `slug`                | `^[a-z0-9]+(-[a-z0-9]+)*$`, at most 80 characters, unique in the store                                                                 |
| `title`               | 1–120 characters                                                                                                                       |
| `pitch`               | 1–400 characters                                                                                                                       |
| `kind`                | `motir_buys` or `direction`                                                                                                            |
| `category`            | one of the fixed `IdeaCategory` values (`lib/ideas/categories.ts`)                                                                     |
| `tags`                | at most 6 EXISTING vocabulary slugs (add a tag first with `POST …/tags`)                                                               |
| `capabilities`        | at most 8 strings of at most 300 characters, in order                                                                                  |
| `evidence`            | at most 10 of `{ claim (≤ 400), sourceName (≤ 200), url (https, ≤ 2000), sourceDate? (YYYY-MM-DD) }`; a `direction` needs at least one |
| `gap`, `whyNow`       | at most 600 characters, or null                                                                                                        |
| `whyMotir`, `whoElse` | at most 600 characters; `motir_buys` only                                                                                              |

`IdeaPatch` is every `IdeaInput` field except `slug`, all optional, plus
`reviewed: true` (stamps `lastReviewedAt`) and `reason` (the audit row's reason;
defaults to one naming the credential). `evidence` and `tags` **replace** their
lists wholesale when given.

`reason` on retire and delete is required: non-blank, at most 2000 characters.
A tag's `description` is required: a new tag needs a stated purpose.

## Errors

| Status | `code`               | When                                                                                            | Extra fields                         |
| ------ | -------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------ |
| 404    | `NOT_FOUND`          | not admitted (see above)                                                                        | —                                    |
| 400    | `INVALID_REQUEST`    | the body is not JSON, or fails its schema; a bad query param                                    | `issues: { path, message }[]`        |
| 400    | `INVALID_IDEA_INPUT` | a rule the service owns (kind-specific fields, a direction with no evidence, an unknown cursor) | `issues: { slug, field, message }[]` |
| 400    | `UNKNOWN_TAG`        | a tag slug not in the vocabulary                                                                | `tags: string[]`                     |
| 404    | `IDEA_NOT_FOUND`     | no idea with that slug                                                                          | —                                    |
| 409    | `IDEA_SLUG_TAKEN`    | a slug already in the store, or repeated in the batch                                           | `slugs: string[]`                    |
| 409    | `IDEA_NOT_ACTIVE`    | retiring an idea already retired                                                                | —                                    |
| 409    | `IDEA_TAG_TAKEN`     | a tag slug already in the vocabulary                                                            | `slug`                               |

Anything else is a 500.

## Examples

```sh
# List active directions in e-commerce
curl -sS "$MOTIR_URL/api/platform/ideas?status=active&kind=direction&category=ecommerce" \
  -H "Authorization: Bearer $MOTIR_TOKEN"

# Add a batch
curl -sS -X POST "$MOTIR_URL/api/platform/ideas" \
  -H "Authorization: Bearer $MOTIR_TOKEN" -H 'Content-Type: application/json' \
  -d '{"reason":"motir-ideas run 2026-10-07","ideas":[{"slug":"a-new-direction","title":"A new direction","pitch":"…","kind":"direction","category":"pets","tags":["smb"],"evidence":[{"claim":"…","sourceName":"…, October 2026","url":"https://example.com","sourceDate":"2026-10-01"}],"gap":"…"}]}'

# Read one idea, any status
curl -sS "$MOTIR_URL/api/platform/ideas/a-new-direction" \
  -H "Authorization: Bearer $MOTIR_TOKEN"

# Edit, and mark it reviewed
curl -sS -X PATCH "$MOTIR_URL/api/platform/ideas/a-new-direction" \
  -H "Authorization: Bearer $MOTIR_TOKEN" -H 'Content-Type: application/json' \
  -d '{"pitch":"A sharper pitch.","reviewed":true}'

# Retire, with a reason
curl -sS -X POST "$MOTIR_URL/api/platform/ideas/a-new-direction/retire" \
  -H "Authorization: Bearer $MOTIR_TOKEN" -H 'Content-Type: application/json' \
  -d '{"reason":"A funded company now serves small clinics."}'

# Delete (superadmin only)
curl -sS -X DELETE "$MOTIR_URL/api/platform/ideas/a-new-direction" \
  -H "Authorization: Bearer $MOTIR_TOKEN" -H 'Content-Type: application/json' \
  -d '{"reason":"Added by mistake."}'

# The tag vocabulary, and adding a tag
curl -sS "$MOTIR_URL/api/platform/ideas/tags" -H "Authorization: Bearer $MOTIR_TOKEN"
curl -sS -X POST "$MOTIR_URL/api/platform/ideas/tags" \
  -H "Authorization: Bearer $MOTIR_TOKEN" -H 'Content-Type: application/json' \
  -d '{"slug":"marketplaces","label":"Marketplaces","description":"Two-sided platforms matching buyers and sellers."}'

# The research-run log, and recording a run
curl -sS "$MOTIR_URL/api/platform/ideas/runs?limit=5" -H "Authorization: Bearer $MOTIR_TOKEN"
curl -sS -X POST "$MOTIR_URL/api/platform/ideas/runs" \
  -H "Authorization: Bearer $MOTIR_TOKEN" -H 'Content-Type: application/json' \
  -d '{"areasCovered":["pets","logistics"],"addedCount":2,"retiredCount":1,"reportMd":"# Run 2026-10-07\n…"}'
```

The public, anonymous read of the same store is `/api/public/ideas`
(active ideas only, no staff field).
