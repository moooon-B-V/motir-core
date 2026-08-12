# Plan-tree embeddings live in `motir-core`; `motir-ai` asks

**Status:** accepted · **Story MOTIR-2694 · Subtask MOTIR-2695** · **Decided 2026-08-11**

## Context

GATE 1 of the planning rules tells the planner to find the existing work before it
proposes new work. The only search it has is a **substring `contains` predicate** —
the 6.1.1 FilterAST, reached over the read-back boundary at
`POST /api/internal/ai/search-work-items`. So a query for _"persist UI preferences"_
cannot see a card titled _"Board columns remember their collapsed state"_, and the
gate reports **"nothing matches"** — honestly, by its own evidence, and wrongly. The
remedy branch that exists for exactly this (_reconcile, never emit a parallel
branch_) never fires, because branch (c) was reached legitimately.

The corpus that needs semantic reach is the **work-item tree**, and it lives in
**`motir-core`'s** database. The one corpus in this product that already has semantic
retrieval — `Lesson` — lives in **`motir-ai`'s**. The pattern therefore cannot simply
be repeated in place: the searcher and the searched are in two different databases,
on two sides of the open-core boundary.

### What already exists (verified on `origin/main`, 2026-08-11)

- **pgvector is in production in this product, on Neon.** `motir-ai`'s
  `prisma/schema.prisma` enables `extensions = [vector]`; migration
  `20260624000000_enable_pgvector` runs `CREATE EXTENSION IF NOT EXISTS "vector"`;
  `motir-ai`'s `DATABASE_URL` is a Neon connection string (`README.md`). The
  extension, the managed platform, and the combination are all already carrying live
  traffic.
- **A working reference implementation.** `motir-ai`'s
  `src/repositories/lessonRepository.ts` writes an `Unsupported("vector(1536)")`
  column through `$executeRaw` with the vector **bound as a parameter and cast**
  (never string-concatenated), and ranks with `("embedding" <=> $query::vector)` over
  an HNSW index, excluding rows whose embedding is null.
- **A pinned embedding model.** `motir-ai`'s
  [`docs/decisions/embedding-provider.md`](https://github.com/moooon-B-V/motir-ai)
  fixes **`text-embedding-3-small` at N = 1536** for _"every later semantic store"_,
  overridable by `EMBEDDING_MODEL`, with the dimension pinned because it is the
  column type. `src/llm/embed.ts` is the seam, and it egresses through the 9.0
  metering gateway — `motir-ai` holds no upstream provider key.
- **A read-back boundary with sixteen routes.** `app/api/internal/ai/*` in this repo,
  each guarded by `authenticateAndLimitJobRequest` (the §4a service bearer + §4b
  job-scoped token) and each resolving the project from the **token**, never from the
  caller's body.

### The line this decision must not cross

Two files in `motir-ai` state the stance this story looks like it reverses:

- `src/llm/retrievalTools.ts`, under the heading _"No vector store — asserted BY
  CONSTRUCTION"_: _"It imports NO embedding module (`./embed`), no similarity search,
  no vector store — there is none in the loop. The retrieval surface is graph
  traversal + keyed reads, not RAG (the Rovo mirror)."_
- `prisma/schema.prisma`, above `model CodeRepo`: _"NO vector / embedding column —
  the code graph is graph-traversal, NOT RAG (the Epic-7 structured-not-RAG
  principle; only the 7.6 lessons store embeds)."_

That stance is right about **what it refuses**: dumping retrieved chunks into the
prompt as ground truth. This story does not do that, and §2 below is the clause that
keeps it from ever doing so.

---

## Decision

### 1. Residency — the vectors live in `motir-core`, beside the work items

A work item's embedding is stored **in `motir-core`'s database**, in the same tenant
scoping as the row it describes. `motir-ai` reaches it by **calling a search
endpoint** over the existing read-back boundary — the same posture as every other
plan-tree read it already makes.

**The rejected alternative: mirror work-item text into `motir-ai` beside the
lessons.** It is the cheaper-looking option — one repo, one database, the established
`Lesson` pattern copied a second time, no new boundary. It is disqualified on two
counts:

1. **It copies customer plan data across the open-core boundary into the closed
   service.** Work-item titles and descriptions are the customer's own product plans.
   Today they exist in exactly one place, under one tenant's RLS, in the repo the
   customer can read and self-host. A mirror would make the closed service a second
   durable home for that content, and the question of who holds a customer's plan text
   is a **data-residency** question, not a schema convenience.
2. **It inherits a freshness problem the lessons do not have.** A `Lesson` is written
   once and rarely edited. A work item's title and description change constantly, and
   every one of those edits would have to cross a service boundary to keep a mirror
   correct. A mirror that lags is worse than no mirror: it makes GATE 1 confidently
   report a card body that no longer exists.

Keeping the vector where the row already is means it can never disagree with the row,
and it inherits that row's tenancy for free.

### 2. THE INVARIANT — keys, titles and scores; never prose

> **The semantic search endpoint returns, for each result, exactly three fields:
> `key`, `title`, `score`. It returns no `descriptionMd`, no `explanationMd`, no
> comment, no acceptance criterion, and no other body text of any work item. Adding a
> fourth content field is a change to this ADR, not a change to the endpoint.**

**Semantic search PROPOSES; the relational reads DISPOSE.** The endpoint's job is to
name candidates. The planner then reads each candidate through the **existing keyed
tools** (`get_work_item`, `get-subtree`, `search-work-items`) against the real record,
and every claim that reaches the plan traces to one of those reads. No text ever
enters the prompt because a cosine distance was small.

**Why the `title` is in the contract and is not a violation of it.** A title is the
item's **identity**, not its content — it is the string the key resolves to, the
string every keyed read returns first, and the string a human uses to recognise which
card is being named. Returning `MOTIR-2694` without its title would make a findings
report unreadable and force the caller to make a second read per candidate purely to
render a name. Returning the `descriptionMd` would make the endpoint a retrieval
channel. The line is drawn between the two deliberately.

This is what makes §7's amendment an **extension** of the no-RAG stance rather than an
abandonment of it: the thing the stance refuses is retrieved prose as ground truth,
and that is precisely what this invariant forbids.

### 3. What is embedded — title **and** description, and nothing else

The embedded document is the two "what" fields, composed:

```
<title>\n\n<descriptionMd>
```

truncated to the first **8 000 characters** of the composed string.

- **Why the description is included, not the title alone.** This is a
  **candidate-finder**, and the failure it exists to fix is a **false negative** — a
  real card that the gate could not see, reported as "nothing matches". Recall matters
  more than precision here, because a spurious candidate costs one keyed read and is
  discarded, while a missed candidate costs a duplicate branch of the plan. The
  description is where a card's meaning actually lives; a title is a label written for
  a board column.
- **Why `explanationMd` is excluded.** It is the standing **rationale** ("why it
  matters"), not the work. GATE 1 asks _"does work like this already exist"_, which is
  a question about the `descriptionMd` axis. Including the explanation would lengthen
  the document and blur the centroid with prose that answers a different question. It
  is also null on most cards.
- **Why a character truncation, and why 8 000.** `text-embedding-3-small` accepts far
  more than this, so the cap is not a provider limit — it bounds cost and keeps a
  single unusually long card from producing a diffuse vector. Characters rather than
  tokens because `motir-core` has no tokenizer and should not grow one; a character
  count is deterministic and testable.
- **What happens on an edit.** The document is hashed, and the embedding is
  **re-derived exactly when that hash changes** — that is, when `title` or
  `descriptionMd` changes. A status transition, a re-parent, a sprint move, an
  assignee change, a priority bump, a reorder: **no embedding call**. The card's
  "descriptions go stale on every edit" concern is real for the naive trigger and is
  answered by making the trigger the _content_, not the _row_.

### 4. Storage — a sidecar table, not a column on `work_item`

The embedding lives in a new **`work_item_embedding`** table, one row per work item,
keyed by the work item:

| column         | type                             | note                                             |
| -------------- | -------------------------------- | ------------------------------------------------ |
| `work_item_id` | text, **PK**, FK → `work_item`   | `onDelete: Cascade` — the row dies with the item |
| `workspace_id` | text, NOT NULL, FK → `workspace` | the RLS axis (§5)                                |
| `project_id`   | text, NOT NULL, FK → `project`   | the query filter (§5)                            |
| `model`        | text, NOT NULL                   | e.g. `text-embedding-3-small` — see §6           |
| `dimensions`   | int, NOT NULL                    | 1536; asserted against the column type           |
| `content_hash` | text, NOT NULL                   | hash of the §3 document — the re-embed trigger   |
| `embedded_at`  | timestamptz, NOT NULL            | when this vector was derived                     |
| `embedding`    | `Unsupported("vector(1536)")`    | written and ranked through `$queryRaw` only      |

snake_case columns with per-field `@map`, per the newest table convention in this
schema.

**Why a sidecar and not four more columns on `work_item`:**

1. **The vector carries metadata that does not belong on the audited entity.** `model`,
   `dimensions`, `content_hash` and `embedded_at` describe a derivation, not the card.
   Four machine-written columns on the widest, hottest table in the schema is a worse
   trade than one narrow table.
2. **Absence is the semantics.** "This item has no embedding yet" is most honestly a
   **missing row**, not a nullable column that four other nullable columns must agree
   with. §6's coverage count falls straight out of it.
3. **The write cadences are different.** The embedding is written by a background job
   minutes after the item, on a different trigger, and must never contend with or
   appear to modify the item row that a user is editing.

`vector(1536)` is the same literal `motir-ai` uses, for the same reason: it is the
dimension `docs/decisions/embedding-provider.md` pinned for **every** semantic store,
so a vector produced by either service is comparable.

An **HNSW index** (`vector_cosine_ops`) ships in the same migration. Without it the
`<=>` ORDER BY is a brute-force scan — the reference implementation says so in its own
comment.

### 5. Tenancy — the same isolation the neighbouring tables have, plus a project filter

These vectors are derived from customer plan data and are treated as customer plan
data.

- **`workspace_id` is NOT NULL and the RLS policy ships in the same migration** — the
  no-unguarded-window rule. The policy is the `sprint` / `sprint_report_entry` one:
  `ENABLE` + `FORCE ROW LEVEL SECURITY`, one PERMISSIVE `FOR ALL` policy with
  `USING`/`WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true))`.
  There is no third option here — the repo's RLS totality guard
  (`tests/tenant-root-creation-rls.test.ts`) fails a new table that neither ships a
  policy nor is added to `DELIBERATELY_UNGUARDED`, and this table is not a candidate
  for that map.
- **Reads and writes run inside `withWorkspaceContext`**, which binds the GUCs the
  policy reads.
- **The search endpoint cannot cross a project boundary.** The project is
  `auth.projectId` — **the token's** project, resolved server-side, never taken from
  the request body — exactly as `search-work-items` does today. The ranking query
  filters `project_id = auth.projectId` in addition to standing under the workspace
  policy. There is no parameter through which a caller can name another project, and
  a token therefore only ever searches its own tenant's own project.
- Archived items are **excluded from results** (`archived_at IS NULL` on the work
  item) but their embedding rows are **kept** — un-archiving restores candidacy
  without a re-embed.

### 6. The endpoint and the write path, pinned

Pinned here in full so MOTIR-2696, MOTIR-2697 and MOTIR-2691 can be built against it
independently and merged in either order.

#### 6.1 The route

**`POST /api/internal/ai/similar-work-items`** — same family, same guard
(`authenticateAndLimitJobRequest`), same posture as the sixteen routes beside it:
service bearer + job token, never a cookie, never CORS-exposed.

**Request:**

```jsonc
{
  "queryEmbedding": [0.0123, -0.0456 /* … exactly 1536 floats … */],
  "model": "text-embedding-3-small", // the model the query was embedded with
  "limit": 10, // optional, 1–50, default 10
  "minScore": 0.0, // optional; omitted = no threshold
}
```

**Response — 200:**

```jsonc
{
  "results": [
    { "key": "MOTIR-2694", "title": "Semantic search over the plan tree — …", "score": 0.8312 },
  ],
  "model": "text-embedding-3-small",
  "coverage": { "embedded": 412, "total": 419 },
}
```

- **`score` is cosine SIMILARITY**, `1 - (embedding <=> queryEmbedding)`, higher is
  closer. The repository ranks by `<=>` **distance** internally — mirroring
  `lessonRepository` exactly — and converts once, at the DTO boundary. Two units, one
  conversion, in one named place.
- **Ordering is `distance ASC, identifier ASC`** — the identifier tiebreak makes the
  page deterministic.
- **The query is embedded by the CALLER.** The endpoint takes a vector, not text. The
  caller (`motir-ai`) already owns an `embed()` seam and the metered credential; making
  `motir-core` embed the query would add a `core → ai → gateway` hop to a call that
  `motir-ai` itself originated.
- **`model` is a hard filter, not a label.** Rows embedded with a different model are
  **excluded** from ranking (they are not comparable), and the response echoes the
  model it ranked in. This turns a model swap into a visible, rolling backfill instead
  of a silent collapse in result quality.
- **`coverage`** is `{ embedded, total }` for the project — two integers, no prose. It
  exists so a caller can distinguish _"I searched a fully-indexed project and there is
  genuinely nothing"_ from _"I searched a project that is 3% indexed"_. Reporting the
  first when the second is true is the exact failure mode this whole story was written
  to remove, and a candidate-finder that cannot tell them apart reintroduces it one
  layer up.
- **Degradation is a 200, never a 5xx.** No embeddings, an unbuilt index, an
  extension that is not there: `results: []` with an honest `coverage`. A planning job
  must never fail because a candidate-finder had nothing to offer. **Falling back to
  the relational `contains` search is the CALLER's move** (MOTIR-2691), because the
  caller is the one that knows what it was looking for.
- **No default `minScore` is pinned, deliberately.** A threshold chosen without data
  either suppresses real candidates or admits noise, and this story produces exactly
  the data needed to choose one — the before/after in **MOTIR-2698**. Until then the
  endpoint returns the top-N and the caller filters. **MOTIR-2698 owns the question of
  whether a default is warranted.** → **ANSWERED: no. See Amendment 1.**

#### 6.2 Who computes the vector — `motir-ai` does, for both sides

**`motir-core` stores embeddings; it does not produce them.** It has no provider
credential, no gateway token, and no embedding seam — verified: `LLM_GATEWAY`,
`EMBEDDING` and `embeddings` appear **nowhere** in this repo's `lib/` or `app/`. So
the write path calls `motir-ai` over the existing `motirAiClient` service seam, at a
new **`POST /v1/embeddings`** (`serviceAuth`, the same guard as every other
core → ai call), which embeds through the already-metered gateway and returns the
vector.

**The rejected alternative: give `motir-core` its own gateway credential.** It would
make the write path one hop shorter and is disqualified on two counts:

1. It puts an **LLM credential into the open-source repo** — a posture change every
   self-hoster inherits, for a feature that is otherwise pure storage.
2. It creates a **second metering identity**. `embedding-provider.md` §1's promise is
   that planning chat and its embeddings _"draw down the SAME balance"_ through one
   gateway token and one `CreditLedger`. A second credential in a second service is a
   second accounting path for the same tenant's spend.

Keeping the model, the dimension, the gateway token and the credit path in **one**
service also means the producer side and the query side physically cannot drift onto
different models — they call the same seam.

> **⚠️ This is a cross-repo deliverable that the story did not have a card for.**
> `motir-ai`'s `POST /v1/embeddings` does not exist (`src/app.ts` on `origin/main`
> exposes no embedding route), and MOTIR-2696 is pinned to `motir-core` alone — one
> subtask is one repo is one PR. **MOTIR-2720 owns the `motir-ai` endpoint**, blocks
> MOTIR-2696, and was created by this decision.

#### 6.3 The write path

1. **Trigger.** On **create**, on **update where the §3 document's hash changed**, and
   on **materialize** (proposals → work items). A backfill covers rows that predate
   the feature.
2. **Never inside the write transaction.** The embedding is an external network call;
   it is enqueued **after commit**, per this repo's side-effects-outside-the-transaction
   rule. A gateway outage degrades an item to "not yet a candidate" — it never fails a
   card create.
3. **The job re-reads before it embeds.** The queued job reads the item's **current**
   title and description at run time and embeds those — it does not embed a payload
   captured at enqueue time. Two rapid edits therefore converge on the current text
   whichever order their jobs run in, and no ordering guard, sequence number or lock is
   needed.
4. **Idempotent.** The job recomputes the hash, skips when it matches the stored row,
   and otherwise upserts on `work_item_id`.
5. **A missing embedding is not an error.** It is a row that is not a candidate. It
   never blocks a write, never fails a read, never surfaces as an error to a user, and
   is visible only as `coverage` in §6.1.

### 7. The two no-RAG claims — what changes, and what does not

Both claims are amended **by MOTIR-2691**, on the record, in the files named here.

**7a. `motir-ai/src/llm/retrievalTools.ts`** — the _"No vector store — asserted BY
CONSTRUCTION"_ header block.

- **What changes.** `motir-ai` will now embed a **query** and call a **similarity**
  endpoint over the plan tree, so "no similarity search in the loop" is no longer
  literally true of the retrieval surface. The header's own precedent for this shape
  is already in it: MOTIR-2689 added `web_search` and narrowed the claim rather than
  deleting it. This is the same move.
- **What does NOT change, and is the point.** The refusal the claim exists to encode —
  **no retrieved body text reaches the prompt as ground truth** — is untouched and is
  now stated positively as §2's invariant. The tools remain keyed reads over relational
  sources; what the similarity call returns is a **list of keys** those keyed reads then
  resolve.
- **What does NOT change, factually.** `motir-ai` still holds **no vector store**. The
  vectors are in `motir-core` (§1). The amendment is about the **loop**, not about the
  closed service's database.
- **The guard moves with the claim.** `tests/retrievalTools.test.ts` currently guards
  the stance **by absence** — it asserts no embedding module is imported. That assertion
  becomes false and must be replaced by one that asserts the **narrower, stronger**
  claim: that no field other than `key`, `title` and `score` crosses from a similarity
  result into the loop. A guard silently deleted because it went red is how a stance
  becomes a comment. **MOTIR-2691 owns this**, and **MOTIR-2698** asserts the invariant
  on both sides of the boundary.

**7b. `motir-ai/prisma/schema.prisma`, the comment above `model CodeRepo`.**

- **What changes — one parenthetical.** _"only the 7.6 lessons store embeds"_ is no
  longer true **product-wide**: `motir-core` now embeds work items. The sentence should
  say what it actually knows, which is a statement about **this schema**.
- **What does NOT change — the whole subject of the sentence.** **`CodeRepo` gets no
  vector column, and the code graph stays graph-traversal.** Semantic search over
  source code is a different corpus at a different cost with a different failure mode,
  and it is explicitly **out of this story's scope** — its own story, unwritten. A
  reader arriving at that comment from this ADR must come away with the code-graph half
  **strengthened by having been re-examined**, not weakened by association.

---

## Consequences

**For MOTIR-2696 (schema + write path, `motir-core`):**

- **The CI and local Postgres image must change, and this is not optional.**
  `docker-compose.yml` and `.github/workflows/ci.yml` both run
  **`postgres:16-alpine`**, which has no pgvector — `CREATE EXTENSION vector` fails on
  it. `motir-ai` hit this exact wall and moved both to **`pgvector/pgvector:pg16`**,
  documenting why in both files. Do the same, in the same PR as the migration.
- **Production is already proven.** `motir-ai` runs pgvector on Neon today, so the
  managed platform is not a risk to discover late. Confirm the extension against the
  actual instance before the migration merges.
- The migration is hand-written (Prisma does not model extensions or `Unsupported`
  indexes) — the same reason `motir-ai`'s pgvector, lessons-store and code-repo
  migrations are hand-written.
- **HNSW with a pre-filter under-returns, and that must be handled rather than
  discovered.** An approximate index search that returns its top candidates _before_
  `project_id` is applied can hand back fewer than `limit` rows for a small project in
  a large table. pgvector's **iterative index scans** (0.8+) or a raised
  `hnsw.ef_search` are the mitigations; **MOTIR-2696 picks one and pins it**, with a
  test that a small project still returns its full ranked set.

**For MOTIR-2697 (the endpoint, `motir-core`):** §6.1 is the contract in full. Thin
transport per `CLAUDE.md` — authenticate, validate the vector's length against the
pinned dimension, one service call, map typed errors. A `queryEmbedding` of the wrong
length is a 400, not a database error.

**For MOTIR-2691 (the consumer, `motir-ai`):** §7 is the amendment list. The fallback
to the relational `contains` search on an empty or low-coverage result is the caller's,
and GATE 1's findings report should say which search answered it.

**A new card exists because of this decision.** **MOTIR-2720** — `POST /v1/embeddings`
in `motir-ai` — is the producer half of §6.2. It did not exist when the story was
planned, and MOTIR-2696's write path cannot be built without it.

**Cost.** One embedding call per work item whose title or description changes, at
`text-embedding-3-small` rates (~$0.02 / 1M tokens), on a metered gateway that debits
the tenant's existing balance. Status flips, moves and re-parents — the overwhelming
majority of work-item writes — cost nothing (§3).

**What this decision does NOT open.**

- **The code graph** stays graph-traversal, with no embedding column (§7b).
- **`motir-ai` gains no vector store.** It gains a query it asks someone else.
- **Retrieval into the prompt** stays refused (§2). That is a boundary, not a
  preference.
- **A UI-facing semantic search** is not enabled by this. The endpoint is on the
  `internal/ai` boundary and takes a pre-computed vector, so any future in-product
  semantic search needs its own decision about who embeds the user's query — and it
  should cite this ADR when it makes it.

## Amendment 1 (2026-08-12) — NO default `minScore`. The `limit` is the bound, and the threshold stays the caller's

**§6.1 named MOTIR-2698 as the owner of "is a default threshold warranted". The answer
is no, and this records why so the question is closed rather than re-opened by the next
reader who notices the field is optional.**

**The cost asymmetry decides it, and this ADR already states the asymmetry — in §3, for
a different purpose.** §3 admits the `descriptionMd` into the embedded document on the
grounds that _"recall matters more than precision here, because a spurious candidate
costs one keyed read and is discarded, while a missed candidate costs a duplicate branch
of the plan."_ A default `minScore` is that trade run backwards: its only possible effect
is to convert cheap errors into the expensive one. And it would do so **invisibly** — a
suppressed candidate and an absent candidate are the same empty list at the wire, which
is precisely the false negative (_"nothing matches"_, reported honestly and wrongly) that
the whole story exists to remove. Re-creating it inside the fix would be a poor trade
even if the number were well chosen.

**And the number could not be well chosen here.** A cosine cutoff is a property of the
model AND of the corpus, and this repo holds neither: `motir-core` stores vectors and
does not produce them (§6.2), so it has no way to calibrate one and no standing to. The
before/after MOTIR-2698 produces demonstrates that the GAP is real — a card returned by
meaning that the `contains` filter cannot see — which is a statement about ordering, not
about where on the score scale a cut belongs. Reading a threshold off it would be
inventing data, not using it.

**So the contract is unchanged and now deliberate rather than pending:**

- The endpoint returns the top-N by similarity. **`limit` (1–50, default 10) is the only
  bound applied by default.**
- **`minScore` remains optional, with no default.** The CALLER may pass one — it knows
  what it asked and, per §2, reads every candidate through a keyed tool anyway, so a
  threshold there is a decision made with context rather than a constant compiled into
  the producer.
- Pinned by test in `tests/integration/ai/semanticSearchStoryGate.test.ts` (_"returns the
  top-N with NO default threshold"_): an orthogonal candidate at score 0 is returned,
  a caller-supplied `minScore` still filters, and `limit` still bounds.

**What would re-open this.** Evidence from a real corpus that low-scoring candidates are
crowding out real ones inside the caller's `limit` — i.e. a PRECISION complaint measured
on production traffic, not a tidiness argument. That evidence would belong to the caller
(MOTIR-2691's GATE 1), and the fix would still more likely be a larger `limit` plus a
caller-side threshold than a producer-side default.
