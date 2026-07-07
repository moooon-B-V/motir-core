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
