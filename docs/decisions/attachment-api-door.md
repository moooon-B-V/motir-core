# ADR: The type-agnostic attachment door — which entrance, which shape, which `AttachmentSource`, and which door a design deliverable uses

- **Status:** Accepted (2026-08-19, drafted for Story MOTIR-3000 per the
  decision-subtask ladder). This is the rung-1 policy the rest of MOTIR-3000
  implements — no attachment-door code ships until these three decisions are
  pinned. **No application behaviour ships in this subtask** (the ADR only).
- **Story / Subtask:** MOTIR-3000 (An agent can put ANY deliverable on the card —
  a type-agnostic attachment door over the public API and MCP) · Subtask
  MOTIR-3055.
- **Consumed by:** MOTIR-3056 (the row + its source), MOTIR-3057 (the `/api/v1`
  route), MOTIR-3058 (the MCP tool), MOTIR-3059 (`WHAT_TO_DO.design`),
  MOTIR-3060 / MOTIR-3061 (tests), MOTIR-3062 (documentation).
- **Builds on:** `design-result.md` (the second pre-signed publisher, whose §5a
  allowlist posture this record preserves), `acceptance-video.md` (the first),
  `attachment-access-control.md` (the private store + authenticated read path),
  `public-api-conventions.md` (the conventions a v1 route inherits), and the
  shipped attachment substrate (`lib/blob/*`, `attachmentsService`, Epic 5.2).
- **Supersedes / superseded by:** none. It **constrains** `design-result.md` in
  one direction only — §3 below pins that a design deliverable never uses the
  door this record creates — and contradicts none of its seven sections.

> Convention (set by `work-item-type-taxonomy.md`, followed by
> `billing-tiering.md` / `acceptance-video.md` / `design-result.md`): a decision
> record is a markdown file under `docs/decisions/`, structured
> **Status → Context → Decision → Consequences**, with the load-bearing facts
> pinned in explicit tables so downstream code has one authoritative source to
> implement against.

---

## Context

A work item can already receive a file three ways. None of them is general.

### Shipped substrate this reconciles against (verified 2026-08-19 on `origin/main` @ `fbe5e2cd`)

| #     | Entrance                                                                                               | Shape                                                    | Auth                                                                                          | Gates run in                          | Row lands                              |
| ----- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------- | -------------------------------------- |
| **1** | `app/api/upload/issue-attachment/route.ts`                                                             | direct multipart → `attachmentsService.uploadAttachment` | `getSession()` + active-project **cookie** (`getActiveProject()`)                             | `attachmentsService`                  | attachments panel (`editor` / `panel`) |
| **2** | `app/api/work-items/[id]/acceptance-evidence/upload-token/route.ts` + `…/acceptance-evidence/route.ts` | mint → client PUT → register                             | `authenticateCiPublisher(req, ACCEPTANCE_PUBLISH_PERMISSION)` — GitHub OIDC **or** bearer PAT | `acceptanceEvidenceService` (its own) | acceptance panel                       |
| **3** | `app/api/work-items/[id]/design-evidence/upload-token/route.ts` + `…/design-evidence/route.ts`         | mint → client PUT → register                             | `authenticateCiPublisher(req, DESIGN_PUBLISH_PERMISSION)` — GitHub OIDC **or** bearer PAT     | `designEvidenceService` (its own)     | Design result panel                    |

Four facts about that table decide everything below.

- **Entrances 2 and 3 are already token-authenticated and already resolve the
  workspace from the TOKEN.** `DESIGN_PUBLISH_PERMISSION` and
  `ACCEPTANCE_PUBLISH_PERMISSION` are both `'work_item:edit'`
  (`lib/tokens/grant.ts`), which `CLI_TOKEN_GRANT` carries
  (`lib/mcp/toolPermissions.ts`). **A dispatched agent can already put a file on
  a card.** What it cannot do is put an _arbitrary_ file on a card.
- **Entrances 2 and 3 do NOT go through `attachmentsService`.**
  `designEvidenceService` writes rows via `attachmentRepository.create` directly,
  mints with `mintPrivateUploadToken`, and enforces its own MIME rule
  (`isAllowedDesignAssetType`) plus a post-hoc `headPrivateBlob` on the actual
  bytes. That is correct for a lifecycle-owned artifact and is the reason a
  pre-signed shape costs a second implementation of every gate.
- **Each is welded to a lifecycle**: its own kind enum (`DesignAssetKind`), its
  own MIME allowlist, its own supersede/retention semantics, and its own panel.
  There is nothing left to generalise once those are removed.
- **`AttachmentSource` has five members** — `editor · panel · acceptance_video ·
acceptance_trace · design_asset` — and `attachmentRepository.listByWorkItem`
  and `countByWorkItem` both filter with
  `source: { notIn: ['acceptance_video', 'design_asset'] }`.

There is **no attachment route anywhere under `/api/v1`** (31 v1 routes, none),
and **no MCP tool uploads a file** (38 tools in `lib/mcp/tools/`, none attaches).

### The measurement that decides §1

`attachmentsService.uploadAttachment` enforces a per-file limit resolved from the
org's tier — `entitlementsService.resolvePerFileLimitBytes` → `maxUploadBytes`,
which is **10 MB** on `free` and off-cloud and **100 MB** on every paid tier
(`lib/billing/entitlements.ts`).

A **direct multipart POST to a serverless function is capped at ~4.5 MB** — the
cap `acceptance-evidence/route.ts` names in its own header as the reason the
video went client-direct (MOTIR-1681). **That platform cap binds strictly below
the entitlement on every tier.** So a direct-multipart door advertises a limit it
cannot honour, and the gap is 2× on `free` and 22× on paid. This is the single
strongest argument for the pre-signed shape and §1 accepts the cost explicitly
rather than discovering it later.

---

## Decision

### 1. A FOURTH entrance, under `/api/v1`, DIRECT MULTIPART — with its ceiling pinned

**Not a generalisation of any of the three.** Taking either evidence publisher
general means deleting its kind enum, its allowlist, its supersede rule and its
panel — i.e. deleting what makes it correct — and taking entrance 1 general means
forking one route's auth across two callers that resolve the workspace
differently. The v1 surface is where a token-authenticated, versioned,
OpenAPI-described entrance belongs (`public-api-conventions.md`).

**Shape: direct multipart, delegating to `attachmentsService`.** The decisive
argument is not simplicity, it is that a pre-signed shape **cannot** delegate:

|                                                  | direct multipart                                               | pre-signed (mint → PUT → register)                                                                                                                                               |
| ------------------------------------------------ | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| where size / MIME / rate-limit / storage-cap run | `attachmentsService.uploadAttachment`, once, on the real bytes | nowhere on the way in — re-asserted at mint (declared type) and at register (`headPrivateBlob`), i.e. **a second implementation of every gate**                                  |
| round trips for the caller                       | 1                                                              | 3, with a 300 s token TTL between them                                                                                                                                           |
| metadata                                         | carried on the request                                         | ⚠️ **dropped unless re-sent on the PUT** — `mintPrivateUploadToken` signs only `content-type` (`signableHeaders`), so anything set at mint time does not reach the stored object |
| max payload                                      | **~4.5 MB** (platform)                                         | the entitlement (10 / 100 MB)                                                                                                                                                    |

MOTIR-3057's acceptance criteria forbid re-implementing a gate, and MOTIR-3060
asserts both entrances refuse identically. **A pre-signed generic door would
violate both by construction**, because the bytes never reach the service that
owns the rules. Two copies of a MIME allowlist is a security control that drifts;
that is a worse outcome than a size ceiling.

**The accepted cost, stated so it is a decision and not a surprise: the generic
door's effective per-file ceiling is ~4.5 MB on every tier**, below the 10 / 100
MB the entitlement advertises. Consequences for MOTIR-3057:

- The route does **not** re-implement a size check. The service's
  `FileTooLargeError` (413) stays the only size refusal it emits.
- A payload above the platform cap is rejected by the platform before the handler
  runs. The route cannot turn that into a typed error, so **the ceiling is
  documented** (MOTIR-3062) rather than handled.
- The route advertises no limit of its own. The API reference states both numbers
  and which one binds.

**What would justify the pre-signed shape later, and the trigger for adopting
it:** a deliverable class whose files are _routinely_ above the platform cap — a
recording, a dataset, a trace bundle, a profiling capture. At that point the
correct move is a **second, additive** entrance using the mint → PUT → register
triple entrances 2 and 3 already use, with its own record, **not** a conversion
of this one: the small-payload path is the one every non-lifecycle deliverable
uses, and it is worth keeping single-round-trip and fully delegated. A single
file over the cap is not the trigger; a class of them is.

### 2. `AttachmentSource` gains **`api`** — named for the DOOR, not the actor

**A new member, not a reuse.** Both existing general values carry semantics that
would be wrong:

| candidate | why it is wrong                                                                                                                                                                                                                                                            |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `editor`  | `attachmentsService.deleteAttachment` throws `AttachmentEditorSourcedError` on an editor-sourced row — the Jira-verified rule that prevents the broken-embed hole. An API upload is embedded in no body, so the block protects nothing and only makes the row undeletable. |
| `panel`   | asserts a provenance that is false. Recording where an upload came from is the **only** reason this column exists (`prisma/schema.prisma`, the enum's doc comment), so writing a known-wrong value into it defeats the column.                                             |

**`api`, and deliberately not `agent`.** Motir cannot distinguish an agent from a
person holding a personal access token — the two are the same bearer credential
on the same route. Naming the member `agent` writes a fact the server does not
know into the column that feeds filtering, garbage collection and analytics, and
those are exactly the consumers a wrong value corrupts. The door is what is
known, so the door is what is recorded.

> This is a naming refinement, **not** a scope change, and MOTIR-3000 needs no
> amendment. The parent settles that the distinction is DATA and not a visual
> treatment, and that holds unchanged. Its phrase _"records an agent upload as
> distinct from an editor one"_ describes the motivating case; `api` records that
> same distinction without over-claiming who the caller was.

**MIME: `ALLOWED_UPLOAD_TYPES`, unchanged.** No new class, no widening. In
particular **`text/html` remains 415 through this door** — `design-result.md`
§5a's posture is that HTML is admissible only inside the design lifecycle, which
serves it cross-origin from the object-store host inside a fully restrictive
sandbox. The generic door has none of those three layers, so it must not accept
the type that needs them. `MAX_UPLOAD_BYTES` and the entitlement are untouched.

**Listing: NOTHING IS OWED, AND THAT IS THE FINDING.** Both panel queries filter
with **`notIn` — a DENYLIST** — so `api` is listed and counted **by default**,
with no change to `listByWorkItem`, `countByWorkItem`, or any component. The
obligation is therefore inverted from the one MOTIR-3056 was written to expect:

- there is **no listing change to make**;
- there **is** a test to write, and it asserts a NEGATIVE — that `api` appears in
  neither `notIn` array — so that a later "tidy the exclusions" edit fails;
- both arrays must be asserted. They are written independently, and a test
  covering only `listByWorkItem` leaves the count badge free to disagree with the
  list it labels.

> ⚠️ **The denylist is already out of sync with its own documentation, and that
> is NOT this record's to fix.** `acceptance_trace` is documented in
> `prisma/schema.prisma` as _"excluded from the attachments panel listing"_, is
> absent from both `notIn` arrays, and `acceptanceEvidenceService` creates those
> rows **with `workItemId` set** to the story. So trace rows are listed today.
> Filed as its own bug under MOTIR-3000. MOTIR-3056 must not widen or narrow any
> exclusion while landing `api`, and its criterion asserting the trace exclusion
> is _"unchanged"_ is corrected to say the exclusions are untouched — which is
> true — rather than that trace is excluded, which is not.

### 3. A `design` deliverable ALWAYS uses the design-evidence publisher

Once the generic door exists, a design `.png` has two possible routes. The answer
is that it has one, and the reasons are not stylistic:

- **The set would split by file type.** A design deliverable is three files, and
  `*.mock.html` is `text/html`, which §2 keeps at 415 through the generic door. So
  the generic door could carry the `.png` and never the mock — half a design
  result, in a different panel from its other half.
- **The panels have different owners.** `design_asset` rows are excluded from the
  attachments listing precisely because the DesignEvidence lifecycle owns them and
  renders them in the Design result panel, with supersede semantics the generic
  door has none of.
- **The design gate reads the design result.** A `.png` sitting in the attachments
  panel is not what the next reader's design-reference check opens.

**The rule, in the form a prompt author can act on** (this is what MOTIR-3059
implements and MOTIR-3062 publishes):

> A deliverable that a LIFECYCLE owns goes through that lifecycle's publisher — a
> design asset through the design-evidence route, an acceptance recording through
> the acceptance-evidence route. Everything else — a research findings document,
> a review's notes, a verification's evidence — goes through the generic
> `/api/v1` attachment door. **If you are unsure, the test is whether a dedicated
> panel exists for it: if one does, that panel's publisher is the door.**

A design asset therefore **never** legitimately appears in the attachments panel,
and MOTIR-3058's tool description says so inline so the choice is never made at
run time.

---

## Consequences

- **MOTIR-3056 gets smaller and its test gets sharper.** The enum gains `api`
  with a migration; **no listing query changes**; the deliverable is a test
  asserting `api` is absent from both `notIn` arrays and that a linked `api` row
  is returned by `listForWorkItem` and counted by `countByWorkItem`.
- **MOTIR-3057 is a thin route and stays one.** Direct multipart, one service
  call, no size / MIME / rate-limit / entitlement logic of its own, and a
  documented ~4.5 MB ceiling it does not itself enforce.
- **MOTIR-3058's permission is `work_item:edit`**, matching both publish
  permissions and present in `CLI_TOKEN_GRANT` — asserted against that constant.
- **A second, pre-signed generic entrance is a planned future addition**, not a
  gap. Its trigger is a deliverable class routinely above the platform cap, and
  it gets its own record.
- **Two documentation obligations fall out** (MOTIR-3062): the API reference
  states both size numbers and which binds, and the tool contract states the
  which-door rule from §3.
- **One bug is filed and not fixed here**: the `acceptance_trace` listing
  divergence above.
