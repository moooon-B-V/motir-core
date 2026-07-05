# ADR: Story-acceptance video — entitlement axis, storage/retention, org toggle, CI-upload auth

- **Status:** Accepted (2026-07-05, drafted for Story MOTIR-1627 per the
  decision-subtask ladder). This is the rung-1 policy the rest of MOTIR-1627
  implements — no acceptance-video code ships until these four decisions are
  pinned. **No application behaviour ships in this subtask** (the ADR only).
- **Story / Subtask:** MOTIR-1627 (Story acceptance gate — E2E acceptance video,
  review & approve, BYOK, motir-ai-plan-gated) · Subtask MOTIR-1628.
- **Consumed by:** MOTIR-1629 (data model + video allowlist), MOTIR-1630
  (eligibility — org toggle + AI-plan gate), MOTIR-1631 (publish endpoint),
  MOTIR-1632 (Playwright recording + CI uploader), MOTIR-1633 (design),
  MOTIR-1634/1635/1636 (panel / org card / board badge), MOTIR-1637/1638 (tests).
- **Builds on:** `billing-tiering.md` (the two entitlement axes + the
  2026-06-24 amendment that bundles the `scaled` tier into every paid AI plan),
  `organization-tier.md` (`Organization` = billing entity, org-scoped),
  and the shipped attachment/blob pipeline (`attachmentsService`, `lib/blob/*`).
- **Supersedes / superseded by:** none.

> Convention (set by `work-item-type-taxonomy.md`, followed by
> `billing-tiering.md` / `organization-tier.md`): a decision record is a markdown
> file under `docs/decisions/`, structured **Status → Context → Decision →
> Consequences**, with the load-bearing facts pinned in explicit tables so
> downstream code has one authoritative source to implement against.

---

## Context

MOTIR-1627 closes the BYOK dispatch→review loop with a **human acceptance gate at
the story level**: a story's E2E, on a green run, records a short **video**; the
video is attached to the story as _acceptance evidence_; a reviewer watches it in
an in-app player and **Approves** (`in_review → done`) or **Requests changes**.
"Verification" (the mandatory E2E + integration tests) proves correctness and
gates the merge; "acceptance" is the human judging _"is this what I wanted"_ from
the E2E's own **video receipt** rather than re-driving the app by hand.

Storing video is the only new **cost** this feature introduces, so it must be
gated. Four load-bearing choices decide _who can generate video, how much it may
cost, where the switch lives, and how CI is authorised to upload it_. Each is
grounded in shipped billing/attachment reality, not re-invented.

### Shipped substrate this reconciles against (verified 2026-07-05)

| Fact                                                                                                                                       | Where                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| Two entitlement axes: **Axis A** = paid AI plan (`getAiAccess(...).hasPaidAiPlan`); **Axis B** = the `scaled` tier that lifts storage caps | `docs/decisions/billing-tiering.md`; `lib/services/billingService.ts:192,221` |
| **Every paid AI plan bundles the `scaled` tier** (1 tracker seat included → caps lifted) — Axis A ⟹ Axis B                                 | `billing-tiering.md` amendment 2026-06-24 (8.1.22 / MOTIR-1316)               |
| `getAiAccess` returns `applicable:false` off-cloud (`!isCloudBilling()`) **and** for the meta org (`org.isMeta`)                           | `lib/services/billingService.ts:193,214`                                      |
| Per-file upload limit: `free` 10 MB → `scaled` 100 MB (off-cloud = 10 MB baseline)                                                         | `entitlementsService.resolvePerFileLimitBytes` (`:145`)                       |
| Total-storage cap: `free` 2 GB → `scaled` 100 GB; no-op off-cloud; sums `Attachment.sizeBytes`                                             | `entitlementsService.assertWithinStorageCap` (`:156`)                         |
| Generic upload allowlist (no video today)                                                                                                  | `lib/blob/allowlist.ts` (`ALLOWED_UPLOAD_TYPES`, 415 otherwise)               |
| Orphan-GC storage backstop — blob-first sweep, 7-day safety window, system context                                                         | `attachmentsService` `ORPHAN_SAFETY_WINDOW_MS` (`:97`), sweep (`:503`)        |
| Org admin write-authority helper (mirror `renameOrganization`)                                                                             | `organizationsService.assertOrgAdmin` (`:623`)                                |
| External-agent write auth: the `integration` API-token scope                                                                               | `lib/mcp/scopes.ts:34` (`apiTokensService.verify`)                            |

---

## Decision

### 1. Entitlement axis — the "motir-ai plan" gate (reconciling the two axes)

The user's intent — _"only a motir-ai plan can generate video, because it gives
storage"_ — conflates Axis A (the AI plan) and Axis B (the storage-cap tier).
Under the 2026-06-24 billing amendment these are no longer independent for paid
orgs: **every paid AI plan bundles the `scaled` tier**, so `hasPaidAiPlan`
(Axis A) _implies_ the lifted 100 MB / 100 GB storage headroom (Axis B). That
makes the intent coherent — gate on the AI plan and the storage that makes video
affordable comes with it — while keeping the cost bound explicit.

**Decision (pinned):**

| Check                                                             | Axis | Rule                                                                                                                                                                                                                                                                       |
| ----------------------------------------------------------------- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Feature **eligibility** (may this org generate video?)            | A    | `getAiAccess(...).hasPaidAiPlan === true` **AND** the org toggle (decision 3) is ON                                                                                                                                                                                        |
| Per-upload **cost bound** (enforced on every publish, regardless) | B    | `entitlementsService.resolvePerFileLimitBytes(orgId)` (per-file) **AND** `assertWithinStorageCap(orgId, bytes)` (total)                                                                                                                                                    |
| **Off-cloud / self-host / meta org**                              | —    | `getAiAccess` → `applicable:false`: **UNGATED → eligible=true** (no AI plan to buy, no storage to meter; the panel shows the player directly, no upsell). This is what lets a self-hoster use the feature AND the moooon META org publish its own self-test dogfood video. |

So the AI plan **gates the feature** and the storage cap **still bounds the
cost** — the cap is defence-in-depth (a paid org is `scaled`, so 100 MB/file is
the ceiling; the ≤ few-MB clip target in decision 2 sits far under it, but the
cap is still asserted so a misconfigured recording can never blow the budget).
Eligibility is computed once (a single `acceptanceVideoEligibilityService`,
MOTIR-1630) so the panel, the publish endpoint, and the org toggle all agree.

### 2. Storage / retention (cost control)

| Knob                 | Value                                                                                                                                     | Enforced by                                                                         |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| **Duration cap**     | ≤ 60 s (the acceptance E2E is a focused happy-path drive, not a full suite)                                                               | Playwright config (MOTIR-1632) — the recorded spec is scoped to the acceptance flow |
| **Resolution cap**   | 1280×720 (720p), `video: { mode: 'on', size: { width: 1280, height: 720 } }`                                                              | Playwright `use.video`                                                              |
| **Target size**      | a few MB; **hard ceiling = the org's per-file limit** (100 MB `scaled`)                                                                   | `resolvePerFileLimitBytes` at publish; publish rejects (413) over it                |
| **Format**           | `video/webm` (Playwright's native output) primary; `video/mp4` also allowlisted                                                           | allowlist (MOTIR-1629)                                                              |
| **Retention**        | **keep the latest evidence per story**; a new green run **supersedes** the prior current (history rows retained, only one marked current) | `acceptanceEvidenceService` supersede-on-create (MOTIR-1629)                        |
| **Superseded blobs** | become orphaned Attachments → reclaimed by the existing **orphan-GC** sweep (blob-first, 7-day window)                                    | `attachmentsService` orphan GC — no new GC path                                     |
| **Plan lapse**       | **keep existing videos read-only + stop generating new** (do NOT prune paid-for evidence on downgrade)                                    | eligibility gate blocks new publishes; existing rows/blobs untouched                |

**Retention rationale (industry mirror):** CI systems bound video/artifact cost
by _recency + short retention windows_, not by keeping every run — GitHub Actions
artifacts default to a 90-day window and are the last-run receipt, and Playwright
itself defaults to `video: 'retain-on-failure'` (keep only what you need). We
keep exactly **one** current acceptance receipt per story and let the existing
orphan-GC reclaim the superseded blobs, so per-story storage is O(1), not O(runs).
Plan-lapse keeps evidence read-only because the video is a _record of an accepted
story_, not an ongoing service — pruning it would destroy audit history the org
already paid to produce.

### 3. Org-level scope + default

The switch is an org-wide **Boolean column on `Organization`** (mirrors
`aiIncludedSeat` / the existing org flags), set through `organizationsService`
behind `assertOrgAdmin` + `PATCH /api/organizations/[orgId]`, surfaced on
`app/(authed)/settings/organization` as an `OrgGeneralCard` sibling.

| Choice          | Decision                                                                                                                                                                                                           |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Column          | `Organization.acceptanceVideoEnabled Boolean`                                                                                                                                                                      |
| **Default**     | **`true`** (ON) for every org — an eligible (paid) org opted into the cost by paying; a non-eligible org's toggle is moot (the entitlement gate blocks generation regardless), so a default of ON never leaks cost |
| Write authority | org admin only (`assertOrgAdmin`), same as rename                                                                                                                                                                  |
| Non-plan orgs   | the toggle has no effect (eligibility=false); the panel upsells instead                                                                                                                                            |

Default ON (not OFF) because the feature is the story's whole point and the cost
is already bounded by decisions 1–2; forcing every paid org to hunt for a switch
before their first acceptance video is friction with no cost upside.

### 4. CI upload auth (BYOK)

No artifact-upload endpoint exists. The BYOK model is: **the user's own CI** runs
the acceptance E2E and POSTs the video to a new motir-core publish endpoint.

**Decision: reuse an existing API token with the `integration` scope** as a CI
secret — **no new auth mechanism.**

- The `integration` scope already exists for "external-agent integration writes"
  (`lib/mcp/scopes.ts:34`), verified by `apiTokensService.verify`. Publishing an
  acceptance receipt from CI is exactly an external-agent integration write, so it
  belongs on that scope.
- The publish endpoint (MOTIR-1631) authenticates the token, resolves its
  workspace/actor, then applies the **same eligibility + cap checks** as any
  in-app path (the token is not a bypass — a token for a non-eligible org still
  gets 402/403).
- **Not** a brand-new service bearer: that would duplicate token issuance,
  rotation, and scoping for one endpoint. (Epic 9's _hosted_ runner uses its own
  service principal inside its sandbox — explicitly out of scope here.)

---

## Consequences

- **MOTIR-1629** adds `AcceptanceEvidence` (one current per story, supersede
  semantics), `AttachmentSource.acceptance_video`, and a **gated** video MIME
  allowlist (video accepted only on the acceptance path; the generic editor
  upload still 415s a video). `AcceptanceEvidence` is workspace-scoped →
  `workspaceId` column + RLS in the same migration; every FK modelled as a
  Prisma `@relation`.
- **MOTIR-1630** adds `Organization.acceptanceVideoEnabled` (default `true`) and a
  single `acceptanceVideoEligibilityService` encoding the decision-1 table
  (`hasPaidAiPlan && toggle`, `applicable:false` short-circuit); every acceptance
  membership/write path must consult it (the "new access gate → sweep all
  creators" rule).
- **MOTIR-1631** adds `POST` publish (integration-scope auth) that runs eligibility
  - `resolvePerFileLimitBytes` + `assertWithinStorageCap` before creating evidence,
    returning 402 (no plan) / 403 (toggle off / not admin-configured) / 413 (over
    per-file cap) as distinct signals the panel can render.
- **MOTIR-1632** pins the Playwright `use.video` size/duration budget and ships a
  reusable uploader the acceptance E2E (and the self-test dogfood run) call.
- **Retention** rides the existing orphan-GC — no new GC job. **Plan lapse** needs
  no pruning code (evidence is left read-only).
- **Self-host / meta** never see a gated surface (eligibility=false via
  `applicable:false`), so the feature is a clean no-op off-cloud.
- **Out of scope / hand-off:** Epic 9 owns the hosted video-delivery variant; the
  planner-rule change (teach every story's E2E to emit acceptance video —
  `plan-rules.md` + motir-ai `SHARED_PLANNING_RULES`) is a separate motir-meta/-ai
  follow-up tracked outside this motir-core story.
