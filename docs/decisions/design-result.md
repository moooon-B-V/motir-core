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

| Fact                                                                                                                                                                                                             | Where                                                                                                                  |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Generic upload allowlist — images + docs; **no HTML, no video** (415 otherwise)                                                                                                                                  | `lib/blob/allowlist.ts` (`ALLOWED_UPLOAD_TYPES`)                                                                       |
| A **path-scoped** allowlist already exists as a pattern, deliberately kept OUT of the generic one                                                                                                                | `lib/blob/allowlist.ts` (`ALLOWED_ACCEPTANCE_VIDEO_TYPES`, `isAllowedAcceptanceVideoType`)                             |
| `AttachmentSource` = `editor` · `panel` · `acceptance_video` · `acceptance_trace`; the panel listing EXCLUDES the lifecycle-owned sources                                                                        | `prisma/schema.prisma` (`enum AttachmentSource`)                                                                       |
| One-current-per-subject enforced by a **partial unique index**, not by the service                                                                                                                               | `prisma/migrations/20260705222141_add_acceptance_evidence/migration.sql` (`acceptance_evidence_one_current_per_story`) |
| RLS shape for a lifecycle table: **pure active-workspace gate**, `ENABLE` + `FORCE`, **no `app.system_admin` hatch**                                                                                             | same migration                                                                                                         |
| Attachment FKs are `SetNull` so the orphan-GC can reclaim a blob without vaporising the history row                                                                                                              | same migration; `lib/jobs/definitions/attachmentGc.ts`                                                                 |
| Presigned **PUT** binds the content type INTO the signature (`signableHeaders`); it can carry **no size ceiling**                                                                                                | `lib/blob/uploader.ts` (`mintPrivateUploadToken`)                                                                      |
| The register step therefore re-reads the object's **authoritative** size/type                                                                                                                                    | `lib/blob/uploader.ts` (`headPrivateBlob`)                                                                             |
| Presigned **GET**, 300 s; `ResponseContentDisposition` is set **only** when `download: true` — otherwise the object is served inline with its stored content type                                                | `lib/blob/uploader.ts` (`signedDownloadUrl`)                                                                           |
| The authenticated content read **302-redirects** to that presigned URL, so bytes are fetched from the **object-store host**, not `app.motir.co`                                                                  | `app/api/attachments/[id]/content/route.ts`                                                                            |
| Keyless CI publish: GitHub Actions **OIDC** → repo → `GithubInstallation.workspaceId` → the workspace **owner** as uploader; `integration` PAT as fallback                                                       | `lib/acceptanceEvidence/publishAuth.ts`; `acceptance-video.md` §4 amendment                                            |
| The acceptance publish resolves a subtask key **UP to its parent story** and refuses a non-`story` target                                                                                                        | `lib/services/acceptanceEvidenceService.ts` (`resolveStory`)                                                           |
| …and asserts `work_item:edit` on the **target's** project, not the actor's active project                                                                                                                        | same (`resolveStory`, MOTIR-2365)                                                                                      |
| Cost bounds already enforced on every publish                                                                                                                                                                    | `entitlementsService.resolvePerFileLimitBytes`, `assertWithinStorageCap`                                               |
| `ci.yml` has a **`design-guards` job that runs on every PR** and exists to read `design/**`; `permissions: contents: read`                                                                                       | `.github/workflows/ci.yml` (`design-guards` → `pnpm vitest run --config vitest.design.config.ts`)                      |
| `ci.yml` triggers on **`pull_request` AND `push: branches: [main]`**                                                                                                                                             | `.github/workflows/ci.yml` (`on:`)                                                                                     |
| The lane arrangement is guarded by a test, not by review                                                                                                                                                         | `tests/ci-design-guards-lane.test.ts`                                                                                  |
| The acceptance lane **never republishes post-merge** — since MOTIR-2760 by gating its publish step on `pull_request` rather than by having no `push:` trigger — and runs **no `continue-on-error`** on that step | `.github/workflows/acceptance-video.yml` (MOTIR-1937/1949; MOTIR-2499; MOTIR-2760)                                     |
| Target-card resolution from the branch ref / PR title                                                                                                                                                            | `scripts/upload-acceptance-video.mjs` (`resolveStoryKey`, `parseWorkItemKey`)                                          |
| Markdown has ONE render path, used by both content axes                                                                                                                                                          | `lib/markdown/render.tsx`                                                                                              |

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

| Pattern                         | Asset kind | Published as                          |
| ------------------------------- | ---------- | ------------------------------------- |
| `*.mock.html`                   | `mock`     | the file, whole                       |
| `*.png`                         | `image`    | the file, whole                       |
| `design-notes.md`               | `note`     | **only the changed SECTIONS** (below) |
| anything else under `design/**` | —          | **not published** (ignored, logged)   |

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

| Knob                         | Value                                                                                                                                                                                                                                                                                                                                                                                                           |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Host**                     | A step in `ci.yml`'s **existing `design-guards` job** — NOT a new workflow. That job already runs on every PR and already exists to read `design/**`.                                                                                                                                                                                                                                                           |
| **Why not a new workflow**   | A new workflow means a **new check on every PR that touches design**. The acceptance lane needed its own file because it had no always-on host job and a job-level `if:` still reports a skipped check (MOTIR-1949 / MOTIR-1958). Here a host job already exists, so the cheaper arrangement is also the correct one: **no new check appears anywhere.**                                                        |
| **Event**                    | **`pull_request` only** — `if: github.event_name == 'pull_request'`. `ci.yml` also runs on `push: main`; republishing an identical result after merge is the behaviour `acceptance-video.yml` deliberately avoids as well. Same decision, and since MOTIR-2760 reached the same way: that lane now has a `push: main` baseline too, and gates its own publish step on `github.event_name == 'pull_request'`.    |
| **Permissions**              | The job gains **`id-token: write`** alongside `contents: read`.                                                                                                                                                                                                                                                                                                                                                 |
| **Auth**                     | **Keyless GitHub Actions OIDC first** (repo → `GithubInstallation.workspaceId` → workspace owner as uploader), the `integration`-scoped API token as the documented fallback for repos not connected via the App. Nothing to mint or store.                                                                                                                                                                     |
| **No credential**            | The script logs that publishing is opt-in and **exits 0** — a fork PR gets neither OIDC nor the secret, and must not fail the build.                                                                                                                                                                                                                                                                            |
| **Unresolvable target card** | Log the would-be publish set and **exit 0 without publishing.** **No fallback constant.** The acceptance uploader falls back to its dogfood story, which is right for a receipt better attached somewhere than nowhere; a design attached to the **wrong** card is worse than one attached to none — it makes another card look designed when it is not, and the design gate that reads it would pass on a lie. |
| **`continue-on-error`**      | **Forbidden on this step.** MOTIR-2499 removed it from the acceptance publish after it rewrote a failing step's conclusion to `success` for days while two stories silently lost their receipts. Both cases that justified it are handled inside the script (above), so the only remaining meaning of red is _a publish that should have happened did not_. Guarded by `tests/ci-design-guards-lane.test.ts`.   |

### 6a. A CONTAINER-RUN branch is skipped, and a server refusal stays fatal (MOTIR-3105)

Three decisions in this document and its neighbours are individually right and
collectively guarantee a failure:

|                                                                     |                                                                        |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `motir run <parent>` names its branch `parent/MOTIR-<story>-<slug>` | so the status sync links the PR to the card being completed (`run.md`) |
| `resolveTargetKey` prefers the branch ref over the PR title         | the branch is the more reliable signal (§6)                            |
| the service refuses a non-leaf — `DESIGN_EVIDENCE_NOT_A_LEAF`       | §3: a story has MANY designs, one per design subtask                   |

So **every parent-run PR carrying a `design/**` change fails this job, and cannot
succeed however the change got there.\*\* Observed on PR #2145.

**DECIDED: skip on the branch REF, before the request; keep the server's refusal
FATAL.** The uploader recognises the container-run prefixes (`parent/`, and the
pre-2026-08-04 `story/`), logs what it would have published and where the design
belongs instead, and exits 0.

**Why the ref and not the 422.** Treating the refusal as a skip would also
swallow a `design/*` branch that genuinely targets the wrong card — and that is
exactly the class §6's `continue-on-error` prohibition exists to keep visible.
Red here must go on meaning _a publish that should have happened did not_. The
ref is knowable before the request, so the impossible case costs nothing and the
real one keeps its teeth.

**Two alternatives rejected.** _Skip unless the branch is `design/_`* is narrower
than the problem and would silently stop publishing from any other branch that
legitimately carries an asset. *Derive the leaf from the changed paths* is the
precise answer and needs a `design/<area>/<surface>` → design-subtask mapping the
repository does not keep; it is not ruled out, it is unbuilt.

**This is not a licence to put design assets on a parent branch.** The parent
flow already routes a `design` child to its own `design/MOTIR-<n>-<slug>` branch
and its own PR (`run.md` step 5a), and step 6 says the parent→main PR contains
only the code/test child commits. An asset reaching a parent branch is a
mis-placed commit; the skip's log line says so.

### 7. Relationship to the runtime design-approval gate (Story MOTIR-693 / 9.2)

**This record ships the ARTIFACT, not the GATE.** Story 9.2 keeps the runtime
human-in-the-loop semantics in full: the "for review" state, HOLDING the
`depends_on` dependents, the revise-chat re-dispatch, Approve, and the
per-project toggle.

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
