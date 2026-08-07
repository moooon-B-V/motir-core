# ADR: Access-controlled attachments — private Blob store + authenticated read path

- **Status:** Accepted (2026-07-07, drafted for Story MOTIR-1665 per the
  decision-subtask ladder). This is the rung-1 policy the rest of MOTIR-1665
  implements — no attachment-storage code changes until this is pinned. **No
  application behaviour ships in this subtask** (the ADR only).
- **Story / Subtask:** MOTIR-1665 (Access-controlled attachments) · Subtask
  MOTIR-1666.
- **Consumed by:** MOTIR-1667 (private upload + pathname model + content route),
  MOTIR-1668 (render-site swaps), MOTIR-1669/1670 (integration + E2E tests).
- **Builds on:** the shipped attachment/blob pipeline (`lib/blob/uploader.ts`,
  `attachmentsService`, the `Attachment` model), the acceptance publish
  (MOTIR-1631), and the workspace-RLS / session-membership authorization already
  used by the item read path.
- **Supersedes / superseded by:** supersedes the "make the Blob store public"
  option floated in the incident triage (MOTIR-1665 was born a bug) — explicitly
  rejected here on security grounds.
- **Amendment 1 (2026-07-07, MOTIR-1665 re-decomposition) — TWO stores (public
  avatars / private content), the real 2.4.0 signing flow, and id-based editor
  embeds.** Tracing the true blast radius refined three things this ADR's first
  draft under-specified:
  - **Two stores, not one.** **Avatars are PUBLIC** — a profile picture renders
    everywhere (member lists, mentions, assignee chips) with **no per-item auth
    context** and wants CDN-cacheable URLs; putting it behind a per-item signed
    redirect is both wrong and expensive. So avatars go to a dedicated **public**
    Blob store (`putPublicAsset`; `User.image` stays a public URL). Only
    **content** (comment/description embeds, panel files, acceptance video +
    trace) is **private** (`putPrivateAttachment` + the content route). The single
    `putAttachment` splits into `putPublicAsset` / `putPrivateAttachment`.
  - **Signing flow.** A private download URL uses the `@vercel/blob` 2.4.0
    **`issueSignedToken` → `presignUrl`** delegation flow — NOT
    `head().downloadUrl` (which doesn't accept `access`).
  - **Editor embeds go ID-BASED.** The editor-embed / link-on-write pipeline
    (`uploadClient` / `referencedUrls` / `syncEditorLinks`) matched rows by the
    public URL string; with no public URL it now inserts + matches the **content
    path `/api/attachments/<id>/content`** and links by attachment id.
    This grew the story to: adapter (MOTIR-1672), avatars→public (MOTIR-1673) +
    public-store provisioning (MOTIR-1671), content-private (MOTIR-1667), editor-
    embed id (MOTIR-1668), acceptance video+trace (MOTIR-1674), tests
    (MOTIR-1669/1670). §1–§2 below read against the private (content) store; the
    public-avatar store is the parallel path.
- **Amendment 2 (2026-08-07, MOTIR-2385) — the provider changes: S3 presigned
  URLs on Tigris replace the `@vercel/blob` delegation flow, and the two stores
  become two buckets.** See the section at the end of this file. Everything §1–§5
  decides about the _model_ — private storage, the authenticated route, the
  authorization matrix, the DTO surface, the 300 s TTL — survives unchanged.

> Convention (set by `work-item-type-taxonomy.md`, followed by
> `billing-tiering.md` / `acceptance-video.md`): a decision record is a markdown
> file under `docs/decisions/`, structured **Status → Context → Decision →
> Consequences**, with load-bearing facts pinned in explicit tables.

---

## Context

**Every production blob upload currently 500s.** Confirmed from prod runtime logs
on the first-ever real prod blob write — the MOTIR-1627 acceptance-video publish:

```
POST /api/work-items/MOTIR-1627/acceptance-evidence → 500
Vercel Blob: Cannot use public access on a private store. The store is configured with private access.
```

`lib/blob/uploader.ts:22` (`putAttachment`, Subtask 2.3.7) uploads
`access: 'public'`, but the production store `prodect-core-blob`
(`store_Wv5V9fWWFsXURacA`) is **private** (0 files in 33 days → no upload has ever
succeeded; the E2E mocks blob via `E2E_TEST_BLOB=1`, so it was invisible). This
affects **every** attachment (comment/description images, avatars, acceptance
videos), all of which flow through the one `putAttachment` seam.

Two ways out: (A) make the store public, or (B) keep it private and serve
attachments through an authenticated read path.

**Security decision — B, not A.** A Vercel "public" blob is **world-readable**:
the URL is long and unguessable (`addRandomSuffix`), but any holder of the URL
can fetch the bytes with **no authentication**. A leaked URL — pasted, logged, in
a `Referer` header, cached by a proxy — is an exposed file. For a PM tool whose
attachments carry internal/customer data, that is not acceptable. The mirror
products confirm the standard (rung 1): **Jira and Linear serve attachments
through authenticated / redirect endpoints, never as world-readable URLs.** So
Motir adopts **access-controlled attachments**.

`@vercel/blob` **2.4.0** supports this natively: `put(…, { access: 'private' })`,
a server-side authenticated `get(…, { access: 'private' })` (streams
`{ stream, headers }`), and `presignUrl` / `getDownloadUrl` for short-lived
signed GET URLs.

---

## Decision

### 1. Private storage

|           |                                                                                                                                   |
| --------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Upload    | `put(pathname, body, { access: 'private', addRandomSuffix: true, contentType })` — the store is already private; no provisioning. |
| Persisted | `Attachment` stores the blob **`pathname`** (the key), **not** a URL. (Column `url` → `pathname`.)                                |
| Migration | **None on prod data** (0 files). The schema column is renamed/repurposed; a throwaway-DB `migrate dev` generates it.              |

### 2. Read model — authenticated route → **presigned redirect** (not stream)

The read path is a single app route:

```
GET /api/attachments/[id]/content
  → authorize the session viewer (§3)
  → presign a short-lived GET URL for the blob pathname
  → 302 redirect to it
```

**Redirect, not stream.** The route does auth + a `presignUrl` and **302s**; the
browser then fetches the bytes **directly from Vercel Blob**, not through our
serverless function. This is deliberate: streaming a multi-MB video _through_ the
function is exactly what blew the ~15s function limit in the incident. A redirect
keeps the function O(1) regardless of file size, and the content route is usable
directly as `<img src>` / `<video src>` (browsers follow the 302). The
server-side `get(access:'private')` stream stays available as a fallback for
tiny/inline needs, but is not the default.

### 3. Authorization rule

| Caller                                                                                    | Result                  |
| ----------------------------------------------------------------------------------------- | ----------------------- |
| No session                                                                                | **401**                 |
| Session, but not a member of the attachment's workspace / cannot see the owning work item | **403**                 |
| Session + authorized                                                                      | **302 → presigned URL** |
| Attachment id not found                                                                   | **404**                 |

Authorization **reuses the existing item read authorization** (the same
workspace-membership + item-visibility check the item detail read already
applies) — an attachment is readable iff its owning work item is. This keeps one
source of truth for "who can see this item's content."

### 4. DTO surface

|                                                     |                                                                        |
| --------------------------------------------------- | ---------------------------------------------------------------------- |
| The `Attachment` / `AcceptanceEvidence` DTO exposes | a stable **content path** `contentUrl = /api/attachments/[id]/content` |
| It NEVER exposes                                    | a raw blob URL or the pathname                                         |

### 5. Signed-URL TTL

Short — a few minutes (default **300s**), long enough only for the immediate
redirect fetch. A fresh presign is issued per request, so there is no long-lived
shareable URL; expiry is not a page-lifetime concern because the browser
re-hits the content route (re-authorized) whenever it needs the resource.

---

## Consequences

- **MOTIR-1667** changes `putAttachment` to `access: 'private'` (returns the
  pathname), adds a `signedDownloadUrl(pathname, ttl)` helper, renames
  `Attachment.url` → `pathname` (migration, no backfill), adds the
  `GET /api/attachments/[id]/content` route with the §3 authorization, and maps
  the DTO to `contentUrl`.
- **MOTIR-1668** repoints every render site (Markdown images, avatars, the
  acceptance `<video>`, attachment previews) at `contentUrl`. No public URL
  survives; no visual change.
- **MOTIR-1669 / 1670** cover the auth matrix (integration) and the end-to-end
  acceptance (the MOTIR-1627 video plays via the content route; an anonymous
  content request is denied).
- **No store provisioning, no data migration** — the private store already
  exists and is empty.
- Off-cloud / self-host: unchanged — the same private-store + auth'd-route model
  works against any Blob-compatible store (the `lib/blob/uploader.ts` seam is the
  single swap point, per its original charter).

---

## Amendment 2 (2026-08-07) — the signing flow is S3 presigned URLs on Tigris; the two stores become two buckets

> **Written by Story MOTIR-2384 · Subtask MOTIR-2385**, whose decision record is
> [`application-hosting.md`](./application-hosting.md). That record moves
> motir-core's hosting from Vercel to Fly.io; this amendment is the part of the
> move that lands inside a decision already accepted here.
>
> **Numbered 2.** The 2026-07-07 amendment in the Status block above is
> Amendment 1; it was unnumbered when it was the only one.

**Amends:** the **Signing flow** clause of Amendment 1, and the provider named in
§1's Upload row and §2's presign step. **Nothing else in this record changes** —
§1 private storage, §2's authenticated-route-then-redirect read model, §3's
authorization matrix, §4's DTO surface and §5's TTL are all re-stated below
against the new provider and are otherwise untouched.

### Q1 — the signing flow

#### What is being replaced

Amendment 1 pinned the mechanism to a vendor's API **by name**:

> A private download URL uses the `@vercel/blob` 2.4.0 **`issueSignedToken` →
> `presignUrl`** delegation flow — NOT `head().downloadUrl` (which doesn't accept
> `access`).

That was correct when written and becomes false the moment the provider changes.
The delegation flow is `@vercel/blob`-specific and has no counterpart outside it.

#### The replacement

**A private download URL is an S3 PRESIGNED GET**, issued server-side by the
content route against the private bucket, for the object's key.

| Concern          | Was (`@vercel/blob` 2.4.0)                                 | Is (S3-compatible, Tigris)                                   |
| ---------------- | ---------------------------------------------------------- | ------------------------------------------------------------ |
| Private download | `issueSignedToken({ operations: ['get'] })` → `presignUrl` | **presigned GET** on the private bucket's key                |
| Browser upload   | `generateClientTokenFromReadWriteToken`                    | **presigned PUT** on the private bucket's key                |
| Object existence | `head(pathname, { access: 'private' })`                    | a **HEAD** on the object                                     |
| Delete           | `del(url)`                                                 | a **delete-object** on the owning bucket's key               |
| Credential       | `BLOB_READ_WRITE_TOKEN` / `BLOB_PUBLIC_READ_WRITE_TOKEN`   | one S3 access-key pair per Fly-provisioned Tigris credential |

**`head().downloadUrl` is still not the answer**, for the same reason it was not
before: the read path is auth-then-presign, and an unauthenticated durable URL is
what §2 exists to prevent.

**⚠️ One genuine behavioural difference, pinned here rather than found at run
time: a presigned PUT carries only the metadata the SIGNER set.** With
`@vercel/blob` the client token flow negotiated the content type; with a
presigned PUT the browser cannot add one that was not signed for. **Content type
is therefore bound at signing time**, or every client-uploaded object lands as
`application/octet-stream` and every embedded image renders as a download.

**The TTL is unchanged: 300 s** (§5). A fresh presign is issued per request, so
there is still no long-lived shareable URL, and expiry is still not a
page-lifetime concern because the browser re-hits the content route.

#### Rejected alternatives

| Alternative                                              | Why rejected                                                                                                                                                       |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Keep `@vercel/blob`, called from Fly                     | The SDK is not tied to Vercel compute, so it would work — and it would keep the account and the billing relationship the move exists to end.                       |
| Stream the bytes through the route instead of presigning | Already rejected in §2 and still rejected: streaming a multi-MB video through the function is what blew the ~15 s limit in the incident this record was born from. |
| Make the bucket public and drop signing                  | Already rejected in Context, on security grounds. Changing hosts does not re-open it.                                                                              |

### Q2 — the public/private split, re-stated against buckets

Amendment 1's split survives **exactly**, expressed as two buckets rather than
two Blob stores:

| Store              | Contents                                                          | Access                                                    | Written by                               |
| ------------------ | ----------------------------------------------------------------- | --------------------------------------------------------- | ---------------------------------------- |
| **Public bucket**  | avatars (`User.image`) and other public assets                    | **public-read** — a directly fetchable URL, CDN-cacheable | `putPublicAsset`                         |
| **Private bucket** | comment/description embeds, panel files, acceptance video + trace | **no public read** — presigned GET only, via §2's route   | `putPrivateAttachment` / `putAttachment` |

The reasoning is Amendment 1's and is unchanged: an avatar renders everywhere
with **no per-item auth context** and wants a cacheable URL, so putting it behind
a per-item signed redirect is both wrong and expensive; content is private
because a leaked durable URL is an exposed file.

**Two buckets, not one bucket with per-object ACLs.** The split is structural so
that it cannot be got wrong one object at a time — the same reason it was two
stores before.

`Attachment` still persists the **key**, never a URL; the DTO still exposes only
`contentUrl = /api/attachments/[id]/content`; editor embeds are still id-based.
None of that is provider-dependent, which is why none of it changes.

### Consequences of this amendment

- **MOTIR-2389** reimplements all nine `lib/blob/uploader.ts` exports against the
  S3 client with their signatures unchanged, binds content type at signing time,
  keeps the 300 s expiry, and copies the objects already in the old stores.
- **MOTIR-2386** provisions the two buckets — the public one with public-read —
  and their credentials as Fly secrets.
- **MOTIR-2393** removes `@vercel/blob` and the four `BLOB_*` env reads; after it,
  the delegation flow named in Amendment 1 exists nowhere in the repository,
  which is why leaving that clause unamended was not an option.
- **§1–§5 need no other edit.** The model was always "private store +
  authenticated route + short-lived presign"; only the vendor implementing it
  changed.
- **Off-cloud / self-host improves.** The original record already claimed the
  model works "against any Blob-compatible store". It is now implemented against
  the **S3 API**, which is what a self-hoster is most likely to have.
