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
| `POST /api/platform/ideas/tags`          | operator       | `{ slug, label, description, labelTranslations? }`                                         | `201 StaffIdeaTag`                                       |
| `PATCH /api/platform/ideas/tags/{slug}`  | operator       | `{ labelTranslations }`                                                                    | `200 StaffIdeaTag`                                       |
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

## Translations

Story MOTIR-7772 · MOTIR-7774. An idea's text, each evidence claim and each tag
label can be written in the ten non-English locales, beside the English the
idea already requires:

`zh` `ja` `ko` `de` `fr` `es` `it` `nl` `pl` `pt`

English is never a key: it lives on the idea itself. Any other key, `en`
included, is refused `400 UNSUPPORTED_LOCALE` and the request writes nothing (in
a batch, no idea).

| Where                                | Field                                                                                                |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `IdeaInput` and `IdeaPatch`          | `translations?: { <locale>: { title?, pitch?, capabilities?, gap?, whyNow?, whyMotir?, whoElse? } }` |
| each `evidence` entry                | `claimTranslations?: { <locale>: string }` (≤ 400)                                                   |
| `POST …/tags`, `PATCH …/tags/{slug}` | `labelTranslations: { <locale>: string }` (≤ 60)                                                     |

Each translated field has its English field's limit. Two more rules, checked
against the English the idea will have after the write:

- a field with no English takes no translation (`TRANSLATION_WITHOUT_ENGLISH`),
  for example a `whyMotir` translation on a `direction`;
- a translated `capabilities` list has exactly the English list's length
  (`TRANSLATION_SHAPE_MISMATCH`).

Source names, URLs and dates, categories, slugs and a tag's description are
never translated.

### The drop rule

**Change a field's English, and re-send its translations in the same request,
or they are dropped.** When a write changes a field's English (compared with the
idea as stored, not with the request), that field is cleared in every locale,
and survives only in the locales the same request supplies. A field whose
English the request does not change keeps its translations. Replacing
`evidence` drops the old claims' translations with the old rows; give each new
row its `claimTranslations` in the same request. This holds for every door,
including the console's English-only edits.

### `expectedUpdatedAt` and `IDEA_CHANGED`

A `PATCH` that carries `translations` must also carry `expectedUpdatedAt`: the
`updatedAt` of the idea you translated (from `GET …/{slug}`). If the idea's
English changed since, its `updatedAt` moved, and the write is refused
`409 IDEA_CHANGED` with the current `updatedAt`, writing nothing. **Re-read the
idea, re-translate what changed, and retry** with the new `updatedAt`. A
translation-only write does not move `updatedAt`, so writes for different
locales never refuse each other.

### Reading translations

`StaffIdea` carries every locale: `translations` (`{ <locale>: { …fields } }`,
a field missing in a locale is absent), `claimTranslations` on each evidence
row, `labelTranslations` on each tag, and **`missingLocales`**: the locales
where any field with English (the idea's own, an evidence claim, an assigned
tag's label) has no text. A `capabilities` list counts only at the English
length. Fill exactly what `missingLocales` names. `StaffIdeaTag` carries
`labelTranslations` when the tag has at least one.

`reason` on retire and delete is required: non-blank, at most 2000 characters.
A tag's `description` is required: a new tag needs a stated purpose.

## Errors

| Status | `code`                        | When                                                                                            | Extra fields                           |
| ------ | ----------------------------- | ----------------------------------------------------------------------------------------------- | -------------------------------------- |
| 404    | `NOT_FOUND`                   | not admitted (see above)                                                                        | —                                      |
| 400    | `INVALID_REQUEST`             | the body is not JSON, or fails its schema; a bad query param                                    | `issues: { path, message }[]`          |
| 400    | `INVALID_IDEA_INPUT`          | a rule the service owns (kind-specific fields, a direction with no evidence, an unknown cursor) | `issues: { slug, field, message }[]`   |
| 400    | `UNKNOWN_TAG`                 | a tag slug not in the vocabulary                                                                | `tags: string[]`                       |
| 404    | `IDEA_NOT_FOUND`              | no idea with that slug                                                                          | —                                      |
| 409    | `IDEA_SLUG_TAKEN`             | a slug already in the store, or repeated in the batch                                           | `slugs: string[]`                      |
| 409    | `IDEA_NOT_ACTIVE`             | retiring an idea already retired                                                                | —                                      |
| 409    | `IDEA_TAG_TAKEN`              | a tag slug already in the vocabulary                                                            | `slug`                                 |
| 400    | `UNSUPPORTED_LOCALE`          | a translation key outside the ten locales, `en` included                                        | `locales: string[]`                    |
| 400    | `TRANSLATION_SHAPE_MISMATCH`  | a translated `capabilities` list whose length differs from the English list                     | `fields: string[]` (`ja.capabilities`) |
| 400    | `TRANSLATION_WITHOUT_ENGLISH` | a translation of a field whose English is empty after the write                                 | `fields: string[]` (`ja.whyMotir`)     |
| 409    | `IDEA_CHANGED`                | `expectedUpdatedAt` is not the idea's `updatedAt`: re-read, re-translate, retry                 | `updatedAt`                            |
| 404    | `IDEA_TAG_NOT_FOUND`          | `PATCH …/tags/{slug}` names a tag not in the vocabulary                                         | —                                      |

In a batch add, `fields` entries are prefixed with the idea's slug
(`a-new-direction.ja.capabilities`). A `PATCH` with `translations` and no
`expectedUpdatedAt` is a `400 INVALID_REQUEST`.

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

# Add a batch with translations (drop rule: they sit beside the English given here)
curl -sS -X POST "$MOTIR_URL/api/platform/ideas" \
  -H "Authorization: Bearer $MOTIR_TOKEN" -H 'Content-Type: application/json' \
  -d '{"ideas":[{"slug":"pet-clinic-kit","title":"Pet clinic kit","pitch":"…","kind":"direction","category":"pets","capabilities":["Books visits"],"evidence":[{"claim":"…","sourceName":"…","url":"https://example.com","claimTranslations":{"ja":"…"}}],"gap":"…","translations":{"ja":{"title":"ペットクリニックキット","pitch":"…","capabilities":["予約を受け付ける"],"gap":"…"}}}]}'

# Fill the missing locales of one idea (expectedUpdatedAt from the GET above)
curl -sS -X PATCH "$MOTIR_URL/api/platform/ideas/pet-clinic-kit" \
  -H "Authorization: Bearer $MOTIR_TOKEN" -H 'Content-Type: application/json' \
  -d '{"expectedUpdatedAt":"2026-10-09T12:00:00.000Z","translations":{"ko":{"title":"반려동물 병원 키트"}}}'

# Change English and re-send its translations in the same request
curl -sS -X PATCH "$MOTIR_URL/api/platform/ideas/pet-clinic-kit" \
  -H "Authorization: Bearer $MOTIR_TOKEN" -H 'Content-Type: application/json' \
  -d '{"pitch":"A sharper pitch.","expectedUpdatedAt":"2026-10-09T12:00:00.000Z","translations":{"ja":{"pitch":"…"},"ko":{"pitch":"…"}}}'
# → 409 {"code":"IDEA_CHANGED","updatedAt":"…"} if the English moved: re-read, re-translate, retry

# A locale outside the ten
curl -sS -X PATCH "$MOTIR_URL/api/platform/ideas/pet-clinic-kit" \
  -H "Authorization: Bearer $MOTIR_TOKEN" -H 'Content-Type: application/json' \
  -d '{"expectedUpdatedAt":"2026-10-09T12:00:00.000Z","translations":{"en":{"title":"…"}}}'
# → 400 {"code":"UNSUPPORTED_LOCALE","locales":["en"]}

# A list of the wrong length, and a field with no English
curl -sS -X PATCH "$MOTIR_URL/api/platform/ideas/pet-clinic-kit" \
  -H "Authorization: Bearer $MOTIR_TOKEN" -H 'Content-Type: application/json' \
  -d '{"expectedUpdatedAt":"2026-10-09T12:00:00.000Z","translations":{"ja":{"capabilities":["一","二"]}}}'
# → 400 {"code":"TRANSLATION_SHAPE_MISMATCH","fields":["ja.capabilities"]}
curl -sS -X PATCH "$MOTIR_URL/api/platform/ideas/pet-clinic-kit" \
  -H "Authorization: Bearer $MOTIR_TOKEN" -H 'Content-Type: application/json' \
  -d '{"expectedUpdatedAt":"2026-10-09T12:00:00.000Z","translations":{"ja":{"whyMotir":"…"}}}'
# → 400 {"code":"TRANSLATION_WITHOUT_ENGLISH","fields":["ja.whyMotir"]}

# Add label translations to an existing tag
curl -sS -X PATCH "$MOTIR_URL/api/platform/ideas/tags/marketplaces" \
  -H "Authorization: Bearer $MOTIR_TOKEN" -H 'Content-Type: application/json' \
  -d '{"labelTranslations":{"ja":"マーケットプレイス","de":"Marktplätze"}}'
# → 404 {"code":"IDEA_TAG_NOT_FOUND"} for a tag not in the vocabulary

# The research-run log, and recording a run
curl -sS "$MOTIR_URL/api/platform/ideas/runs?limit=5" -H "Authorization: Bearer $MOTIR_TOKEN"
curl -sS -X POST "$MOTIR_URL/api/platform/ideas/runs" \
  -H "Authorization: Bearer $MOTIR_TOKEN" -H 'Content-Type: application/json' \
  -d '{"areasCovered":["pets","logistics"],"addedCount":2,"retiredCount":1,"reportMd":"# Run 2026-10-07\n…"}'
```

The public, anonymous read of the same store is `/api/public/ideas`
(active ideas only, no staff field).
