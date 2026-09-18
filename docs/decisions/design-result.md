# ADR: The design result on the work item — what publishes, how the note is scoped, entitlement, retention, the HTML serving posture, and the CI trigger

- **Status:** Accepted (2026-08-11, drafted for Story MOTIR-2664 per the
  decision-subtask ladder). This is the rung-1 policy the rest of MOTIR-2664
  implements — no design-result code ships until these six decisions are pinned.
  **No application behaviour ships in this subtask** (the ADR only).
- **Story / Subtask:** MOTIR-2664 (The design result on the work item — a design
  subtask's note, mock and screenshot published from CI and viewed in Motir) ·
  Subtask MOTIR-2665.
- **Consumed by:** MOTIR-2666 (data model + design-scoped allowlist), MOTIR-2667
  (publish endpoints), MOTIR-2668 (CI publisher + the `design-guards` step),
  MOTIR-2669 (design asset), MOTIR-2670 (panel UI), MOTIR-2671 / MOTIR-2672
  (tests), MOTIR-2673 (the platform-starter port).
- **Builds on:** `acceptance-video.md` (the artifact-publishing pipeline this
  reuses wholesale — entitlement shape, supersede/retention, keyless CI auth),
  `attachment-access-control.md` (the private store + authenticated read path),
  and the shipped blob/attachment substrate (`lib/blob/*`, `attachmentsService`).
- **Supersedes / superseded by:** none. **But note:** the design-preview
  mechanism sketched in Story MOTIR-693 (9.2 Design approval gate) — deploying a
  mock to an ephemeral preview host so an iframe has a URL — is **superseded by
  this record**; see §7.
- **Amended by:** **AMENDMENT 1** (MOTIR-3750, 2026-08-28 — §1's note arm
  matches a suffix), **AMENDMENT 2** (MOTIR-3780, 2026-08-28 — the publish
  door is the MCP tool; **§6 is superseded in full** and §1 keeps its
  classification table while losing its producer) and **AMENDMENT 3**
  (MOTIR-4750, 2026-09-07 — **AMENDMENT 2 Q3's single-call shape is no longer
  the only shape**: `create_design_upload` adds the mint-then-PUT door Q3
  rejected, because the ceiling Q3 measured was not the binding one) and
  **AMENDMENT 4** (MOTIR-5489, 2026-09-14 — a result is the changed mock(s) plus
  the note as a link, **no `.png`, no inline `noteMd`**, published **only when an
  open work item is `blocked_by` the design**, a change is a new delta mock, and
  the asset set is two files; **§1's `image` row and note-section scoping, and
  AMENDMENT 2 Q2, are superseded**; its **Q8** (MOTIR-5533) adds that a design
  card with an open linked pull request — one or many — shows its result INSIDE
  the Development block and raises no `design_result` gate) and **AMENDMENT 5**
  (MOTIR-5555, 2026-09-17 — **the published result is the design's SOURCE OF
  TRUTH** and a repository copy is optional; what "approved" means to a
  consumer is the version the APPROVAL named, resolved gate-subject → pin →
  current, on a card at `done`, with five named no-design reasons; a run is
  handed the approved design of the design cards its card waits on, in
  `$MOTIR_DESIGN_DIR` or by fetching it; `list_designs` / `get_design` and the
  `/api/v1` operations browse the rest on `project:browse`; and a `done` blocker
  only lets a run START. **Its Q2 answers the window `approval-gates.md` §6c's
  second amendment part 7 left open, and supersedes the reading that the
  approved design is the CURRENT result of a `done` design card.**). **Read all five before treating §1, §6 or
  AMENDMENT 2 Q2/Q3 as current.** The title still names "the CI trigger" because that is
  what this record decided and every citation of it lands here; AMENDMENT 2 is
  where it stops being true.

> Convention (set by `work-item-type-taxonomy.md`, followed by
> `billing-tiering.md` / `acceptance-video.md`): a decision record is a markdown
> file under `docs/decisions/`, structured **Status → Context → Decision →
> Consequences**, with the load-bearing facts pinned in explicit tables so
> downstream code has one authoritative source to implement against.

---

## Context

A `type: design` subtask's deliverable is the **three-file asset set** — a
`design-notes.md` section, a `*.mock.html` mockup, and a same-basename `.png`
export, under `design/<area>/`. Today that is the whole story: the files land in
a merged branch and **Motir shows nothing at all**. To judge a design, a reviewer
leaves the tool, finds the pull request, and opens raw files on GitHub. Every
other artifact Motir produces already comes home — a story's E2E publishes a
video the reviewer watches in the acceptance panel; PR state, CI state and
provenance all read on the item page.

MOTIR-2664 closes that gap by reusing the acceptance-video pipeline with
different cargo: CI publishes the design result onto the work item, and a
`Design result` panel renders each artifact the way that artifact deserves to be
read.

Six choices decide **what is published, which work item owns it, what it costs,
how long it lives, how HTML is served safely, and what fires the publish.** Each
is settled here so that six sibling cards implement one answer rather than six.

### Shipped substrate this reconciles against (verified 2026-08-11 on `origin/main` @ `28d0cb00`)

| Fact                                                                                                                                                                                                                                                                                                                                                                                                                 | Where                                                                                                                                                                                                                   |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Generic upload allowlist — images + docs; **no HTML, no video** (415 otherwise)                                                                                                                                                                                                                                                                                                                                      | `lib/blob/allowlist.ts` (`ALLOWED_UPLOAD_TYPES`)                                                                                                                                                                        |
| A **path-scoped** allowlist already exists as a pattern, deliberately kept OUT of the generic one                                                                                                                                                                                                                                                                                                                    | `lib/blob/allowlist.ts` (`ALLOWED_ACCEPTANCE_VIDEO_TYPES`, `isAllowedAcceptanceVideoType`)                                                                                                                              |
| `AttachmentSource` = `editor` · `panel` · `acceptance_video` · `acceptance_trace`; the panel listing EXCLUDES the lifecycle-owned sources                                                                                                                                                                                                                                                                            | `prisma/schema.prisma` (`enum AttachmentSource`)                                                                                                                                                                        |
| One-current-per-subject enforced by a **partial unique index**, not by the service                                                                                                                                                                                                                                                                                                                                   | `prisma/migrations/20260705222141_add_acceptance_evidence/migration.sql` (`acceptance_evidence_one_current_per_story`)                                                                                                  |
| RLS shape for a lifecycle table: **pure active-workspace gate**, `ENABLE` + `FORCE`, **no `app.system_admin` hatch**                                                                                                                                                                                                                                                                                                 | same migration                                                                                                                                                                                                          |
| Attachment FKs are `SetNull` so the orphan-GC can reclaim a blob without vaporising the history row                                                                                                                                                                                                                                                                                                                  | same migration; `lib/jobs/definitions/attachmentGc.ts`                                                                                                                                                                  |
| Presigned **PUT** binds the content type INTO the signature (`signableHeaders`); it can carry **no size ceiling**                                                                                                                                                                                                                                                                                                    | `lib/blob/uploader.ts` (`mintPrivateUploadToken`)                                                                                                                                                                       |
| The register step therefore re-reads the object's **authoritative** size/type                                                                                                                                                                                                                                                                                                                                        | `lib/blob/uploader.ts` (`headPrivateBlob`)                                                                                                                                                                              |
| Presigned **GET**, 300 s; `ResponseContentDisposition` is set **only** when `download: true` — otherwise the object is served inline with its stored content type                                                                                                                                                                                                                                                    | `lib/blob/uploader.ts` (`signedDownloadUrl`)                                                                                                                                                                            |
| The authenticated content read **302-redirects** to that presigned URL, so bytes are fetched from the **object-store host**, not `app.motir.co`                                                                                                                                                                                                                                                                      | `app/api/attachments/[id]/content/route.ts`                                                                                                                                                                             |
| Keyless CI publish: GitHub Actions **OIDC** → repo → `GithubInstallation.workspaceId` → the workspace **owner** as uploader; `integration` PAT as fallback                                                                                                                                                                                                                                                           | `lib/acceptanceEvidence/publishAuth.ts`; `acceptance-video.md` §4 amendment                                                                                                                                             |
| The acceptance publish resolves a subtask key **UP to its parent story** and refuses a non-`story` target                                                                                                                                                                                                                                                                                                            | `lib/services/acceptanceEvidenceService.ts` (`resolveStory`)                                                                                                                                                            |
| …and asserts `work_item:edit` on the **target's** project, not the actor's active project                                                                                                                                                                                                                                                                                                                            | same (`resolveStory`, MOTIR-2365)                                                                                                                                                                                       |
| Cost bounds already enforced on every publish                                                                                                                                                                                                                                                                                                                                                                        | `entitlementsService.resolvePerFileLimitBytes`, `assertWithinStorageCap`                                                                                                                                                |
| `ci.yml` has a **`design-guards` job that runs on every PR** and exists to read `design/**`; `permissions: contents: read`                                                                                                                                                                                                                                                                                           | `.github/workflows/ci.yml` (`design-guards` → `pnpm vitest run --config vitest.design.config.ts`)                                                                                                                       |
| `ci.yml` triggers on **`pull_request` AND `push: branches: [main]`**                                                                                                                                                                                                                                                                                                                                                 | `.github/workflows/ci.yml` (`on:`)                                                                                                                                                                                      |
| The lane arrangement is guarded by a test, not by review                                                                                                                                                                                                                                                                                                                                                             | `tests/ci-design-guards-lane.test.ts`                                                                                                                                                                                   |
| The acceptance lane **never republishes post-merge** — since MOTIR-2760 by gating its publish step on `pull_request` rather than by having no `push:` trigger — and runs **no `continue-on-error`** on that step. ⚠️ Since MOTIR-4096 that lane has **no publish step at all** (the agent publishes over MCP), so the property now holds structurally; the reasoning is kept because it is what this record borrowed | `.github/workflows/acceptance-tests.yml` (MOTIR-1937/1949; MOTIR-2499; MOTIR-2760; renamed and its publisher retired by MOTIR-4096)                                                                                     |
| Target-card resolution from the branch ref / PR title                                                                                                                                                                                                                                                                                                                                                                | ~~`scripts/upload-acceptance-video.mjs` (`resolveStoryKey`, `parseWorkItemKey`)~~ — retired by MOTIR-4096, the same way and for the same reason this record's own publisher was by MOTIR-3797: the agent NAMES the card |
| Markdown has ONE render path, used by both content axes                                                                                                                                                                                                                                                                                                                                                              | `lib/markdown/render.tsx`                                                                                                                                                                                               |

### The measurement that decides §1

`design-notes.md` is written **per AREA, not per card**:

| Measurement                              | Value                                                  |
| ---------------------------------------- | ------------------------------------------------------ |
| Areas carrying a `design-notes.md`       | **39**                                                 |
| Total size of all `design-notes.md`      | **2,084,260 bytes**                                    |
| `design/work-items/design-notes.md`      | **303,395 bytes**, **29 `##` sections**                |
| Largest single `##` section (work-items) | **32,169 bytes** (_Work-item quick view (peek) modal_) |
| Content above the first `##`             | the file title + the **surface index table**           |

A design card appends **one** `##` section to that file. Publishing the file
would therefore attach a 303 KB, 29-surface document as "this card's design
note" — the difference between a note worth reading and an artifact people learn
to ignore.

---

## Decision

### 1. What publishes, and how the NOTE is scoped

**Published set = the PR's changed files under `design/**`\*\*, classified by
name:

| Pattern                                 | Asset kind | Published as                          |
| --------------------------------------- | ---------- | ------------------------------------- |
| `*.mock.html`                           | `mock`     | the file, whole                       |
| `*.png`                                 | `image`    | the file, whole                       |
| `design-notes.md` / `*.design-notes.md` | `note`     | **only the changed SECTIONS** (below) |
| anything else under `design/**`         | —          | **not published** (ignored, logged)   |

> ⚠️ **The note row was `design-notes.md` alone until AMENDMENT 1 below
> (MOTIR-3750, 2026-08-28).** Read that amendment before treating the exact
> basename as the contract — it is the row that changed, and the reason it
> changed is the reason it looked right.

> ⚠️ **And the PRODUCER of this set is no longer CI — AMENDMENT 2 below
> (MOTIR-3780, 2026-08-28).** The table still says what an asset classifies AS;
> it no longer says who classifies it. A diff is not what determines the
> published set any more: the **agent declares it**, and the note arrives as
> sections the agent names rather than sections a diff computed.

A path **deleted** by the PR publishes nothing for that file.

**Note extraction — diff-hunk → nearest enclosing `##`.** Read the diff of
`design-notes.md` against the PR base with `git diff -U0`, take each hunk's
**new-side** line range, map each range to the nearest **preceding `##` heading**
in the file at `HEAD`, and emit those sections **whole, de-duplicated, in file
order**.

- **Why heading-mapping and not a key convention.** A `MOTIR-<n>` marker inside
  the asset would be a cleaner join — and it would be a **planner rule with two
  homes** (`plan-rules/` + `SHARED_PLANNING_RULES`), a rule every future design
  card must remember, and a silent no-publish whenever someone forgets. The diff
  is already the ground truth and needs nothing from the author. **The publisher
  stays diff-driven and MOTIR-2664 changes no planner rule.**
- **Parse the headings explicitly.** Do NOT rely on git's hunk-header
  (`@@ … @@ <context>`) or on `--function-context`: those depend on a diff driver
  being configured for Markdown and are not a contract. Walk the file for
  `^## ` offsets.
- **`###` is not a boundary.** Sections are `##`; the `###` subsections
  (_Placement_, _Anatomy_, _States in the mockup_, _Tokens / a11y_) belong to
  their parent section and travel with it.

**FALLBACK — a change ABOVE the first `##`** (i.e. in the file title or the
surface index table) **contributes NOTHING to the note.** Rationale: the index
table is an INDEX; a design card that adds a surface always adds both a table row
and the `##` section describing it, so the section carries the meaning. If a PR
changes **only** the table and no section, the publish emits **no note** for that
file and logs `design-notes.md changed above the first section — no surface
described; note omitted`. It does **not** fall back to publishing the whole file.

**CAP — 64 KiB of stored note text, and nothing is ever lost.** The extracted
markdown is stored inline for rendering (`DesignEvidence.noteMd`) up to
**65,536 bytes**, truncated **at a section boundary** with an explicit trailing
marker naming how many sections were dropped. **In addition, the full extracted
markdown is ALWAYS published as a `text/markdown` asset** (`DesignAsset.kind =
'note_file'`), so the complete note is obtainable even when the inline copy is
truncated. 64 KiB comfortably holds the largest section on record (32,169 bytes)
and two typical ones; the `note_file` makes the cap a rendering bound rather than
a data-loss bound.

### §1 — AMENDMENT 1 (MOTIR-3750, 2026-08-28): the note arm matches a SUFFIX, as the mock and the export already did

**What changed.** `classifyDesignPath` read
`path.basename(filePath) === 'design-notes.md'`. It now also accepts
`*.design-notes.md`. Nothing else in §1 moves: the extraction is still
diff-hunk → nearest enclosing `##`, the fallback above the first `##` is
unchanged, and the 64 KiB cap plus the `note_file` companion are untouched.

**Why the old row was wrong, and why it did not look wrong.** The three arms
disagreed with each other. The mock and the export matched on SUFFIX; the note
matched on an EXACT basename. So `landing.mock.html` and `landing.png` published
while `landing.design-notes.md` classified as `null`, landed in `ignored`, and
was never published. **The failure is silent and PARTIAL** — the card receives
the pictures, none of the words, a green check and a real evidence id. Nothing
reddens, and a reader who opens the card sees a design result rather than an
absence.

The losing name is the one `CLAUDE.md` § _Design assets — THREE files per
surface_ literally prescribes: _"you MUST land all three, **with a shared
basename**"_, and then exempts the note in a parenthesis. Two authors wrote a
per-surface note against that headline rule, ten weeks apart, in two
repositories:

| file                                                       | last touched                                                  | published its note? |
| ---------------------------------------------------------- | ------------------------------------------------------------- | ------------------- |
| `design/org-admin/create-workspace.design-notes.md`        | 2026-06-13, and 2026-08-10 in #2004                           | never               |
| motir-marketing `design/marketing/landing.design-notes.md` | 2026-08-28, renamed to `design-notes.md` on motir-marketing#2 | not under that name |

**The alternative was rejected on shipped reality, not on taste.** Renaming the
non-conforming file and guarding the convention is not a `git mv`:
`design/org-admin/` already carries BOTH `design-notes.md` (the area index) AND
`create-workspace.design-notes.md`, so the rename is a content MERGE. And it
leaves the trap armed for the next author, whose words vanish exactly as these
did. Widening the reader costs one predicate and cannot fail silently.

**The per-area convention is UNCHANGED and still enforced.** §1's note is still
written per AREA; `tests/design-three-file-set.test.ts` still fails an area that
ships an asset without a `design-notes.md`. This amendment only stops the
publisher DISCARDING a note somebody wrote beside a surface. Publishing several
notes from one pull request has been supported since MOTIR-3145 —
`buildPublishSet` emits EVERY note, each as its own `note_file`, and the inline
`noteMd` is their concatenation in collection order.

**The separator is load-bearing.** `<surface>.design-notes.md` publishes;
`xdesign-notes.md` and `design-notes.markdown` do not
(`tests/design-assets-uploader.test.ts`).

**What this amendment does NOT do: republish the file that was dropped.** The
publish step is `pull_request`-only (§6), so a note publishes only from a pull
request whose diff contains it. `design/org-admin/create-workspace.design-notes.md`
was last touched on 2026-08-10 in #2004 — **two days before the publisher
existed** (`scripts/upload-design-assets.mjs` landed 2026-08-12,
`cacfe0180`, MOTIR-2664) — so the classifier never actually cost that file a
publish; the mechanism was not there to run. Its absence is recorded here rather
than repaired: the next pull request that touches it publishes it, which is the
first time any pull request could have.

### 2. Entitlement axis — NONE. A deliberate deviation from `acceptance-video.md`

| Check                     | Rule                                                                                                                                                               |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Feature **eligibility**   | **Ungated.** No `hasPaidAiPlan` gate. No `Organization` toggle column. No eligibility service, and therefore **no upsell state and no toggle state** in the panel. |
| Per-upload **cost bound** | Unchanged and still enforced: `resolvePerFileLimitBytes(orgId)` per file, `assertWithinStorageCap(orgId, bytes)` in total.                                         |

**Why this deviates, recorded so nobody "restores consistency" later.** The
acceptance video is plan-gated and org-toggled because a ~100 MB clip **per
story** is a real, recurring storage cost, and video generation is an AI-adjacent
capability. A design result is **tens of kilobytes** — the largest mock in the
repository is 48 KB, a note section 32 KB — and **reading the design of the work
you are reviewing is core project management, not a paid AI feature.** Gating it
would paywall the design-before-code rule the whole plan rests on.

The mechanical caps stay because they are defence-in-depth, not policy: they
already run on every publish and bound a pathological asset without anyone
deciding anything.

### 3. Which work item owns the result — the DESIGN SUBTASK ITSELF

| Case                                              | Rule                                                                                                                                                |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Target is a **leaf** (`subtask` / `task` / `bug`) | **Accept.** The result attaches to that item.                                                                                                       |
| Target is a **container** (`story` / `epic`)      | **Refuse** — `400`, typed error. A container's design lives on its children.                                                                        |
| Target leaf is **not `type: design`**             | **Accept.** A `code` card may legitimately amend an asset (a token fix, a corrected panel), and the result belongs to the card whose PR changed it. |

**This is the OPPOSITE of the acceptance path and the difference is
deliberate.** `acceptanceEvidenceService.resolveStory` resolves a subtask key UP
to its parent story and refuses a non-`story`, because a story has exactly one
end-to-end receipt. A story has **many** designs — one per design subtask — so
rolling them up to the parent would pile unrelated surfaces onto one panel and
lose which card produced which. The result belongs to the card that produced it.

**Authorization is unchanged in shape:** `work_item:edit` asserted on the
**target's** project, resolved from the work item (not the actor's active
project) — the gate `resolveStory` learned in MOTIR-2365, whose absence made a
token-minting endpoint reachable with a session and an id.

### 4. Retention, supersede, and idempotency

| Knob                  | Value                                                                                                                                                             | Enforced by                                                                                                                                                                                                                                     |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Current results**   | **Exactly one per work item**                                                                                                                                     | A **partial unique index** on `("work_item_id") WHERE "is_current"` — the `acceptance_evidence_one_current_per_story` shape. A concurrent double publish loses at the constraint and the service retries; two current rows are unrepresentable. |
| **Supersede**         | A new publish flips the prior row `is_current = false` and inserts the new one, in **one transaction** that locks the prior row first (the write is read-derived) | `designEvidenceService`                                                                                                                                                                                                                         |
| **History**           | Superseded rows are **kept**                                                                                                                                      | —                                                                                                                                                                                                                                               |
| **Superseded blobs**  | Become orphaned Attachments → reclaimed by the **existing orphan-GC** (blob-first, 7-day window). No new GC path.                                                 | `attachmentsService` orphan GC                                                                                                                                                                                                                  |
| **Deleting the card** | `work_item` FK **Cascade** — the result dies with its card                                                                                                        | schema                                                                                                                                                                                                                                          |
| **Attachment FKs**    | **`SetNull`** — a GC'd blob leaves the history row standing                                                                                                       | schema                                                                                                                                                                                                                                          |
| **Idempotency**       | A re-publish of the **same `commitSha` + `producedByKey`** returns the existing current evidence: no re-upload, no duplicate history row                          | `findIdempotentExisting`, mirroring the acceptance service                                                                                                                                                                                      |

A push to an open PR re-runs the lane and **supersedes** — that is correct and
intended: the panel shows the design as of the latest commit, and the history
rows record the iterations.

> **⚠️ A DESIGN RESULT IS NEVER FROZEN — do not port the acceptance receipt's
> freeze rule here.** `acceptance-receipt-lifecycle.md` (Story MOTIR-2765) makes
> an **approved** acceptance receipt immutable: a republish is REFUSED rather
> than superseding it. That rule keys off `AcceptanceEvidenceStatus.approved` —
> a human's signature on one recording. **A design result has no such status and
> no approval gate** (§2 above gates nothing; the "approve" of Story MOTIR-693 /
> §7 is a runtime workflow gate, not a property of the artifact), so there is
> nothing to freeze on, and superseding is the intended behaviour described in
> this very table. **Acceptance receipts are signed-and-frozen; design results
> are superseded-by-design** — same storage shape, opposite lifecycle. See
> `acceptance-receipt-lifecycle.md` §5.
>
> **⚠️ AMENDED (MOTIR-5554, 2026-09-15):** superseded-by-design holds for every
> card that is not `done`. A design card in the `done` category is CLOSED — §7's
> amendment and `approval-gates.md` §6c's second amendment.

### 5. The `text/html` serving posture — THREE layers, all required

Publishing a mock means accepting an HTML file from a repository and rendering it
to a signed-in user. That is the shape of a stored-XSS bug if any layer is
skipped, so all three are pinned here and each sibling card implements the same
one.

| #     | Layer                              | Rule                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ----- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **a** | **A design-scoped MIME allowlist** | `ALLOWED_DESIGN_ASSET_TYPES = ['text/html', 'image/png', 'text/markdown']` + `isAllowedDesignAssetType`, **NOT spread into `ALLOWED_UPLOAD_TYPES`**. An HTML file dropped on the attachments panel or pasted into a description is **still a 415**, exactly as a video still is. Enforced at mint time (declared type) **and** at register (actual type, via `headPrivateBlob`).                                                                         |
| **b** | **Cross-origin by construction**   | Reads go through `GET /api/attachments/[id]/content`, which 302s to a presigned S3 GET. The signed URL is on the **object-store host, not `app.motir.co`**, so the document cannot reach the app's origin, cookies or storage even before any sandbox is applied. No new public URL is introduced; the read stays authenticated and per-item authorized.                                                                                                 |
| **c** | **A fully restrictive `sandbox`**  | The panel's iframe carries `sandbox` with **neither `allow-scripts` nor `allow-same-origin`** — never the two together, and here neither at all. The shipped assets tolerate this because they are self-contained: `design/work-items/acceptance-panel.mock.html` is 48 KB of inline CSS with **zero** `<script>`, `<link>` or remote URL. Asserted in a component test and again in the browser by the E2E, so the posture cannot be softened silently. |

**Consequence, stated so it is a decision and not a surprise:** a mock that
requires JavaScript to render will appear inert in the panel. That is the
intended trade — a design mockup is a static artifact, and the `.png` plus
open-in-new-tab remain as escapes.

### 6. The CI trigger and its auth

> ⚠️ **SUPERSEDED IN FULL by AMENDMENT 2 below (MOTIR-3780, 2026-08-28).** The
> CI trigger is retired: there is no `design-guards` publish step, no
> `id-token: write` on that job for this purpose, and no publisher script in any
> repository. **The table below is kept as the record of what was decided and
> why** — several of its rows are the reasoning AMENDMENT 2 had to answer for
> rather than reasoning it discarded, and §6a's two defect fixes are the case
> for retiring the mechanism rather than repairing it a third time. Read it as
> history; implement AMENDMENT 2.

| Knob                         | Value                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Host**                     | A step in `ci.yml`'s **existing `design-guards` job** — NOT a new workflow. That job already runs on every PR and already exists to read `design/**`.                                                                                                                                                                                                                                                                                               |
| **Why not a new workflow**   | A new workflow means a **new check on every PR that touches design**. The acceptance lane needed its own file because it had no always-on host job and a job-level `if:` still reports a skipped check (MOTIR-1949 / MOTIR-1958). Here a host job already exists, so the cheaper arrangement is also the correct one: **no new check appears anywhere.**                                                                                            |
| **Event**                    | **`pull_request` only** — `if: github.event_name == 'pull_request'`. `ci.yml` also runs on `push: main`; republishing an identical result after merge is the behaviour `acceptance-tests.yml` deliberately avoids as well. Same decision, and since MOTIR-2760 reached the same way: that lane has a `push: main` baseline too, and gated its own publish step on `github.event_name == 'pull_request'` until MOTIR-4096 removed the step outright. |
| **Permissions**              | The job gains **`id-token: write`** alongside `contents: read`.                                                                                                                                                                                                                                                                                                                                                                                     |
| **Auth**                     | **Keyless GitHub Actions OIDC first** (repo → `GithubInstallation.workspaceId` → workspace owner as uploader), the `integration`-scoped API token as the documented fallback for repos not connected via the App. Nothing to mint or store.                                                                                                                                                                                                         |
| **No credential**            | The script logs that publishing is opt-in and **exits 0** — a fork PR gets neither OIDC nor the secret, and must not fail the build.                                                                                                                                                                                                                                                                                                                |
| **Unresolvable target card** | Log the would-be publish set and **exit 0 without publishing.** **No fallback constant.** The acceptance uploader falls back to its dogfood story, which is right for a receipt better attached somewhere than nowhere; a design attached to the **wrong** card is worse than one attached to none — it makes another card look designed when it is not, and the design gate that reads it would pass on a lie.                                     |
| **`continue-on-error`**      | **Forbidden on this step.** MOTIR-2499 removed it from the acceptance publish after it rewrote a failing step's conclusion to `success` for days while two stories silently lost their receipts. Both cases that justified it are handled inside the script (above), so the only remaining meaning of red is _a publish that should have happened did not_. Guarded by `tests/ci-design-guards-lane.test.ts`.                                       |

### 6a. A CONTAINER target is a NO-OP, and the PR's own diff is measured from where its branch diverged (MOTIR-3124 / MOTIR-3104)

Two independent defects made this job fail on pull requests that had no design
result to publish at all. Both are fixed; they are recorded together because
each one alone still leaves the other reachable.

**(a) A container target is a no-op, not a red build (MOTIR-3124).** A parent run
opens one pull request per repository on `parent/MOTIR-<story>-…`, and carries a
design child's asset amendments alongside the code they document (MOTIR-3009).
`resolveTargetKey` prefers the branch ref, so the target is a STORY — and the
service refuses a design result addressed to one, correctly, because a result
attaches to the leaf that produced it (§3). The refusal now exits 0 rather than
red.

**The distinction that keeps §6's `continue-on-error` prohibition intact:** red
means _a publish that should have happened and did not_. A design result
addressed to a story is a publish that must **never** happen — the same class as
_no resolvable target card_, which this script already exits 0 on. It is not a
failure being swallowed.

> Rejected: skipping on the branch PREFIX before the request. It reads as
> cheaper — no round trip — but it only recognises the refs it enumerates, so a
> container named in the PR TITLE, or a prefix nobody thought of, still reddens
> the build. The service's own answer covers every way a target can turn out to
> be a container, which is the property worth having.

**(b) The publish set is measured from where the BRANCH diverged (MOTIR-3104).**
`collectChangedDesignFiles` diffed `github.event.pull_request.base.sha` against
the checkout — but on a `pull_request` event the checkout is the MERGE COMMIT, so
every `design/**` change the base branch made between the event snapshot and the
merge was attributed to the pull request. Observed on PR #2145, a story PR
touching no design file, which reported two changed note sections belonging to
someone else's merged design PR.

⚠️ **On a `subtask/*` branch this does not even fail** — the target resolves to a
leaf and the publish SUCCEEDS, putting another card's design on this card with a
real evidence id under a green check. The design-reference rule reads that asset,
so a wrong attribution can make an undesigned surface look designed. That is the
outcome §6's no-fallback-target rule already refuses; this closes the other way
in.

`resolveDiffBase` picks, most trustworthy first: the merge commit's FIRST PARENT
(the base it was merged with — needs no ancestry, which matters in this job's
depth-1 clone where `merge-base` may have no shared history); else
`git merge-base`; else the supplied base, logged rather than silent.

### AMENDMENT 2 (MOTIR-3780, 2026-08-28): the publish door is the MCP tool — §1's producer, and §6 in full

**What changed.** The design result is published by the **agent that drew the
asset, through an MCP tool** (`publish_design_result`), not by a CI script
reading a diff. §6 is superseded in full and §1 keeps its classification table
while losing its producer. Everything else in this record is untouched — see
_What does NOT change_ below, which is a list rather than a sentence because the
temptation on a change this size is to sweep the neighbours out with it.

**Why the CI shape could not be repaired in place.** The publisher is a file,
and a file has to BE in whatever repository the design lands in. Measured on each
default branch on 2026-08-28: `motir-core` carries the original in-tree;
`motir-marketing` `curl`s a copy **pinned to a SHA** (`6e71acf21`), so
AMENDMENT 1's own fix — merged hours earlier — can never reach it;
`nextjs-prisma-vercel-starter` carries a **hard fork** frozen at `1b4fbe0`
(2026-08-11), 438 lines against motir-core's 977, missing `resolveDiffBase`,
`headParents`, `NotALeafError`, `NotAChildError`, `attributeChangedPaths`,
`parseCommitCardKey` and `partitionAssetsByCard`; and a customer's own
repository carries nothing at all. **The starter's copy still runs the two-dot
`git diff` that §6a(b) fixed**, so a scaffolded repository publishes assets it
did not author onto whichever card its branch names, into a tenant with no
withdrawal route.

That is not a discipline problem, and this is the property worth recording:
**a stale copy is GREEN.** Nothing imports it, nothing type-checks it against an
interface, no check compares it to anything, and the specs that cover the
original (`vitest.design.config.ts`) do not travel with it. Every signal
available was correct for seventeen days.

**Why the tool is the right door and not a new capability.**
`DESIGN_PUBLISH_PERMISSION` is `work_item:edit` (`lib/tokens/grant.ts`) and
`CLI_TOKEN_GRANT` (`lib/mcp/toolPermissions.ts`) already carries it — a fact
`lib/mcp/tools/attachFile.ts` already states in a comment. So no credential and
no trust is added. The script exists to answer three questions the agent already
knows the answer to — which card, which files, which sections — and each is an
INFERENCE the tool replaces with a DECLARATION. §6a is two defects in a row in
exactly those inferences.

---

#### Q1 — the HTTP publish routes SURVIVE, as a deliberately-supported public surface

`POST /api/work-items/[id]/design-evidence/upload-token` and
`POST …/design-evidence` **stay**, and this paragraph is the record that says so.

**Measured, on `origin/main` after AMENDMENT 1.** Their only non-test callers
were `scripts/upload-design-assets.mjs:646` and `:686` — the script this story
deletes — plus two PROSE references that instructed an agent to POST them
(`CLAUDE.md`, `lib/dispatch/promptTemplate.ts`), both since rewritten to name the
tool. **⚠️ EXECUTED (MOTIR-3797 / MOTIR-3800, 2026-08-28): the script is deleted
and their internal caller count is now ZERO. That is the expected steady state,
not a defect** — the paragraphs below are what a later sweep must read before
reaching for the routes.

**This is exactly the shape `kind-story.md`'s CALLER TEST names as an ORPHANED
DELIVERABLE** — _"a service or route whose only callers are its own routes"_ —
so the record has to name the intended consumer or the next sweep is right to
delete them. **The intended consumer is any publisher that is not an MCP
client:** a customer's own CI, a design tool, a script, a `curl`. The governing
split is the one already in force — `/api/mcp` is the door for AGENTS, the
versioned REST surface is the door for CLIENTS — and deleting these routes would
make design publishing MCP-only, a narrowing nobody asked for and one that would
land hardest on exactly the self-hosted and customer-owned cases this story
exists to serve.

**They earn a second keep from Q3 below**, which is the stronger reason: they are
the overflow valve for an asset too large to travel base64 inside one JSON-RPC
call. A record that keeps a route only "for a future consumer" ages badly; this
one has a named, measured, in-tree job.

**What does NOT survive with them:** nothing here re-decides §6's auth. Both
routes keep `authenticateCiPublisher` and `authenticateGithubOidc` exactly as
they are — those are shared with the acceptance-video publisher, which is
untouched by this story and would fail silently if either were narrowed.

#### Q1a — `id-token: write` on an UNCONNECTED repository is a RED CHECK, not a quiet skip

**Preserved here by MOTIR-3799**, which deleted the `motir-marketing` job whose
comment block was the only place this was written down. It is a fact about
`authenticateGithubOidc`, not about that workflow, so it outlives the YAML that
held it — and it still governs the surviving HTTP publish routes, which is why it
sits under Q1.

The keyless path resolves the TENANT from the OIDC token's verified `repository`
claim (`githubRepoRepository.findConnectedByName`). So the permission has a
precondition, and it is the repository being **connected to Motir**:

- **Connected** ⇒ the claim resolves, the publish is keyless, nothing is minted
  or stored.
- **NOT connected** ⇒ the claim resolves to nothing and the request is
  `403 repo_not_connected`. Because the credential was _present_, the script does
  not take its no-credential arm — so the job goes **RED on every pull request**
  rather than skipping quietly.

`motir-marketing` shipped its lane deliberately WITHOUT the permission for
exactly this reason (MOTIR-3750) and gained it only once MOTIR-3743 connected the
repository. **The rule that follows: grant `id-token: write` to a publish job in
the same change that connects the repository, and remove it in the same change
that disconnects one.** The failure mode of getting it wrong is a red check on
every pull request, which is loud — but loud in a way that looks like the
publisher being broken rather than the repository being unconnected.

#### Q2 — the AGENT supplies the sections, and here is what that gives up

§1 decided diff-hunk → nearest enclosing `##` because _"the diff is already the
ground truth and needs nothing from the author"_. **The tool has no diff, so the
agent names the sections it wrote.**

**What the heuristic bought, stated plainly because it is a real loss:
it could not be forgotten.** A diff-driven publish needs nothing from the author
and therefore cannot be skipped by an author who is tired at the end of a long
run. Declaration can be. **This record does not pretend otherwise** — it accepts
a mechanism that CAN be forgotten in exchange for one that can BE ABSENT, and the
second failure is worse: a forgotten call is one card missing its result, while
an absent publisher is every card in a repository missing every result, silently,
for as long as nobody looks.

**Three mitigations, all of which must exist for this trade to hold:**

1. **The tool's own description** is the instruction an agent reads at the moment
   it can act on it — the same lever `link_pull_request` uses for the same class
   of forgettable-but-load-bearing call.
2. **`WHAT_TO_DO.design` in the dispatch prompt** names the call as a step of the
   design flow (MOTIR-3783), and `run.md` does the same for the runbook.
3. **`CLAUDE.md`'s existing silent-failure warning is RETARGETED, not deleted**
   (MOTIR-3791). It exists because the CI publish used to fail silently while
   everything else looked perfect. That risk does not disappear with CI — **it
   moves**, and the new shape is identical from the outside: files written,
   commit landed, pull request open, checks green, card empty.

**What stops an agent shipping the whole note.** Measured on `origin/main`:
`design/work-items/design-notes.md` is **396,091 bytes across 35 `##`
sections** (the largest of
several; `design/ai-planning/design-notes.md` is 222,619 and
`design/projects/design-notes.md` 196,863). _"Send the note"_ is therefore not an
acceptable fallback, and the existing **64 KiB `noteMd` cap** (§1) is what
enforces it — unchanged by this amendment, and now doing a second job it was not
designed for. The cap remains a RENDERING bound rather than a data-loss bound
because the `note_file` companion still carries the complete text.

> ⚠️ **The card's own figure was stale and is corrected here.** MOTIR-3781 was
> authored against _"303 KB across 29 sections"_. The file is 396,091 bytes
> across 35 sections. The conclusion is unchanged and strengthened.

#### Q3 — bytes in the call, and the measured ceiling that makes it safe

**DECISION: the assets travel base64 INSIDE the tool call**, mirroring
`attach_file`'s `contentBase64`, one call per publish. This follows the parent
story's own acceptance criterion — _note, mock and `.png` in ONE tool call_ —
and it is the shape that works in a repository Motir has never seen, which is the
whole point of the change.

**The measurement, which is the one thing a later reader cannot re-derive**
(`git ls-tree -r -l origin/main -- design/`, 2026-08-28):

| quantity                                     | value                                                                                                                                                                             |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| largest `design/**/*.png`                    | **5,198,426 B = 4.96 MiB** — `design/public-projects/public-projects.png`                                                                                                         |
| the same, base64                             | **6,931,236 B = 6.61 MiB**                                                                                                                                                        |
| next four                                    | `shell/navigation-pending.png` 5,192,740 · `coding-convention/convention.png` 5,020,622 · `coding-convention/convention.dark.png` 4,827,418 · `ai-chat/ask-answers.png` 4,203,196 |
| population                                   | **192 files, 253,419,444 B total, 1,319,892 B mean**                                                                                                                              |
| `MAX_UPLOAD_BYTES` (`lib/blob/allowlist.ts`) | **10 MiB, PER FILE**                                                                                                                                                              |
| raw bytes that fit base64 under that cap     | **7.5 MiB**                                                                                                                                                                       |

**So the ceiling the chosen shape imposes is 7.5 MiB of raw asset per file, and
today's largest asset is 4.96 MiB — 1.51× headroom.** A typical publish (one
note section, one ~48 KB mock, one 1.3 MiB mean `.png`) is under 2 MiB encoded.
A worst-case publish today is ≈ 6.7 MiB encoded in one request body.

> ⚠️ **The card's premise was wrong by 3.6×, and this is why AC 4 asked for a
> measurement.** MOTIR-3781 was authored against _"~1.4 MB
> (`design/org-admin/org-admin.png`), ~1.9 MB base64"_. The real largest is
> **4.96 MiB / 6.61 MiB base64**. A shape sized against 1.9 MiB would have looked
> like it had 5× headroom when it has 1.5×.

**Rejected: mint-then-PUT for the general case.** It keeps large binaries off the
JSON-RPC channel and it matches the surviving routes — both real advantages — but
it costs 1 + N round trips, it re-introduces a multi-step protocol an agent can
abandon halfway (leaving a minted target and no registration), and it contradicts
the one-call criterion. The single-call shape is chosen for the **usual** case on
the measured distribution, not for the extreme.

**And the extreme has a named door rather than a hope.** The tool **refuses** an
asset over `MAX_UPLOAD_BYTES` with a message naming the measured headroom and
pointing at the mint-then-PUT routes Q1 keeps. That is the second, load-bearing
reason those routes survive: **the single-call shape is only safe because the
multi-call shape still exists.** If a future asset exceeds 7.5 MiB raw, nothing
is stuck and no decision has to be reopened — and if that becomes routine rather
than exceptional, THAT is the trigger to revisit this answer, not a smaller
number chosen defensively today.

#### What does NOT change

Listed rather than implied, because the risk on an amendment this size is that a
neighbour is swept out with the mechanism:

`designEvidenceService` and every path under it · the `Design result` panel ·
the blob posture and §5's three `text/html` layers in full · the **64 KiB
`noteMd` cap** and the `note_file` companion · `ALLOWED_DESIGN_ASSET_TYPES` and
its deliberate exclusion from `ALLOWED_UPLOAD_TYPES` (an HTML file on the
attachments panel is **still a 415**) · the withdrawal route from MOTIR-3215 ·
§2's no-entitlement axis · §3's leaf-owns-the-result rule and its
`NotALeafError` refusal · §4's retention, supersede and idempotency ·
`authenticateCiPublisher` / `authenticateGithubOidc` · the `design-guards` CI
**job** and every `design/**` guard it runs (`design-three-file-set`,
`design-asset-addresses`, `design-ink-contrast`, `design-dark-parity`,
`orb-glyph-contrast`) · and the three-file authoring rule itself — the repository
stays the source of truth, and the published result remains the card's VIEW of an
asset that is still committed.

**Only the CALLER moves.**

#### The ORDER, and why the reverse leaves no publish path at all

**The tool ships → the deployed tenant is verified → then the lanes are
deleted.** Not negotiable, and it is the reason the retirement is a separate
story (`blocked_by` MOTIR-3780) rather than four more subtasks here.

**Merged is not deployed.** A card ends at _pull request opened_; the merge
starts a deploy that finishes minutes later, and `app.motir.co`'s `tools/list` is
the only thing that says whether the door exists yet. Delete three publish lanes
against a tenant that does not yet serve the tool and there is **no publish path
in any repository at all** — briefly, silently, with nothing red anywhere to say
so. This project has already lived that exact window once: `update_plan_proposal`
and `withdraw_plan_proposal` were on `main` while the tenant's `tools/list` still
answered fifty tools carrying neither, and passes that planned around them
stranded work they could not fix.

**The ordering is carried by a CONTAINER edge, and that placement is itself a
decision.** It was first written as a `verification` leaf inside this story
blocking three retirement leaves — which cannot work: those retirements could
only be written after a deployment produced by the merge of the very pull request
they would have had to be committed on, and a container's pull request may not
open while its children are un-landed. The gate now lives in the sibling story,
and the sibling story is `blocked_by` this one, so `readiness.blockedByAncestor`
holds every retirement until the tool has actually shipped. Recorded as planning
bug MOTIR-3794.

### AMENDMENT 3 (MOTIR-4750, 2026-09-07): the mint-then-PUT door AMENDMENT 2 Q3 rejected is now a TOOL — the inline ceiling was not the binding limit

**AMENDMENT 2 Q3 is amended, not superseded.** Its single-call shape stays, it
stays the DEFAULT, and every word of its measurement is still true. What was
wrong is the conclusion drawn from it: Q3 measured ONE limit and treated the
answer as bounded by it.

**The two limits, and the one Q3 did not measure:**

| limit                         | value                                                                                                                                                                                            | measured by     |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------- |
| the per-file blob cap         | 10 MiB → **7.5 MiB of raw asset**, against a 4.96 MiB largest — 1.51× headroom                                                                                                                   | Q3              |
| the MCP route's own body cap  | a serverless function, capped ≈4.5 MB → base64 fails at **≈3 MB of raw asset**                                                                                                                   | neither         |
| **the agent's OUTPUT budget** | the bytes are a TOOL ARGUMENT a model must EMIT: base64 tokenises at **≈0.4 characters per token**, so a 3.9 MB board is ≈5.24 MB of base64 and even a 44 KB thumbnail costs **~150,000 tokens** | **AMENDMENT 3** |

**The third limit is the binding one, and it cannot be raised.** Q3's own
`create_acceptance_upload` twin had already written it down one section away in
`docs/mcp.md` — _"the bytes would have to be EMITTED by the agent as a tool
argument"_ — as one of the two reasons a recording gets a mint-then-PUT door.
Both halves of that reasoning apply verbatim to a design board; the premise that
kept the design result on the inline path was the sentence _"a design asset
arrives inline as base64"_, and for a multi-sheet board that premise is false.
Measured: `design/ai-chat/planning-workspace.png` is **3,929,899 B**, and it is
not an outlier in Q3's own population (192 files, 1.32 MB mean, five over 4 MB).

**And Q3's escape hatch did not hold.** It named the surviving HTTP mint-then-PUT
routes as _"a named door rather than a hope"_ for the extreme, and Q1 kept them
partly for that reason. But those routes authenticate a **CI job over GitHub
OIDC** (`authenticateCiPublisher` / `authenticateGithubOidc`) — a credential a
dispatched agent does not hold and cannot obtain. So the door existed and the
caller who needed it could not open it. **A fallback the failing caller cannot
reach is not a fallback**, and Q1's argument for keeping the routes stands on its
other leg (a non-MCP publisher), not on this one.

**The failure mode is the one this whole record exists to prevent.** A run that
cannot emit the bytes has two options and both look like success: skip the call
and report a green pull request, or publish a thumbnail that satisfies the letter
of the rule and shows a reviewer nothing. Files written, commit landed, checks
green, panel empty — AMENDMENT 2 Q2's own words for the hazard it accepted, now
arriving for a reason nobody chose.

**DECISION.** `create_design_upload` mints one short-lived presigned PUT per
file, bound to one object and one media type; `publish_design_result` accepts a
`pathname` per asset as an alternative to `contentBase64`. It is the same two
calls `create_acceptance_upload` + `publish_acceptance_result` already are, over
`designEvidenceService.createUploadTokens` + `.recordFromPathnames` — the service
methods the HTTP routes have called since MOTIR-2667. **No policy is added and no
service changed**: the leaf / child gates, the allowlist, the per-file cap, the
authoritative `head`, the prefix check, `capNoteMd`, supersede and idempotency
all stay exactly where they are.

**ONE publish uses ONE form for all its assets; a mix is refused by name.** The
two forms reach two different service methods, and reconciling them inside the
adapter would make the tool the only place that decides how a design result is
assembled — the one thing AMENDMENT 2 was careful not to let it become. Minting a
grant for every asset costs one call.

**What Q3's rejection got right, and why the default does not move.** Its
objections to mint-then-PUT — 1 + N round trips, a multi-step protocol an agent
can abandon halfway, the one-call criterion — are all still true, and they are
why this is an ADDED door rather than a replacement. On Q3's own distribution the
usual publish (a note section, a ~48 KB mock, a 1.3 MB mean `.png`) is well
inside the inline path and should stay there. Q3 also named its own revisit
trigger — _"if that becomes routine rather than exceptional, THAT is the trigger
to revisit this answer"_ — and this is that trigger firing, with the correction
that the number to watch was never the blob cap.

**What does NOT change:** the entire _What does NOT change_ list under
AMENDMENT 2 Q3, unchanged, plus AMENDMENT 2 itself — the agent still DECLARES its
target, nothing is inferred from a branch, a title or a diff, and a design card
is still unfinished until the evidence id is on it.

### AMENDMENT 4 (MOTIR-5489, 2026-09-14): a result is WHAT TO REVIEW — the changed mock(s) with the note as a link, no screenshot, published only when work waits on the design

**What changed, in one sentence.** A design result used to be everything a
design card drew — the note sections inline, the mock, the `.png` export — and
every design card published one. It is now **the mock of what changed, with the
note one link away**, and it is published **only when a work item that is not
finished is `blocked_by` the design card**. Story MOTIR-5488 implements it; the
decisions below were settled by Yue on 2026-09-14 (rung 3 — the requester's
explicit choice), and this amendment writes them down once so every sibling card
implements one text.

**Why.** A design result exists to put in front of a person the decision they are
being asked to make. Measured against that, the old shape carried three kinds of
noise. The first thing a reviewer met was the note — prose written so that an
agent can build to the design — rendered at full height above the design itself.
Below the mock sat a screenshot of that same mock, which earned its place when a
design could only be seen on its pull request and is now a second copy of what
the panel already shows. And a change to one panel of an existing surface
arrived as the whole redrawn surface, so the reviewer had to find the change
before judging it. The publish rule added a fourth: every publish raises an
approval gate (`approval-gates.md` §1), and a gate is only worth asking a person
for when something waits on its answer.

#### Q1 — what a result IS: one or more `mock` assets plus exactly ONE `note_file`

| input on a publish (MCP tool, `create_design_upload`, or either HTTP route) | disposition                                                                                                                                          | refusal code                         |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| a `mock` asset (`*.mock.html`)                                              | **required — one or more.** A delta change may publish several delta mocks (Q3)                                                                      | `DESIGN_EVIDENCE_MOCK_REQUIRED`      |
| a `note_file` asset (`design-notes.md` / `*.design-notes.md`)               | **required — exactly one.** Still written, still published; the result SHOWS it as a link (Q5)                                                       | `DESIGN_EVIDENCE_NOTE_FILE_REQUIRED` |
| an `image` asset (`.png`)                                                   | **RETIRED — refused.** The `design_asset_kind` enum value `image` STAYS, so stored rows keep reading; no migration                                   | `DESIGN_EVIDENCE_IMAGE_RETIRED`      |
| `noteMd` (the inline note sections)                                         | **RETIRED — refused**, whether empty or not. The `design_evidence.note_md` column STAYS for stored rows; nothing writes it any more, so no migration | `DESIGN_EVIDENCE_NOTE_MD_RETIRED`    |

All four answer `422` over HTTP — the request parses, and its SHAPE is one the
contract no longer accepts (the class `DESIGN_EVIDENCE_NOT_A_LEAF` already
answers 422 for). An `image` or `noteMd` is checked FIRST, so a
caller still sending the old three-file shape is told which input is retired
rather than something vaguer about its count.

**A retired input is REFUSED, never silently ignored.** An agent cannot tell an
ignored field from an accepted one: a publish that quietly dropped the `.png`
would return an evidence id, the agent would report the screenshot published,
and the next agent reading that report would believe it. A refusal naming the
retired input is the one answer that changes what the caller does next.

**The refusal fires at `create_design_upload` too**, for the asset-kind half: a
grant requested for `kind: image` is refused with
`DESIGN_EVIDENCE_IMAGE_RETIRED`, so no bytes are uploaded for a publish that can
never succeed. The mock / note-file COUNT is a property of the whole publish, so
it is checked at publish, not per grant.

#### Q2 — WHEN a result is published: only when an open work item is `blocked_by` the design card

**The rule.** A publish is accepted only when at least one work item that is
**not archived** and whose status is **not in the `done` category** carries an
`is_blocked_by` edge TO the design card —
`workItemLinkRepository.findByToItem(designCardId, 'is_blocked_by')`, filtered.
Otherwise it is refused `DESIGN_EVIDENCE_NOTHING_WAITS` (`409` — the request is
well-formed; the tree is in a state where a result has no one to serve), with a
message saying that no open work item is `blocked_by` the design, so its pull
request is its review.

**The read happens TWICE, and both are load-bearing:** at `create_design_upload`
(the upload-grant mint — so an agent is refused BEFORE it PUTs bytes) and again
at publish, inside the publish transaction (so a dependent that closed between
the mint and the publish is seen).

| case                                                                                | counts?          | why                                                                                                                              |
| ----------------------------------------------------------------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| a dependent under **another story or epic**                                         | **yes**          | the edge is what makes the design a precondition; where the dependent sits in the tree is irrelevant                             |
| a dependent that is **`done` or `cancelled`**                                       | **no**           | both are the `done` CATEGORY; nothing waits on an answer for work that is finished or abandoned                                  |
| a dependent that is **archived**                                                    | **no**           | a person decided it should not be worked, which is a stronger instruction than its status                                        |
| a **parent-run** publish (`withinParentKey`), dependents are siblings in that story | **yes**          | a sibling is a work item like any other; the parent run changes where the design's commit lands, not whether its dependents wait |
| a **republish** after the last dependent has closed                                 | **no — refused** | the same read, at the same two moments. The earlier result and its gate are untouched: a refused publish supersedes nothing      |
| a **bug** whose fix needs a design first                                            | **yes**          | that bug is `blocked_by` its design, so it is simply the first row; it is not an exception to the rule                           |

**A design card with no result is reviewed through its pull request.** A design
that nothing waits on — a design defect fixed in place, a record of a surface as
built — opens its `design/*` pull request as it always has, and that pull
request is approved through `pull_request_approval` (`approval-gates.md` §1's
amendment). No `design_result` gate is raised for it, because no publish
happened. **This is not a way to skip review; it is the review moving to where
the change already is.**

**What the rule deliberately does NOT read:** the design card's own `type`
(§3 still accepts a `code` card amending an asset — it publishes under the same
rule), the dependent's `type` or kind, and whether the edge was planned or wired
later. The edge is the whole question.

#### Q3 — a change to an existing design is a NEW DELTA MOCK

- **Name:** `<surface>--<change>.mock.html`, beside the surface it amends, in the
  same `design/<area>/`. The double hyphen separates the surface from the change,
  so `detail--design-result-review.mock.html` reads as _a change to `detail`_.
- **Content:** ONLY the panels that change — the changed state, the new
  element, the altered layout — drawn from the real shipped components exactly
  as a full mock is (the design-against-shipped-reality rule is unchanged).
- **Note:** a NEW `##` section in the area's `design-notes.md`, citing the
  section and the mock it amends by path.
- **The existing mock is NOT edited.** It is the record of the moment it was
  drawn. A design is for its moment: the next run renders what the default branch
  actually ships before it builds, so an older mock is a record, never a
  specification to keep current.
- **The result publishes the delta mock(s) only**, plus the area note as the one
  `note_file`.
- **What counts as "only the changed panels" is a drawing judgement** carried by
  the convention, the dispatch prompt and the runbook — not a guard. No check
  measures a delta.

#### Q4 — the asset set is TWO files: `design-notes.md` + `<surface>.mock.html`

The `.png` export is **no longer required anywhere** — not by a convention, not
by a guard, not by the publish. A `.pen` source is **not accepted for a NEW
design**, because a `.pen` can only be reviewed through its export, and the
export is what this amendment retires. **Existing exports and `.pen` sources are
not deleted** — 232 `.png` and 14 `.pen` under `design/` on `origin/main`
(`git ls-tree -r --name-only origin/main -- design | grep -cE '\.png$'` /
`'\.pen$'`, at `d1f0863b5`). They are records; nothing will read them as
required, and deleting them changes nothing a reviewer sees.

#### Q5 — the note link targets the published `note_file` ATTACHMENT

Not a repository URL. The attachment is the one address that works for every
repository a result can come from — connected, unconnected, private, a
customer's own — and it is the one `approval-gates.md` §6c's pin retains with an
APPROVED result, so the link a reviewer approved beside is still there after a
supersede. It is served through `GET /api/attachments/[id]/content` like every
other design asset (§5 unchanged).

#### Q6 — STORED results are shown with their files reachable as LINKS

A result published before this amendment may carry an inline `noteMd` and
`image` assets. **No data migration.** The panel keeps every file reachable —
the note, and each screenshot — as a link, and re-renders nothing inline. A
decided gate's record therefore stays inspectable exactly as it was decided,
without the retired rendering coming back for the stored rows.

#### Q7 — what this SUPERSEDES, and what it does NOT

**Superseded:**

- **§1's classification table, the `*.png` → `image` row** — retired for new
  publishes (Q1). The `mock` and `note` rows stand; the `note` row now publishes
  the WHOLE area note as the `note_file`, never sections.
- **§1's note-SECTION scoping and the 64 KiB inline cap** — there is no inline
  note to scope or cap. The `note_file` companion, which §1 introduced so the cap
  was "a rendering bound rather than a data-loss bound", is now the only note.
- **AMENDMENT 2 Q2 (_the AGENT supplies the sections_)** — amended: the agent
  supplies no sections. Q2's mitigations for a forgettable publish still stand,
  now joined by a publish that can be CORRECTLY absent (Q2 above) — so the
  dispatch prompt carries the publish step only when the server finds a waiting
  dependent, and a design card with none is not "missing its result".
- **§5's _"the `.png` plus open-in-new-tab remain as escapes"_** — the `.png`
  half; open-in-new-tab stands.
- **The KIND table row in `approval-gates.md` §1's amendment** — _"the mock, the
  notes, the screenshot"_ now reads _the changed mock(s), the note as a link_.

**NOT changed:** §2's no-entitlement axis · §3's leaf-owns-the-result rule and
`NotALeafError` / `NotAChildError` · §4's retention, supersede and idempotency,
and `approval-gates.md` §6c's pin · §5's three `text/html` layers in full ·
`ALLOWED_DESIGN_ASSET_TYPES` (`image/png` stays allowed for READING stored
rows) · AMENDMENT 2's explicit-key declaration · AMENDMENT 3's two asset forms ·
the gate lifecycle: a publish still raises an `awaiting` `design_result` gate,
and a design with a pull request is still approved through
`pull_request_approval`.

The ~~struck~~ convention this record uses for superseded text is NOT applied to
§1 above: its table is still the correct description of a stored row, and this
amendment is where a reader learns which of its rows a new publish may still use.

> ⚠️ **Q8 below narrows the gate-lifecycle line in "NOT changed".** A publish
> still raises an `awaiting` `design_result` gate — on a card with NO open linked
> pull request. Q8 is the other case.

#### Q8 — a design card WITH open linked pull requests: the result renders INSIDE the Development block, and ONE gate decides (MOTIR-5533, 2026-09-14)

> ⚠️ **SUPERSEDED IN PART by AMENDMENT 6 (MOTIR-5658, 2026-09-17) — read that
> first.** The ONE-APPROVAL ruling below stands; the CARRIER is reversed. A
> design card with an open linked pull request holds **two** gates, with
> `design_result` as the PRIMARY and the merge riding on it — point 1's _"raises
> no `design_result` gate"_ and point 3's LINK arm are both retired. Point 2's
> rendering is unchanged. This block is kept as the record of what was decided on
> 2026-09-14 and why.

**Settled by Yue on review of this story's own design:** _"if there's linked PR,
the PR and the design should show together in one section, just like how to
test. because they become one gate, approve the design will merge the PR too.
reuse the development PR UI."_ — and, the same day, _"there can be multiple
linked PRs, we don't set the limitation."_

**This is not new policy.** `approval-gates.md` §1's amendment already keys
`design_result` to _"a design with **no pull request**"_: a design that opened
one is approved through `pull_request_approval` — _"same gate, design port"_ —
and §8 Workflow B gives design and code the same rows. What this amendment had
left unsaid, and what the shipped publish contradicted (it raised a
`design_result` gate on every publish), is written down here.

1. **Which gate.** A design card with at least one OPEN linked pull request —
   `workItemDeliveryRepository.countOpenByWorkItem(workItemId) > 0` — is decided
   by the approve-to-merge gate (MOTIR-4909): **ONE gate over the card's whole
   delivery set**, however many pull requests it links and in however many
   repositories, and approving it merges every one of them. Its design result
   raises **no** `design_result` gate. A design card with no open linked pull
   request keeps the `design_result` gate exactly as Q1–Q7 describe.
2. **Where it renders.** The result renders **inside the Development block**:
   the design result **once** — the mock frame(s), then the note link — then
   How to test, then every linked pull-request row (the shipped row UI, reused),
   as ONE section and ONE frame. What there is to review leads; the pull
   requests that carry it follow. **There is no limit on how many pull requests a
   card links**; the design result belongs to the CARD, not to any one pull
   request, so it is never repeated per row. No standalone Design result section
   is drawn on that card. The slot lives in the block itself, so the item page,
   the quick-view peek and the approval overlay's port show the same thing.
3. **When the answer is read — at publish and at link.**
   - **Publish:** the open-delivery read runs inside the publish transaction; when
     it is > 0 the evidence is recorded and superseded exactly as before, and no
     gate is created.
   - **Link:** linking a pull request — the first or a later one — to a card that
     holds an **awaiting** `design_result` gate supersedes that gate (§6b's
     `superseded` state) in the link's own transaction. A DECIDED design gate is
     left alone: an answer outlives its subject.
   - **Unlink / close:** writes nothing. A design gate is not resurrected when the
     last open pull request goes away; the next publish raises one.
4. **Before MOTIR-4909 ships.** The Development frame has no verbs until the
   approve-to-merge gate is registered, so such a card has no gate in Motir and is
   merged on the host — exactly as a code card is today. The design result is
   still visible in the block.
5. **What does NOT change:** Q1's shape and its refusals, Q2's publish-only-when-
   work-waits rule, the two-file set, the delta mock, the note as a link, stored
   results, and `approval-gates.md` §6c's pin — an approval through
   `pull_request_approval` pins the current design version, which
   `approvalGatesService.decide` already does for every kind.

### AMENDMENT 5 (MOTIR-5555, 2026-09-17): the published result is the design's SOURCE OF TRUTH — what "approved" means to a run, the version it is handed, where the files land, and the run-time design gate

**What changed, in one sentence.** An agent used to find a design by opening
`design/<area>/` in a repository checkout, and Motir — which stores every
published result — had no door that gave one back. **The published result is now
the source of truth**, a run is handed the approved design of the design cards
its card waits on, and it may browse the rest through read doors that did not
exist. Story MOTIR-5553 implements it; the decisions below are Yue's, settled in
conversation on 2026-09-14/15 (rung 3), written down once so the read service,
the `/api/v1` and MCP doors, the dispatched prompt, the CLI and the runbook each
implement ONE text. **No application behaviour ships in this card.**

**Why.** Two things break the repository as the authority. A project may not
commit its designs to a repository at all, and nothing else could hand an agent
a design: `app/api/work-items/[id]/design-evidence/route.ts` exports only `POST`
and `DELETE`, no MCP tool reads a result, and `lib/dispatch/promptTemplate.ts`'s
`code` steps name only the card's context refs. Meanwhile every published result
is already stored, versioned, with the approved version pinned. Motir could take
a design in and never give it back out.

#### Q1 — the SOURCE OF TRUTH is the published result

**The published design result governs.** A repository copy under
`design/<area>/` is **optional and never the authority**; where both exist and
differ, the published result is the design. A project that commits nothing to a
repository still has designs its agents can build against.

This supersedes two sentences that have been read as current for months, both
listed with their sweeper in Q8.

#### Q2 — what "approved" means to a consumer: the version the APPROVAL named, not the version that is current

> ⚠️ **ARM (b) IS RETIRED by AMENDMENT 6 Q6 (MOTIR-5658, 2026-09-17).** It exists
> only for AMENDMENT 4 Q8's no-gate path, and AMENDMENT 6 Q1 restores the design
> gate on a card with an open pull request — so arm (a) covers that window and
> the ladder becomes **gate → current**. The `pinnedAt` write STAYS: §6c's
> retention reads it. The window this Q describes is closed a second way by
> AMENDMENT 6 Q3, which refuses a publish on a card whose design gate is decided.

**This is the question `approval-gates.md` §6c's second amendment part 7
deliberately left open and handed here**, and the answer is not the one this
card was drafted with.

**The window.** §6c's second amendment closes the `done` category: a `done`
design card accepts no new version. It closes nothing earlier. A design card
with an open linked pull request is approved through `pull_request_approval`,
which writes `approved` (§2b), and only the MERGE writes `done`. Between the two
the card is open, so a publish still supersedes — the approval named X, a
publish makes Y current, the merge writes `done`, and _the current result of a
`done` design card_ is Y, **a version nobody approved**.

**So current-ness is not the identity.** The approved design of a design card is
resolved in this order, and the first arm that answers wins:

| #   | arm                                                                                                               | why it is the authority there                                                                                                                                                                                                                                                                                                                   |
| --- | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a   | the **`subjectId` of the card's most recent DECIDED `approved` `design_result` gate** — that `DesignEvidence` row | the gate row is the audit of _what was decided_, and `designResultHandler.resolveSubject` never re-points it at a newer version: _"the version the reviewer never saw"_ is exactly what it refuses                                                                                                                                              |
| b   | otherwise the card's **newest pinned** (`pinnedAt`) non-withdrawn row                                             | AMENDMENT 4 Q8's path: a card with an open delivering pull request raises **no** `design_result` gate (`designResultHandler.currentSubject` returns null on it), so there is no gate to read — but `approvalGatesService.decide` pins the CURRENT row on **every** approving kind, so the merge approval's pin is what the decision left behind |
| c   | otherwise the **current** (`isCurrent`), non-withdrawn row                                                        | a `done` design card no gate ever decided — closed by hand, or published before gates existed. There is no approval to honour, so the card's own latest word stands                                                                                                                                                                             |

**And the card must be `done`.** Not the `done` CATEGORY — `cancelled` sits in
it — but the status key `done`. `approved` is not enough: it is the state in
which the window above is still open.

**Anything else is NO DESIGN, named by reason** rather than returned empty, so a
consumer can say which of five things happened:

| reason              | when                                                           |
| ------------------- | -------------------------------------------------------------- |
| `not_a_design_card` | the blocker's `type` is not `design`                           |
| `not_done`          | a `design` card at any status but `done` — `approved` included |
| `cancelled`         | the card was cancelled                                         |
| `withdrawn`         | the row the ladder resolved is withdrawn (`withdrawnAt` set)   |
| `no_result`         | the card has no `design_evidence` row at all                   |

**What makes this sound**, and both invariants are load-bearing rather than
decorative: a card cannot reach Done while its approval is pending
([MOTIR-4887](motir:cmts0dtc3000lhwoiykn5j8i9)), and a `done` design card
accepts no new version (§6c's second amendment, `DESIGN_CARD_CLOSED`). Arm (a)
closes the one window those two leave between them.

> **⚠️ ARM (a) CAN RESOLVE TO A ROW WHOSE BYTES ARE GONE, AND THAT IS CORRECT
> RATHER THAN A HOLE.** `approvalGatesService.decide` pins the row that is
> CURRENT at decision time, not the row the gate was asked about, and reports the
> difference as `filesKept: false` when a racing republish moved it. So an
> approved version can be superseded without its attachments being pinned, and
> the orphan-GC reclaims them after §4's 7-day window. The read door reports
> those assets `unavailable` (Q6). It does **not** silently fall to the next arm:
> handing a run a version nobody approved is the failure this whole Q exists to
> prevent, and _the approved design's files are gone_ is a true answer a person
> can act on.

#### Q3 — the version IDENTITY is the `DesignEvidence` row id

**A version is its row id.** A row's content never changes after publish — the
repository's only updates touch `isCurrent`, `pinnedAt` and the `withdrawn*`
columns (`designEvidenceRepository.markSupersededByWorkItem`, `pinById`,
`withdrawById`) — so the id alone names what was approved, with no revision
number to keep.

**Not `commitSha`**, which is provenance and may be null: a design published from
a tree with no commit behind it is an ordinary case, and
`designResultHandler.subjectVersion` already records that approval with a null
version rather than refusing it. [MOTIR-5232](motir:cmtxm4wkh00fkhztx19vzvkgi)'s
stamp reads `subjectVersion ?? ''`, so such a design is not weaker there either.

#### Q4 — what a run is handed BY DEFAULT: the designs its card waits on, and nothing else

For each work item the run's card is `blocked_by` whose `type` is `design`: that
card's approved design (Q2) with **every asset** — the mock(s), delta mocks
included, and the note file — or its no-design reason.

**Not the project's other designs.** Handing an agent every design in the project
buries the one it is building against, and everything else is one `get_design`
call away (Q6).

#### Q5 — WHERE the files land: the run's own directory, all or nothing, gone with the run

**When the launcher can materialize them** — the CLI's `motir run` — it writes
them into the run's own temporary directory, the one the prompt file and
`$MOTIR_AGENT_REPORT` already live in, and hands the agent **`$MOTIR_DESIGN_DIR`**.

- **All or nothing.** A partial directory is worse than none: an agent that finds
  two of three mocks has no way to know a third existed, and designs to what it
  can see. A fetch that cannot complete leaves no directory and the prompt says
  to fetch instead.
- **Removed with the run**, exactly as the rest of that directory is. The design
  is not a checkout artifact and nothing should inherit it.

**When nothing materialized them** — `--print`, a runbook session, a future
hosted harness — **the agent fetches them itself** through `get_design`. The
dispatched prompt names both cases, so an agent that finds no `$MOTIR_DESIGN_DIR`
is told what to do rather than concluding there is no design.

#### Q6 — BROWSING further: approved designs only, on `project:browse`, behind short-lived links

MCP `list_designs` / `get_design` and the matching `/api/v1` operations return
**approved designs only** (Q2), assert **`project:browse`** — the key
`CLI_TOKEN_GRANT` already carries, which is left unchanged — and hand back
**short-lived download links** (the `signedDownloadUrl` presign), never file
bytes in a payload.

- **An asset whose stored file is gone reports `unavailable`**, never a broken
  link. Reclamation is a normal outcome here (§4, and Q2's `filesKept` note), so
  a consumer needs to tell _gone_ from _failed_.
- **A delta mock's amended base is found by its `sourcePath`** through these same
  doors — the field `DesignAsset` already carries for provenance.

#### Q7 — the RUN-TIME design gate: a `done` blocker only lets the run START

A card's `done` blockers say the design card is finished. They do not say a
design exists, and they do not say it draws what this card must build.

**So the run looks.** When a design the card waits on resolves to **no design**
(Q2), or the approved design does not draw an **element** the card must build —
an unspecified ELEMENT, not an unspecified detail; `run.md`'s two senses are
unchanged — the run **stops through the dispatched prompt's THE CARD IS WRONG
branch**.

**The correction is a PROPOSED new `type: design` card, placed BESIDE the card**
(the same parent, never a child of it) and `relates_to` **the old design card,
which stays `done`**. The old card is the record of what was decided; it is not
reopened to make room for a second decision. **Only a `bug` is ever created
directly** — everything else is a proposal a person approves.

#### Q8 — what this supersedes, and which card sweeps each home

| superseded sentence                                                                          | where it lives                            | swept by                                |
| -------------------------------------------------------------------------------------------- | ----------------------------------------- | --------------------------------------- |
| _"the repository stays the source of truth"_                                                 | `motir-core/CLAUDE.md` § Design assets    | the dispatched-prompt card (MOTIR-5563) |
| the matching source-of-truth sentence in the `code` steps                                    | `lib/dispatch/promptTemplate.ts`          | the dispatched-prompt card (MOTIR-5563) |
| the design-reference rule's _"The FIRST step is to open the `design/` folder"_, and guard #3 | `motir-meta` `prompts/run.md`             | the runbook card (MOTIR-5564)           |
| the `motir-core/design/<area>/` source-of-truth row                                          | `motir-meta` `prompts/_shared.md`         | the runbook card (MOTIR-5564)           |
| the precondition ladder's design clause                                                      | `motir-meta` `prompts/plan-rules/`        | the runbook card (MOTIR-5564)           |
| `THE_DESIGN_GATE`'s asset clause                                                             | `motir-ai` `src/llm/planningRulePacks.ts` | the motir-ai card (MOTIR-5565)          |

**What this amendment does NOT re-decide:** §6c and its two amendments, and
AMENDMENT 4's contents rules (Q1's shape, Q2's publish-only-when-work-waits, the
two-file set, the delta mock, the note as a link). Q2 above answers the one
question §6c part 7 handed here; it changes nothing §6c decided.

### AMENDMENT 6 (MOTIR-5658, 2026-09-17): TWO gates and ONE approval — the design gate is the PRIMARY carrier, the merge gate re-opens ALONE, and a DECIDED design gate closes the design

**AMENDMENT 4 Q8 got the DECISION right and the CARRIER backwards.** The
one-approval ruling stands and nothing here reverses it. What changes is which
of the two questions is presented as the thing being decided.

**The pair that recorded the inverted carrier**, named so a reader can follow the
reasoning rather than only the outcome: [MOTIR-5533](motir:cmu1mcnok0008i0txvnf4j2n1)
specified Q8 and [MOTIR-5534](motir:cmu1mcnrr000ai0txplyb9iqz) shipped it. Neither
was careless — Q8 reasoned that asking twice about one change would be noise, which
is true, and concluded that the merge gate should therefore be the one asked, which
is the half that was backwards.

**The defect that forced this** is [MOTIR-5652](motir:cmu5dutva002dhwtxwxlbty76):
a design card with a published result AND an open linked pull request ended up
with **no approval gate of any kind** — CI green, card In Review, pull request
linked and `CLEAN`, design rendered on the page, and nothing for anyone to
press. Two independently-reasoned refusals produced it: Q8 suppressed the design
gate on the reasoning that the pull requests carry the decision, and
`raisePullRequestApprovalGate` then refused because the card's run target
resolved to an `ancestor`. Each was defensible alone; together they left a hole
neither author could see from their own card.

#### Q1 — TWO gates, ONE approval, the design gate PRIMARY

Yue's settling words, quoted in Q8 and unchanged in force: _"if there's linked
PR, the PR and the design should show together in one section, just like how to
test. **because they become one gate, approve the design will merge the PR
too.** reuse the development PR UI."_ That sentence says the design is what gets
approved and the merge is what follows. Q8 wrote it down the other way round.

A design card with a published result and at least one open linked pull request
holds **TWO gates**, because it has two questions and they have different
lifetimes:

| gate                          | the question             | lifetime                                                                 |
| ----------------------------- | ------------------------ | ------------------------------------------------------------------------ |
| `design_result` — **PRIMARY** | _is this design right?_  | **durable.** Once answered, nothing about a failed merge makes it untrue |
| the approve-to-merge gate     | _do these commits land?_ | **per attempt.** It can fail and be re-asked                             |

**The design gate is PRESENTED as the primary**, with the pull requests rendered
beneath it as what the approval will merge. **One press passes through both.**

**⚠️ AND "ONE GATE PER CARD" IS NOT WHAT [MOTIR-5603](motir:cmu396zoh005ihwtxd5xpny37)
SETTLED.** That defect was two _merge_ gates on one card — a per-pull-request
`pull_request_merge` beside the per-card `pull_request_approval` — and its
invariant is **ONE MERGE GATE PER CARD**, not one gate in total. **The rule is
one gate per QUESTION.** Reading it as one-gate-per-card is what made Q8's
suppression look obligatory, and the next reader will re-derive it unless this
paragraph is here.

#### Q2 — the merge gate has its OWN lifecycle and re-opens ALONE

After the approval the merge can still fail: a merge-queue ejection, a conflict,
a failed validation. When it does, **the merge gate re-opens for that card and
the design gate stays DECIDED.** Nobody is asked a second time whether the design
is right, because nothing about the design changed.

This is [MOTIR-5461](motir:cmu1aiteu00behyoic0vnik35)'s _Queue again_ keyed to
the merge gate rather than to a single card-level approval: the design decision
is what is REUSED, and the merge question is what is RE-ASKED.

> ⚠️ **AND THAT SENTENCE IS THE MECHANISM, not an illustration of one — recorded
> when this was built (MOTIR-5666).** _Re-opens_ does NOT mean a fresh `awaiting`
> merge gate appears. §4's THIRD AMENDMENT decision 6 already holds an ejected
> card at `implemented` with **no awaiting gate**, deliberately, so that a green
> check at the same head cannot re-ask about commits somebody has approved; a gate
> raised on ejection would be that same second ask arriving from another
> direction, and it contradicts MOTIR-5632 as squarely as it contradicts decision 6. The merge question comes back through the two doors that already exist —
> **Queue again**, which reuses the decision while the head is unchanged, and a
> **PUSH**, whose new head supersedes the gate with `head_moved` and whose next
> green raises a fresh one.
>
> What this Q owns, and what is asserted, is the other half: **none of those
> touches the DESIGN gate.** An ejection, a merge refusal and a push each leave it
> exactly as decided, and Q3's refusal stops the design being swapped underneath
> it in the meantime.

**So a failure after approval can only be about the COMMITS** — which is only
true because of Q3.

#### Q3 — a DECIDED design gate CLOSES the design, and this closes AMENDMENT 5 Q2's window

**Once the card's `design_result` gate is APPROVED over its current result, and a
pull request is open to merge it, publish, upload and withdraw are refused on
that card while it stands on that approval — `done` or not.**

Three conditions, and each one is doing work:

1. **APPROVED, not merely decided** — correction 1 below.
2. **Over the card's CURRENT result** — an approval of v1 closes nothing on a
   card whose current result is already v2, and an AWAITING gate closes nothing
   at all.
3. **With an OPEN delivery, at or above `implemented`** — a merge is what would
   ship the unapproved version, so an open pull request is what makes this a
   window; and the rung is the door back (correction 2 below). With nothing open
   there is nothing to ship, and §6d's approve → reopen → republish → approve
   cycle is untouched.

> ⚠️ **CORRECTION 3 — the rung is `implemented`, not `in_review` (MOTIR-5666).**
> It was written as the review band, and a merge-queue ejection moves every card
> it delivers to `implemented` (§4's THIRD AMENDMENT) — one rung BELOW it. So the
> ordinary shape this refusal exists for, _the queue ejects the pull request and
> an agent comes back and re-publishes the asset_, was the one shape it let
> through. `implemented` is the rung that claims the branch is pushed and the pull
> request is open: from there up the card is OFFERING commits, and below it the
> work is being reworked, which is exactly when a design may legitimately change.
> Found by building Q2's card, not by re-reading this one.

> ⚠️ **CORRECTED WHEN IT WAS BUILT — MOTIR-5661, 2026-09-17.** This Q was written
> as _"once the gate is DECIDED … WHATEVER its status"_, and both halves were
> wrong in ways the build found. The corrections are below, at the two paragraphs
> they belong to, and the rule above is what ships.

An agent returning to a failed pull request therefore **cannot re-add or
re-publish the design asset**. That is what makes Q2's sentence true rather than
merely intended: the remaining work is the commits.

**The window this closes is one this record already named and deliberately left
open.** [MOTIR-5552](motir:cmu1wgavk008dhvoijhh3wa5i) makes a design final by
testing the card's STATUS (`done`), and under Q1 an approved design card is **not
yet `done`** — the merge writes `done`. AMENDMENT 5 Q2 states the gap in its own
words: _"the approval named X, a publish makes Y current, the merge writes
`done`, and the current result of a `done` design card is Y, **a version nobody
approved**."_ **Move the test from the STATUS to the APPROVED GATE.** MOTIR-5552's
refusals and their way-forward copy stay; only what they key on changes.

> ⚠️ **CORRECTION 1 — `approved`, not `decided`.** `changes_requested` is a
> decision too, and it is the one whose entire purpose is to ASK FOR A NEW
> VERSION. Keying the refusal on _decided_ would refuse the republish the verb
> exists to request, breaking the review loop instead of closing a window. Only
> an APPROVAL settles a design.

**The door back is a person, deliberately.** Reopening the card by hand — the
ordinary pull-back out of the review band — lets a fresh version be published and
re-approved. That is why condition 3 reads the band: it is exactly what a person
leaves when they re-open the card.

> ⚠️ **CORRECTION 2 — the re-open does NOT touch the approved gate, and the
> original sentence could not have been built.** This Q said reopening
> _"withdraws the decided design gate — recording the cause `reopened_by_hand`"_.
> A decided gate cannot be updated at all: `trg_approval_gate_decided_immutable`
> (MOTIR-4912) refuses every UPDATE of a row at `approved` or
> `changes_requested` except the two user FKs going NULL, and that guard is the
> audit's integrity, not an obstacle to route around. **Measured, not reasoned**:
> the update raises `AG_DECIDED_IMMUTABLE` (`ERRCODE 23514`).
>
> So the re-open is the pull-back the product already has. It costs nothing new
> and it is stronger than the original: the SAME move withdraws every awaiting
> question on the card with the cause `pulled_back`, so the merge gate cannot
> carry an unapproved design to `done` behind the re-open. The approved gate
> stays approved — it is the record of what somebody agreed to, and AMENDMENT 5
> Q2 arm (a) goes on reading it until a second approval lands.
>
> **`reopened_by_hand` is REMOVED from Q5's vocabulary.** It was minted for the
> mechanism this correction retires, and a value nothing writes is the shape Q5
> set out to avoid — the same reason no `pull_request_linked` member was minted.
> Neither the enum nor its migration had left this branch when it was removed.

This does not contradict §6c's _an answer outlives its subject_: that rule is
about a decided gate surviving its subject being superseded underneath it, and
here nothing supersedes it at all.

**An AWAITING design gate is untouched by this Q.** A republish while the
decision is still open supersedes and refuses exactly as §6b and Q8 point 3
describe — that is the case AMENDMENT 5 Q2's arm (a) was written for.

#### Q4 — approving BEFORE the delivery set is green: the merge is HELD, the press is not refused

The design gate rises on PUBLISH and the merge gate on GREEN, so the primary can
be pressed before CI has spoken. Two arms were available and this record settles
the first:

**HOLD THE MERGE UNTIL GREEN.** The press records the design decision
immediately. If the set is green at press time the merge fires at once, exactly
as Q1 describes. If it is not, **the decision stands and the merge follows on the
next green verdict, with no second press.**

**Why not refuse the press.** A design question does not depend on CI: the mock
is either right or it is not, and a reviewer who has read it has everything they
need. Telling them _you may not answer this yet_ leaves a card with a question on
it that cannot be answered — which is the silent stall MOTIR-5652 was filed
about, arriving through a door we built on purpose.

**What the surface shows in that window:** the design decided, and the merge
waiting on checks. Not a second question.

**`done` still has exactly ONE writer.** The merge writes it, before and after
this amendment (§8's invariant, untouched).

#### Q5 — §6b's supersede gains a CAUSE

§6b makes a supersede write `state` and **nothing else**, which is why no surface
can say a true sentence about a withdrawn gate.
[MOTIR-5586](motir:cmu30qjra00g6hvoiiu6ljuhv) and
[MOTIR-5651](motir:cmu5aympl0020hvoik1mfccrg) are the same false sentence on two
surfaces — _a newer design was published, the current version is above_ — true
for one of the ways a gate is superseded and false for the rest. Both were fixed
by making the sentence vaguer, which is the only repair available while the row
is silent.

**A supersede now records WHY, from a closed vocabulary with one value per
writing path and no value meaning _unsaid_:**

| cause            | written when                                                       |
| ---------------- | ------------------------------------------------------------------ |
| `republished`    | a newer design version superseded the one the gate asked about     |
| `withdrawn`      | the design result was withdrawn                                    |
| `head_moved`     | a member's head moved, so the commits are not the ones asked about |
| `member_closed`  | a member pull request closed                                       |
| `member_drafted` | a member pull request was converted back to a draft (MOTIR-5699)   |
| `set_changed`    | a delivery row joined or left the card                             |
| `pulled_back`    | the work was pulled out of review, or moved to Cancelled           |

**No cause is minted for the pull-request-LINK path** — the one that retires a
design gate when an open pull request is linked (AMENDMENT 4 Q8). Q7 retires that
path outright, so a member for it would enter the vocabulary with nothing left to
write it. Until the path is deleted its single write records `set_changed`, which
is what a delivery row joining the card literally is.

**Rows superseded before this amendment carry an UNKNOWN value**, and a surface
must render it as _the reason was not recorded_ — never as one of the real
causes. Reconstructing a cause from a row's shape manufactures evidence, and
these sentences are shown to a person as fact.

**It remains a product write with no actor, no authority and no note.** Adding a
cause does not make a withdrawn question readable as a human decision, which is
§6b's whole point.

#### Q6 — AMENDMENT 5 Q2's arm (b) RETIRES

AMENDMENT 5 Q2 resolves the approved design of a card as _(a) the subject of the
most recent decided `approved` `design_result` gate, else (b) the newest pinned
row, else (c) the current row_. **Arm (b) exists only for Q8's no-gate path** —
its own justification says so: _"a card with an open delivering pull request
raises no `design_result` gate … so there is no gate to read."_

Under Q1 such a card raises a design gate again, so every approval on it leaves
arm (a)'s evidence. **The ladder becomes gate → current**, and the `pinnedAt`
write stays exactly as it is: §6c's retention reads it, and this amendment
retires a READER of that column rather than the column.

#### Q7 — what this SUPERSEDES, and what does NOT change

**SUPERSEDED:**

- **AMENDMENT 4 Q8 point 1** (_"Its design result raises **no** `design_result`
  gate"_) — reversed by Q1. A publish raises the gate whether or not a pull
  request is open.
- **AMENDMENT 4 Q8 point 3's LINK arm** (_"linking a pull request … supersedes
  that gate"_) — retired by Q1. A link is evidence the design gate is ABOUT, not
  an answer to it. `retireDesignGateForOpenPullRequest` and its call sites go,
  and the `pull_request_linked` cause in Q5 is listed only so a reader meeting it
  on an old row knows what it meant.
- **AMENDMENT 5 Q2 arm (b)** — retired by Q6.
- **`approval-gates.md` §1's keying** of `design_result` to _a design with no
  pull request_, and the reading of §8's Workflow B that follows from it. Amended
  there, in this same change.

**NOT changed:** Q8 point 2's RENDERING — the result still renders inside the
Development block, once, with How to test and every pull-request row, as ONE
section and ONE frame. What moves is which gate that frame is a port for. Also
unchanged: Q1–Q7 of AMENDMENT 4 in full, AMENDMENT 5 Q1 and Q3–Q8, §6c's pin,
§6b's no-actor rule, and MOTIR-5603's real invariant — **at most one MERGE gate
per card**.

### 7. Relationship to the runtime design-approval gate (Story MOTIR-693 / 9.2)

**This record ships the ARTIFACT, not the GATE.**

> **⚠️ AMENDED (MOTIR-4786, 2026-09-08) — THE DECISION HALF NO LONGER POINTS
> HERE AT 9.2. Read `approval-gates.md`.** The paragraph below said 9.2 keeps
> the human-in-the-loop semantics "in full", and that is no longer true: the
> **DECISION, its record and its status effect** moved to Epic MOTIR-4878, whose
> authority is **`docs/decisions/approval-gates.md`**. What 9.2 keeps is listed
> in that record's §5 — the ephemeral hosted preview and its teardown, the
> **revise-chat re-dispatch**, `Project.designApprovalGate`, and the HOLD it
> applies to the `motir auto` loop.
>
> **Why it moved:** 9.2 is `blocked_by` MOTIR-683, hosted agent execution — so
> leaving design approval there meant nobody could approve a design until an
> entire epic landed, while the artefact it would approve has been shipping to
> cards since MOTIR-2664.
>
> **Two clauses of `approval-gates.md` bear directly on THIS record** and are
> named here so a reader of §4 finds them: its **§6c** amends §4's
> supersede/retention — an APPROVED `DesignEvidence` row's attachments are
> PINNED and must NOT be unlinked on supersede, because the orphan-GC would
> otherwise reclaim the very bytes an approval was given on (the same failure
> `acceptance-receipt-lifecycle.md` records as MOTIR-2764). Its **§6b** adds a
> product-written `superseded` gate state, so a gate whose subject this record's
> supersede path retires is retired with it.
>
> **⚠️ POINTER UPDATED (MOTIR-4911, 2026-09-08) — §6c's TRIGGER is not what this
> paragraph was originally told.** `approval-gates.md` §6c has been re-keyed onto
> the **SUBJECT**: the pin fires **when a WORK ITEM carrying a current design
> result is approved, whichever GATE KIND carried the decision** — not when a
> `design_result` gate is approved. A design with a pull request is approved
> through `pull_request_approval`, so keying the predicate on the gate kind would
> have stopped pinning for the common case with no error and no red test. **So
> §4's supersede path must test _"does an approved gate on this work item
> reference this `DesignEvidence` version?"_ and must NOT read the gate's
> `kind`.** Read `approval-gates.md` §6c's own amendment for the full statement.

> **⚠️ SHIPPED (MOTIR-4913, 2026-09-10), and the pointer above is CORRECTED in
> one clause.** §4's supersede path now tests **`pinned_at` on the
> `DesignEvidence` row**, not _"does an approved gate on this work item reference
> this version?"_ — a `pull_request_approval` gate's `subject_id` is a PULL
> REQUEST, so a gate-side join can only ever find a `design_result` gate, which is
> the kind-keying MOTIR-4911's amendment exists to remove. The decide door writes
> the marker at DECISION time, when the product still knows which version was
> current, and the supersede path reads it. Everything else the paragraph above
> says is unchanged and is what shipped: the pin is keyed on the subject, it does
> not read the gate's kind, and it PINS rather than FREEZES — §4's supersede still
> proceeds, it simply stops unlinking an approved row's attachments. §6b's
> `superseded` state is written by §4's own supersede path, so a gate whose
> subject it retires is retired with it. `approval-gates.md` §6b / §6c carry the
> shipped notes.

> **⚠️ AMENDED (MOTIR-5554, 2026-09-15) — A DONE DESIGN CARD IS CLOSED, and §4's
> _"A DESIGN RESULT IS NEVER FROZEN"_ no longer holds for one.** A publish (inline
> or by pathnames), an upload-grant mint and a withdrawal on a design card whose
> status is in the `done` category — `cancelled` included — are refused with
> `DESIGN_CARD_CLOSED` (409), whose message names the two ways forward: reopen the
> card by hand, or propose a new design card beside the one that needs it. The
> check reads the CARD's status, never a gate, so a design approved through its
> pull request is closed the same way. Every card that is not `done` — and so the
> whole revise loop — supersedes exactly as §4 says. _PIN, do not FREEZE_ is
> replaced by _a design evolves after approval only once a person reopens its
> card_. Read `approval-gates.md` §6c's second amendment for the four acts, the
> race and its lock order.

~~Story 9.2 keeps the runtime human-in-the-loop semantics in full: the "for
review" state, HOLDING the `depends_on` dependents, the revise-chat re-dispatch,
Approve, and the per-project toggle.~~ **Superseded by the amendment above** —
kept struck rather than deleted, because a reader arriving from an old citation
needs to land on where the decision went rather than on nothing.

**What 9.2 no longer needs is somewhere to point an iframe.** Its planned
mechanism — deploy the `*.mock.html` (+ rendered notes) to an **ephemeral,
paid preview host**, hold it for the review, then guarantee teardown on approval
/ timeout / revision — existed only to give the review surface a URL. A design
result published as a durable attachment supplies that with no host, no deploy /
undeploy lifecycle, and no teardown timeout. **9.2's approval surface should
COMPOSE the `Design result` panel and add the gate controls around it.**

Retiring 9.2's preview-host cards (MOTIR-696 provisioning, MOTIR-699 lifecycle)
is a re-plan of that story and is **not performed by this record**; the
supersession is recorded on those cards.

---

## Consequences

**Good**

- A whole artifact class arrives for roughly the cost of one feature: the model,
  the publish endpoints, the CI auth, the private store and the authenticated
  read are all reused rather than rebuilt.
- **No planner rule changes.** The publisher is diff-driven, so a design card
  keeps producing exactly what it produces today and gets published anyway.
- No new PR check on any repository; the always-on job that already reads
  `design/**` grows one step.
- Epic 9 loses a paid preview host, a provisioning card, a deploy/undeploy
  lifecycle and a durable teardown timeout from its critical path.

**Costs / risks accepted**

- **A mock that needs JavaScript renders inert** in the panel (§5c). Accepted:
  design mockups are static, and the `.png` and open-in-new-tab are the escapes.
- **The note is a heuristic, not a declaration.** A design card that edits two
  unrelated sections publishes both. Accepted: over-inclusion is legible, whereas
  a marker convention fails silently when an author forgets it.
- **A design card whose branch/PR carries no `MOTIR-<n>` publishes nothing.**
  Accepted deliberately (§6) — silence beats mis-attribution — and visible in the
  job log.
- **The product now stores HTML.** Bounded by §5's three layers, the design-only
  publish path, and tests that assert the asymmetry in both directions.
- **`design_asset` rows are excluded from the attachments panel**, like
  `acceptance_video` / `acceptance_trace`, so a design result is not also a loose
  file list on the same page.
