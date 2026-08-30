# Which host answers for each public surface — and why motir-core keeps none of them

- **Status:** Accepted (2026-08-29, drafted for Story MOTIR-3876 per the
  decision-subtask ladder). **No application behaviour ships in this subtask** —
  it writes this file, amends `marketing-site-hosting.md`, and changes no code,
  no workflow and no config.
- **Story / Subtask:** MOTIR-3876 (motir-core becomes an application plus a
  public read API) · Subtask MOTIR-3879.
- **Consumed by:** MOTIR-3945 (the project-subject route), MOTIR-3946 (the
  versioned contract), MOTIR-3881 (the origin split), MOTIR-3932 (the rendering
  move), MOTIR-3877 (`/p/*`), MOTIR-3908 (the cloud gate), MOTIR-3909
  (`/legal`), MOTIR-3910 (the redirects and registrations). §7 says which of
  them this record changes and which it leaves alone.
- **Builds on:** `marketing-site-hosting.md`, which decided WHERE the marketing
  site runs and — correctly, for what it was asked — never asked which
  repository owns which public surface. `application-hosting.md` for the Fly
  shape. `billing-tiering.md` §6 for the cloud-vs-self-host flag.
- **Filed by:** `motir run MOTIR-3876`, which stopped at this card because the
  question had widened twice since it was written.
- **Supersedes / superseded by:** amends `marketing-site-hosting.md` Q1 and Q2
  (see §7); supersedes nothing else.

> Convention (set by `work-item-type-taxonomy.md`, followed by
> `application-hosting.md` / `marketing-site-hosting.md`): **Status → Context →
> Decision → Consequences**, with a numbered-**Q** section and a per-Q
> rejected-alternatives table.

---

## The problem

`marketing-site-hosting.md` (Accepted 2026-08-27) answered _"where does the
marketing SITE run?"_ — Fly, a second app — and answered it well. It never asked
_"which host answers for each PUBLIC SURFACE, and which repository owns it?"_,
because when it was written the only public surface anyone had in mind was a
landing page.

Three others already existed, in the other repository, on the other host. And a
fourth question was hiding underneath all of them: **`motir-core` is GPL-3.0 and
is meant to be a product a team runs for itself.** It had quietly accumulated
things that belong to the company rather than to the software — another
company's privacy policy and terms, and a cross-tenant directory of public
projects aimed at strangers. Nobody chose that. It is what happens when the
hosted service and the open product are built in one repository and nobody draws
the line.

**So this record draws it, and the line is not _where does this render_ but
_whose is it_.**

### ⚠️ The question was answered three times in one day, and the first two answers are recorded rather than deleted

A reader who finds an earlier arrangement quoted in a card, a branch or a
comment should land here and learn why it changed, not conclude the plan is
confused. §2's rejected-alternatives table carries both.

---

## §1 — The decisions, in one table

| #      | Question                                                            | Decision                                                                                                                                       |
| ------ | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| **Q1** | Which host answers for each public surface, and which repo owns it? | **`motir.co` serves every public page, from `motir-marketing`.** `app.motir.co` serves the authenticated application and an anonymous read API |
| **Q2** | What is the seam between them?                                      | **An HTTP contract.** `motir-core` publishes `app/api/public/*` with a version and a deprecation policy; `motir-marketing` is its consumer     |
| **Q3** | Does the session cookie change scope?                               | **No — it stays host-only on `app.motir.co`.** §4 records the deviation this creates and its reversal condition                                |
| **Q4** | What does a SELF-HOSTED build serve at each public path?            | **Public projects are a cloud CAPABILITY.** With `MOTIR_CLOUD` false the feature is absent, not hidden. §5 is the per-path table               |
| **Q5** | Who writes `robots.txt` and `sitemap.xml` for each host?            | **Each host's own application**, and neither describes the other. §6                                                                           |

---

## §2 — Q1: which host answers for each public surface

### The decision

| surface                          | host           | repository        | why                                                                                                                                                      |
| -------------------------------- | -------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/` (the landing)                | `motir.co`     | `motir-marketing` | it is marketing material; a GPL repository shipping it hands every self-hoster Motir's brand                                                             |
| `/legal`, `/legal/*`             | `motir.co`     | `motir-marketing` | **moooon B.V.'s own contract text.** CONTENT, not capability — no runtime flag makes another company's privacy policy appropriate in an open-source tree |
| `/docs` and beneath              | `motir.co`     | `motir-marketing` | rendered there, from an artifact `motir-core` publishes — see the cost in §8, which is the sharpest one this record carries                              |
| `/explore`, `/explore/topic/*`   | `motir.co`     | `motir-marketing` | a cross-tenant directory is a hosted-service surface, not part of a single-tenant tool                                                                   |
| `/p/*`                           | `motir.co`     | `motir-marketing` | tenant-authored content, rendered over the public contract. **DECIDED, not deferred** — MOTIR-3877                                                       |
| everything behind `getSession()` | `app.motir.co` | `motir-core`      | unchanged. An application subdomain is the convention and it stays                                                                                       |
| `app/api/public/*`               | `app.motir.co` | `motir-core`      | the data and the access gates live where the database is; only the rendering moves                                                                       |

**`motir-core` ships no public rendering at all.** That is the point of the
arrangement rather than a side effect of it.

### Where the line comes from — measured, not asserted

Read on `origin/main`, 2026-08-29:

| reading                                           | value                                                                                                                                                   |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `getSession()` calls under `app/(public)/explore` | **0 files, 0 calls**                                                                                                                                    |
| … under `app/(public)/docs`                       | **0 files, 0 calls**                                                                                                                                    |
| … under `app/(public)/legal`                      | **0 files, 0 calls**                                                                                                                                    |
| … under `app/(public)/p`                          | **11 files, 13 calls** (of 12 files in the directory)                                                                                                   |
| `app/api/public/*` routes                         | **10**, of which **exactly one** is session-gated ⚠️ WRONG — see [AMENDMENT 1 §G](#g--a-third-wrong-reading-of-this-surface-corrected-and-then-derived) |

The gated one is `p/[identifier]/follow` (POST/DELETE, 401) — an account
relationship, which should require a session. `explore/route.ts` and
`categories/route.ts` make **no** session call at all; the first says so in its
own comment: _"NOT session-gated: a logged-out visitor / crawler reads it …
deliberately no `getSession()` call."_ The four `/p/*` reads take an optional
`actorUserId = session?.user.id ?? null` for viewer-awareness and are labelled
_"NOT session-gated on READ."_

> **⚠️ Two earlier readings of this surface were WRONG, in opposite directions,
> and both are recorded here so the number is not re-derived a fourth time.**
> A count of _"six routes call `getSession()`"_ (MOTIR-3877, as authored) and a
> later _"eight of ten"_ were both artefacts of grepping for the string
> `getSession` and matching **comments** — including the comment stating that
> the call is deliberately absent. Counting real calls, excluding comment lines,
> gives **one**. The correction is on MOTIR-3877.

**The one genuine gap:** there is no `app/api/public/p/[identifier]/route.ts`.
Every LIST a public project page renders has an endpoint; the project's own
subject — name, overview, tags, workspace — does not. MOTIR-3945 adds it.

### Rejected alternatives

| Alternative                                                                                                         | Why rejected                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A — `motir.co` served by `motir-core`, with the landing ported into it**                                          | The first answer, and the cheap direction: ten files with no database against roughly forty DB-backed public routes the other way. **Rejected on open-core grounds.** `motir-core` is GPL-3.0 and must be a valid standalone product; consolidating there means every self-hoster ships Motir's marketing site, its brand and moooon B.V.'s legal documents. Cheapness to build is not a reason to make the open product misrepresent itself.                                                           |
| **B — compose `motir.co` from TWO origins** (an edge router, or one application forwarding a path set to the other) | Live for several hours as the answer to _"the code is in one repo and the URL must be in the other."_ **Dissolved rather than argued down**: once the rendering itself moves, one application answers the hostname and there is nothing to compose. It would also have put a route list somewhere nothing guards — the failure `tests/navigation/proxy-matcher.test.ts` exists for: _"the matcher was a COMMENT asking future authors to remember, and thirteen of sixteen segments were never added."_ |
| **C — keep the split; make `motir.co` a better hub**                                                                | The status quo. `motir-marketing/lib/destinations.ts` derives `EXPLORE`, `DOCS` and `LEGAL_*` from `APP_ORIGIN`, so every content link in the brand root leaves the brand host, and `RootJsonLd.tsx` declares a `WebSite` SearchAction against an origin it does not serve, under its own ⚠️. This is the problem, not a resolution of it.                                                                                                                                                              |
| **D — `motir-core` keeps rendering `/explore` and `/p/*` on a subdomain of its own**                                | Considered, and it does fix the address. It leaves the open-core defect untouched: a self-hosted build still ships a cross-tenant directory and public project pages aimed at strangers. Gating those pages was the earlier framing (see §5); removing them from the repository's rendering surface entirely is stronger and simpler.                                                                                                                                                                   |
| **E — `motir-marketing` reads the database directly**                                                               | Never seriously proposed and named here to close it: it would be a second reader of a schema with row-level security, in a repository with no migrations, no Prisma client and no tenancy context. The contract is HTTP precisely so the gates stay in one place.                                                                                                                                                                                                                                       |

---

## §3 — Q2: the seam, and what it makes of the public API

> **⚠️ Answered 2026-08-30 — see [AMENDMENT 1](#amendment-1--the-public-surface-gets-its-own-contract-generated-by-v1s-machinery-with-its-own-version-and-its-own-document-motir-3946-2026-08-30)
> at the foot of this file.** The question this section left open — join the
> `/api/v1` document, or get its own — is settled as **its own**, on three
> measured grounds, and the amendment carries the deprecation policy the
> paragraph below only promises.

### The decision

**`motir-core` publishes `app/api/public/*` as a versioned contract with a
deprecation policy, and `motir-marketing` is a consumer of it.** MOTIR-3946
performs the promotion.

An internal BFF and a published contract are the same routes and different
objects. The difference is that somebody else's site breaks when you change it,
and that you have promised them it will not. `app/api/public/*` was written as
one application's own way of feeding its own pages, which is why it has no
version and no deprecation policy — there was never a second reader to owe one
to. There is about to be.

**`docs/decisions/public-api-conventions.md` governs `/api/v1`, and the
published OpenAPI document is v1 REST only**, so this surface is outside both.
Whether it joins that document or gets its own is MOTIR-3946's to decide and
record; what this record binds is that it may not stay undescribed.

### ⚠️ The guard belongs in the PRODUCING repository

A contract test that lives only in the consumer reports that `motir-core` broke
`motir.co`, after it has shipped. The guard worth having **fails in
`motir-core`'s own CI, on the pull request that changes the shape**, naming the
consumer. A consumer-side check is a smoke alarm in the wrong building.

### Rejected alternatives

| Alternative                                                                     | Why rejected                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Leave `/api/public/*` internal and undocumented**                             | It is what exists today, and it is fine for one application feeding its own pages. With a second repository rendering a live site from it, an unversioned surface means any response-shape change is a potential blank page on the brand's own website, discovered by a visitor. |
| **Give `motir-marketing` a read-only database replica**                         | Removes the network hop and the contract, and re-introduces the thing the split exists to avoid: a second reader of an RLS-bound schema, in a repository with no tenancy context, that must be kept in step with every migration.                                                |
| **Server-render `/p/*` in `motir-core` and iframe or proxy it into `motir.co`** | Keeps the renderer where the data is, which is genuinely attractive — MOTIR-3877 argued it at length. It fails the open-core test the same way D does in §2, and an iframe re-creates the cross-origin session question this record exists to close.                             |

---

## §4 — Q3: the session cookie, and the deviation this record is most careful about

### The decision

**The Better-Auth session cookie stays host-only on `app.motir.co`.** No
`Domain=` widening to `.motir.co`, now or as a convenience later. MOTIR-3877's
test gate asserts it.

### ⚠️ The deviation, stated rather than glossed

Tenant-authored content — markdown, comments, feature requests, votes — will be
served from `motir.co`, which is the **parent domain** of the host that holds
the session.

**Every mirror puts tenant content on a separate REGISTRABLE DOMAIN**, and this
was checked rather than remembered: Notion publishes on `<workspace>.notion.site`,
GitHub on `<user>.github.io`, Vercel on `*.vercel.app`, Canny on
`<company>.canny.io`, Statuspage on `<company>.statuspage.io`. GitHub's _"Yummy
cookies across domains"_ records why Pages left `*.github.com`: user-controlled
HTML under a subdomain of the application domain enables **cookie tossing,
session fixation and forced logout**, and lends a phishing page the parent's
credibility. `github.io`, `notion.site` and `vercel.app` are on the **Public
Suffix List**, so browsers treat them as separate sites.

**This arrangement is better than today and weaker than the mirrors**, and both
halves are true:

- **Better:** `/p/*` currently renders tenant content on `app.motir.co` — the
  session's own origin, which is the worst available arrangement. Moving it to
  `motir.co` removes that.
- **Weaker:** first-party content and tenant content then share one origin, and
  that origin is the parent of the application's. A page on `motir.co` can set a
  cookie scoped to `.motir.co`, which `app.motir.co` would send.

**The residual exposure is accepted, on the condition that the session cookie is
host-only** — that condition is what makes it survivable, so it is a test rather
than an intention.

### The reversal condition

**MOTIR-3878 (per-tenant addressing) is where this is revisited, and it should
be.** That story plans per-tenant subdomains and custom domains. Two facts make
it the right moment:

1. Per-tenant addressing multiplies the exposure — one origin of user content
   becomes one per customer, all under the session's registrable domain.
2. A base on a subdomain forces three-level addresses (`acme.open.motir.co`),
   which a `*.motir.co` certificate does not cover. A separate registrable
   domain gives `acme.motir.build` under one wildcard.

**A separate domain gets the isolation immediately; PSL listing is a later
refinement** that only adds isolation _between_ tenants. Nothing here needs to
wait on a PSL submission.

---

## §5 — Q4: what a SELF-HOSTED build serves

### The decision

**Public projects are a CLOUD capability. With `MOTIR_CLOUD` false the feature is
ABSENT, not hidden.** Self-hosting is a team doing project management for
itself — single-tenant, with no directory of anybody else's work and nothing
published to strangers.

| path                     | self-hosted build (`MOTIR_CLOUD` unset)                                                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `/explore`, `/p/*`       | **not served by `motir-core` at all** — the rendering lives in `motir-marketing`, which is moooon's site and is not shipped to self-hosters |
| `app/api/public/*`       | **absent.** The routes do not answer. This is the capability gate, and MOTIR-3908 owns it                                                   |
| the publish affordance   | **absent.** A project cannot be made public                                                                                                 |
| `/legal`                 | gone from the repository; `motir-core` renders legal links from configuration, unset by default                                             |
| `/docs`                  | **present.** It describes the software, and a self-hoster needs documentation for their own build                                           |
| everything authenticated | unchanged                                                                                                                                   |

`MOTIR_CLOUD` already exists (`lib/billing/availability.ts`), is explicit and
defaults to `false`, and `billing-tiering.md` §6 records why it is deliberately
**not** inferred from other configuration: _"so a self-hoster who connects their
OWN motir-ai is never force-billed."_ The same reasoning applies here — the flag
says _this is the hosted service_, and nothing else is allowed to imply it.

> **⚠️ A 404 is a decision, not a default.** MOTIR-3908 states what an absent
> capability answers, and it is the same answer on every gated surface.

### Rejected alternatives

| Alternative                                            | Why rejected                                                                                                                                                                                                                                                           |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Gate the PAGES rather than the capability**          | The earlier framing, from when `motir-core` was going to serve `/explore` and `/p/*`. It is obsolete — those pages leave — and it was always the weaker line: a hidden page with a live API and a live publish affordance is a feature that is on with the lights off. |
| **Ship build-in-public to self-hosters**               | It is a multi-tenant, cross-customer surface. A single-tenant deployment has no second tenant to browse, so the directory is empty by construction and the publish affordance offers to show a project to an audience that does not exist.                             |
| **Infer cloud-ness from the presence of other config** | Explicitly rejected by `billing-tiering.md` §6 for billing, and the same trap: a self-hoster who configures something adjacent should never find a hosted-service surface switched on.                                                                                 |

---

## §6 — Q5: `robots.txt` and `sitemap.xml` per host

**Each host's own application writes its own, and neither describes the other.**

| host           | written by        | contents                                                                   |
| -------------- | ----------------- | -------------------------------------------------------------------------- |
| `motir.co`     | `motir-marketing` | allow; the public surface it serves; its own sitemap                       |
| `app.motir.co` | `motir-core`      | `app/robots.ts` (MOTIR-3726) — disallow the API and the signed-in surfaces |

This is the arrangement that needs no cross-repo list, which is the whole reason
it is stated. A single sitemap describing surfaces served by two applications
would be the route mirror B was rejected for, wearing a different name.

`motir-core`'s own sitemap stops emitting entries for pages it no longer serves
as part of MOTIR-3910's sweep, not here.

---

## Consequences — §7: what this record binds, card by card

| card                                         | what changes                                                                                                                                                                                                                                                                                           |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **MOTIR-3945** (the project-subject route)   | **UNCHANGED, and now justified.** §2 records that the subject is the one endpoint the page's own subject lacks.                                                                                                                                                                                        |
| **MOTIR-3946** (the versioned contract)      | **BOUND by §3.** It must decide where the contract is published, and it must put the drift guard in `motir-core`'s CI rather than the consumer's.                                                                                                                                                      |
| **MOTIR-3881** (the origin split)            | **UNCHANGED in substance.** §2 is why one variable can no longer answer both questions. Its fallback-to-the-application-origin arm is what makes the split deployable before anything moves.                                                                                                           |
| **MOTIR-3932** (the rendering move)          | **BOUND by §3 and §8.** Every read goes through the contract; `/docs` may not be a copied spec.                                                                                                                                                                                                        |
| **MOTIR-3877** (`/p/*`)                      | **BOUND by §4.** The host-only cookie stops being a property to preserve and becomes an assertion it owns.                                                                                                                                                                                             |
| **MOTIR-3908** (the cloud gate)              | **BOUND by §5.** The gate is the capability, including `app/api/public/*` and the publish affordance — not the pages.                                                                                                                                                                                  |
| **MOTIR-3909** (`/legal`)                    | **UNCHANGED.** §2 records why this one moves rather than being gated.                                                                                                                                                                                                                                  |
| **MOTIR-3910** (redirects and registrations) | **NARROWED, materially.** `motir.co`'s address records already point at the `motir-marketing` Fly app, so **there is no apex repoint and no new certificate.** What remains is the 301s, the external registrations and a live smoke.                                                                  |
| **MOTIR-3878** (per-tenant addressing)       | **GAINS A QUESTION**: §4's reversal condition. It is where the separate-domain decision is taken.                                                                                                                                                                                                      |
| **`marketing-site-hosting.md`**              | **AMENDED** — see the amendment in that file, dated 2026-08-29. Q3 (CI) and Q4 (subprocessor) stand; Q1's _"where the marketing site runs"_ is unchanged for the site itself but no longer describes the whole public surface, and Q2's apex target is now the record of a state that does not change. |

---

## §8 — The costs of this decision, written as costs

1. **A network hop replaces a Prisma read.** Empty, loading and error states on
   `/explore` and `/p/*` stop being theoretical: the API can be slow, or down,
   and the renderer is in a different application with a different deploy.
2. **A cross-repo contract can break a live site.** §3's guard reduces this; it
   does not remove it. A response-shape change is now a two-repository event.
3. **⚠️ `/docs` is the sharpest cost and the least settled.** Its eight pages are
   GENERATED from `motir-core`'s own registries — `lib/apiDocs/reference` reads
   the OpenAPI spec, `lib/apiDocs/mcp` reads the tool catalogue. Rendering them
   in `motir-marketing` means consuming those registries across a repository
   boundary. **A published artifact `motir-core` emits and the consumer installs
   does not rot; a copied spec does**, and it is the same mirror failure
   `proxy-matcher.test.ts` records. MOTIR-3932 decides the mechanism BEFORE the
   pages are written.
4. **One chrome asset, two implementations.** MOTIR-3880 draws it once;
   `motir-marketing` renders it. Nothing enforces that a later change reaches
   both, and the asset is the only thing holding them together.
5. **Tenant content shares an origin with first-party content** — §4, and the
   only cost here that is a security property rather than a maintenance one.

---

## §9 — What this record deliberately does NOT decide

- **The `/docs` publication mechanism** — named as a cost in §8 and assigned to
  MOTIR-3932. Trigger: writing the first `/docs` page in `motir-marketing`.
- **Where the public contract is published** — the v1 document or its own.
  MOTIR-3946. Trigger: the first consumer integration.
- **Per-tenant and custom domains** — MOTIR-3878, with §4's reversal condition
  as an input. Trigger: planning that story.
- **What an absent capability answers** (404, or a page saying so) — MOTIR-3908.
  Trigger: implementing the gate.
- **The fate of the `motir-marketing` Fly application** — unchanged and staying;
  the earlier plan to retire it belonged to the rejected direction A.

---

## Sources

- `motir-core` `origin/main`, 2026-08-29 — `app/api/public/` (10 routes, one
  session-gated), `app/(public)/{explore,docs,legal,p}` (session-call counts in
  §2), `lib/baseUrl.ts`, `lib/billing/availability.ts`, `lib/apiDocs/`,
  `tests/navigation/proxy-matcher.test.ts`
- `motir-marketing` `origin/main` — `lib/destinations.ts`,
  `app/_components/RootJsonLd.tsx`, `app/sitemap.ts`
- `docs/decisions/marketing-site-hosting.md`, `application-hosting.md`,
  `billing-tiering.md` §6, `public-api-conventions.md`,
  `platform-staff-auth.md` §2
- GitHub Engineering, _Yummy cookies across domains_; the Public Suffix List
- Observed 2026-08-29: `notion.site`, `github.io`, `vercel.app`, `canny.io`,
  `statuspage.io` for tenant content; `vercel.com/docs`, `notion.com/help`,
  `docs.stripe.com` for first-party content

---

## AMENDMENT 1 — the public surface gets its OWN contract, generated by v1's machinery, with its own version and its own document (MOTIR-3946, 2026-08-30)

§3 bound that the public surface **may not stay undescribed** and left one
question open: _does it join the `/api/v1` document, or get its own?_ This
amendment answers it, and records the deprecation policy that makes the answer a
contract rather than a description. The version module
(`lib/api/public/contractVersion.ts`) cites §D of this amendment; §D is the
normative text.

### §A — The decision

**Its own versioned contract, generated by the same machinery as v1.** One
registry of operation declarations per surface, one shared generator:

| Thing            | v1                                 | The public surface                                                              |
| ---------------- | ---------------------------------- | ------------------------------------------------------------------------------- |
| Declaration type | `lib/api/v1/openapi/operation.ts`  | `lib/api/public/openapi/operation.ts`                                           |
| Registry         | `lib/api/v1/openapi/operations.ts` | `lib/api/public/openapi/operations.ts`                                          |
| Emitter          | `lib/api/v1/openapi/emit.ts`       | `lib/api/public/openapi/emit.ts` — reusing v1's `toOpenApiSchema`, nothing else |
| Version          | `V1_CONTRACT_VERSION`              | `PUBLIC_CONTRACT_VERSION`                                                       |
| Published at     | `/api/openapi/v1.json`             | `/api/openapi/public.json`                                                      |
| Security scheme  | bearer token                       | **none, and its absence is the statement**                                      |

Not folded into v1, and not hand-written. A hand-written second document is the
mirror this epic keeps arguing against; it rots on the first change nobody
remembers to copy.

### §B — Why the fold was rejected: three grounds, each measured on `origin/main`

1. **`/api/v1` is authenticated BY CONSTRUCTION.** `withV1Route` takes a
   required `options.permission: PermissionKey` — a route that declares none
   fails MOTIR-1861's guard — runs `authenticateApiToken` as step 1 with a 401
   on failure, and hands its handler a non-optional `userId`, `workspaceId` and
   a `ServiceContext` bound to the token's workspace. Its rate limiter keys
   **per token**, deliberately. `app/api/public/*` is anonymous by design.
   Moving these routes under that prefix means either bypassing the wrapper —
   routes under `/api/v1` that do not behave like v1, against four guards that
   walk `app/api/v1` — or widening a shipped auth contract so it has an
   anonymous mode. The second is **a re-architecture of the API's security model
   to solve a documentation problem.**
2. **The response shapes differ.** Every v1 collection references
   `ListEnvelope` / `RankedListEnvelope` and v1's `errorResponse`; these routes
   return the DTO raw, and `{ code }` on a 404. One document whose operations
   disagree about their envelope is a document that has to explain itself.
3. **The version would lie.** `V1_CONTRACT_VERSION` is stamped on
   `X-Motir-Api-Version` by `withV1Route`. Routes that do not compose the
   wrapper stamp nothing, so a client reading one `info.version` covering both
   surfaces gets the header on half the paths. A version number is a promise;
   one covering two surfaces with different stability is unreadable.

### §C — Rejected alternatives

| Alternative                                                | Why rejected                                                                                                                                                                                                                                                       |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Move the routes to `/api/v1/public/*` and fold them in** | The three grounds in §B. It was investigated first, and it is the option a reader will think of first — which is why it is written down here rather than left to be re-derived.                                                                                    |
| **Hand-write a second document**                           | A copy with no generator drifts silently, and the drift is invisible until a consumer renders an empty page. The whole point of the v1 machinery is that no path, method or schema is written twice.                                                               |
| **Publish nothing and version by convention**              | §3 already rejected it: with a second repository rendering a live site, an unversioned surface makes every shape change a potential blank page on the brand's own website, discovered by a visitor.                                                                |
| **A version HEADER on every public response, now**         | v1 has one because a wrapper already ran on every request. These routes compose no wrapper, so it would mean writing one — and a header nobody consumes yet is a request-path cost for a future reader. Deferred, not refused: §D's promise does not depend on it. |

### §D — The DEPRECATION POLICY (normative)

This is the half that makes the document a contract. It mirrors
`public-api-conventions.md` §8 deliberately — two surfaces with different auth
should not also have different stability rules for a reader to remember.

**Allowed without a MAJOR (additive — MINOR bump):**

- a new operation;
- a new optional query parameter;
- a new field on a response object;
- a new enum value on a field documented as open-ended;
- a raised limit.

**Forbidden without a new MAJOR:**

- removing a field, or renaming one;
- changing a field's type or its nullability;
- removing or re-purposing an error `code`;
- changing the status an existing condition returns;
- tightening a limit;
- making an optional parameter required.

**What a consumer is guaranteed.** For as long as `PUBLIC_CONTRACT_VERSION`
reads `1.x.y`: every operation in the document keeps its path, its method, its
declared response fields with their declared types, and the status it returns
for a condition already described. **The other half of that promise is the
consumer's: it MUST tolerate unknown fields** — additive growth is expected, and
a consumer that rejects an unrecognised key turns an allowed change into an
outage on its own side.

**A MAJOR arrives ALONGSIDE, never in place of.** A `2` is published at its own
path and its own document while `1` keeps answering. The old one is marked
`deprecated: true` in the spec, announced, and kept working for the announced
window. **No field is ever removed as a surprise** — the failure mode this
policy exists to prevent is a visitor finding an empty page, and a visitor
cannot read a changelog.

**And bumping the number is an obligation, not a courtesy.** An additive change
that leaves `PUBLIC_CONTRACT_VERSION` alone makes it lie about the one thing it
exists to report. Unlike v1's, this number is not yet on a response header
(§C), so there is no second reader to catch the omission — which makes the
obligation more load-bearing here, not less.

### §E — The cost, stated as a cost

**Two documents exist, and a reader has to know which one answers their
question.** Somebody adding a public operation must remember a second registry,
and `docs/` now describes two contracts with different auth postures.

That is the honest price of two genuinely different contracts, and it is
smaller than either alternative it was weighed against: an anonymous hole
punched in an authenticated contract (§B1), or a hand-written copy that rots
(§C). The mitigation is that the two documents share their generator, so the
cost is one registry entry — not one document to maintain.

### §F — What ships now, and the measurement that bounds the rest

MOTIR-3946 ships the spine and **three** read operations —
`GET /api/public/p/{identifier}`, `GET /api/public/explore`,
`GET /api/public/categories` — the paths `motir-marketing` needs first, proving
the pipeline end to end.

**Measured 2026-08-30, `app/api/public/`: 11 route files exporting 12
operations** — 8 `GET` reads and 4 writes (`POST` on follow, subscribe and
requests; `DELETE` on follow). So **nine** operations remain after this card,
not the eight MOTIR-3990 was written with; the card is corrected rather than the
count. MOTIR-3990 also owes the totality guard — the check that fails on a route
with no declaration — which is what turns "three are documented" into "all of
them are".

**The drift guard lands with the spine, in this repository**, per §3: each
documented route is called for real with only its service mocked, and its
response is parsed through the `.strict()` schema the document publishes. A
field added to a DTO and returned undeclared fails on the pull request that adds
it, naming the field.

### §G — A THIRD wrong reading of this surface, corrected and then DERIVED

§3's measurement table says `app/api/public/*` is **10 routes, of which exactly
one is session-gated**. Both halves are wrong, and this record has now been
wrong about this surface three times in three different ways — so the fix is not
a fourth count. It is a guard.

**Measured on the merged branch, 2026-08-30, by walking the tree:**

| reading                                         | value                                                                                                                    |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| route FILES under `app/api/public/`             | **11** (the tenth was MOTIR-3945's subject route; the eleventh is `requests/duplicates`, which the earlier count missed) |
| exported operations                             | **12** — `follow` exports POST **and** DELETE                                                                            |
| operations that REFUSE a caller with no session | **4**                                                                                                                    |
| operations callable anonymously                 | **8**                                                                                                                    |

The four gated ones are `POST` and `DELETE …/p/{identifier}/follow`,
`POST …/projects/{projectId}/requests`, and
`GET …/projects/{projectId}/requests/duplicates`.

**Why the earlier reading missed the last two.** It counted calls to
`getSession`. Those two routes gate through `requireCompliantSession`, a
different helper — and one that answers **401 for no session and 403 for an
account held by an unsatisfied two-factor requirement**. Counting one door finds
one door. (The two readings before that counted the string `getSession` and
matched the COMMENTS saying the call is deliberately absent, which is recorded
at §3.)

**What actually distinguishes them** is not which helper a route calls but
whether it REFUSES an anonymous caller: six routes call `getSession` and use the
result as `?? null` for viewer-awareness, which is not a gate.

**So it is derived now, not counted.** Each operation declares
`sessionRequired`, and `tests/api/public/contract-coverage.test.ts` walks the
route tree, reads the refusal out of each route's source, compares it to the
declaration, and pins the totals at four and eight. A fifth gate — or a gate
removed — is a decision somebody states, not a change nobody notices.

**What it changes about the decision: nothing, and that is worth stating.** §4's
conclusion holds _because_ of the cookie, not despite these four: the session
cookie is host-only on `app.motir.co`, so a `motir.co` consumer cannot send it
and cannot invoke those four operations at all. What `motir-marketing` consumes
is the anonymous eight. What it does change is the DOCUMENT — the public
contract declares the 401 on each of the four rather than implying a uniformly
anonymous surface (MOTIR-3990), and declares no security scheme for the precise
reason that there is no credential its reader can present.
