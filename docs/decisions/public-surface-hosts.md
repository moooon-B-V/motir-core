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

| card                                         | what changes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **MOTIR-3945** (the project-subject route)   | **UNCHANGED, and now justified.** §2 records that the subject is the one endpoint the page's own subject lacks.                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **MOTIR-3946** (the versioned contract)      | **BOUND by §3.** It must decide where the contract is published, and it must put the drift guard in `motir-core`'s CI rather than the consumer's.                                                                                                                                                                                                                                                                                                                                                                                                                        |
| **MOTIR-3881** (the origin split)            | **UNCHANGED in substance.** §2 is why one variable can no longer answer both questions. Its fallback-to-the-application-origin arm is what makes the split deployable before anything moves.                                                                                                                                                                                                                                                                                                                                                                             |
| **MOTIR-3932** (the rendering move)          | **BOUND by §3 and §8.** Every read goes through the contract; `/docs` may not be a copied spec.                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **MOTIR-3877** (`/p/*`)                      | **BOUND by §4.** The host-only cookie stops being a property to preserve and becomes an assertion it owns.                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **MOTIR-3908** (the cloud gate)              | **BOUND by §5.** The gate is the capability, including `app/api/public/*` and the publish affordance — not the pages.                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **MOTIR-3909** (`/legal`)                    | **⚠️ SUPERSEDED 2026-09-01 — was UNCHANGED, and is now BOUND by [AMENDMENT 2](#amendment-2--motir-core-keeps-the-legal-mechanism-and-loses-the-content-a-configured-document-manifest-an-absent-unconfigured-surface-and-a-subprocessor-seam-that-fails-on-divergence-motir-4004-2026-09-01).** §2 records why `/legal` MOVES rather than being gated, and that is still right; what this row missed is that `content/legal/*.md` is also an INPUT to the re-consent gate, so the move is a change of SOURCE and not a deletion. AMENDMENT 2 §A carries the measurement. |
| **MOTIR-3910** (redirects and registrations) | **NARROWED, materially.** `motir.co`'s address records already point at the `motir-marketing` Fly app, so **there is no apex repoint and no new certificate.** What remains is the 301s, the external registrations and a live smoke.                                                                                                                                                                                                                                                                                                                                    |
| **MOTIR-3878** (per-tenant addressing)       | **GAINS A QUESTION**: §4's reversal condition. It is where the separate-domain decision is taken.                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| **`marketing-site-hosting.md`**              | **AMENDED** — see the amendment in that file, dated 2026-08-29. Q3 (CI) and Q4 (subprocessor) stand; Q1's _"where the marketing site runs"_ is unchanged for the site itself but no longer describes the whole public surface, and Q2's apex target is now the record of a state that does not change.                                                                                                                                                                                                                                                                   |

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

---

## AMENDMENT 2 — `motir-core` keeps the legal MECHANISM and loses the CONTENT: a configured document manifest, an absent unconfigured surface, and a subprocessor seam that fails on divergence (MOTIR-4004, 2026-09-01)

§7 records MOTIR-3909 as **UNCHANGED**, on the ground that §2 already says
`/legal` moves rather than being gated. That row is superseded by this
amendment, and the reason it was wrong is worth stating before the decisions:
**`content/legal/*.md` is not only rendered copy.** It is an INPUT to the
re-consent gate, and no section of this record had asked what the gate reads
once the files leave.

### §A — The measurement this amendment is built on

Read on `motir-core` `origin/main` `5fb216b21`, 2026-09-01.

| reading                        | command                                                                                                   | result                                                                                                                                     |
| ------------------------------ | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| non-test callers of the loader | `git grep -n "listLegalDocuments\|getLegalDocument" -- ':!lib/legal/documents.ts'`                        | `app/(public)/legal/{page,[slug]/page}.tsx`, **`app/(auth)/re-consent/page.tsx`**, **`lib/services/legalAcceptanceService.ts`**, + 6 tests |
| what `content/` holds          | `git ls-tree origin/main content/ --name-only`                                                            | `content/legal`, and nothing else                                                                                                          |
| the referrer population        | `git grep -l -E "content/legal\|lib/legal\|'/legal\|\"/legal\|legalDocument\|LegalAcceptance\|reconsent"` | 84 files                                                                                                                                   |

**The two RUNTIME entry points are the finding.**
`legalAcceptanceService.recordAcceptance` runs from the Better-Auth
`user.create.after` hook on **every sign-up**;
`legalAcceptanceService.resolveOutstanding` runs from `resolveReconsentHold` in
the `(authed)`, `(onboarding)` and `(planning)` layouts on **every signed-in
page load**. Both call `listLegalDocuments()`, which is a `readdirSync` of
`content/legal/`. The front-matter `version` is what `lib/legal/consent.ts`
reads to decide materiality — which is how `terms.md` §14's promise, _"we will
not treat silence as agreement to a material change"_, is actually kept.

**So the naive removal fails SILENTLY, and every layer is deliberately built to
let it.** `recordAcceptance` carries an explicit _"NO EMPTY-SET GUARD HERE,
DELIBERATELY"_; `createMany` returns 0 for an empty batch without touching the
database; `outstandingReconsent` answers `[]` for an empty document list; and
`app/(auth)/re-consent/page.tsx` branches on `terms ? … : null`. Each of those
is correct on its own terms and documented. Composed, they mean a deployment
with no documents records no acceptances and holds nobody — with no error, no
exception and no red test.

### §B — The rung-1 reading, which is where this amendment started

`plan-rules/core.md`'s decision-authority ladder puts the mirror product above
everything except shipped reality, and a remembered claim is not a check. Four
open-core products were read on 2026-09-01, in their own repositories:

| product        | does the VENDOR's policy TEXT ship in the open repo?                                         | what a SELF-HOSTED install links to                                                                                                          |
| -------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| **Mattermost** | **No.** `SupportSettings.TermsOfServiceLink` / `PrivacyPolicyLink` are per-deployment CONFIG | the operator's URL — but the shipped **DEFAULT is the vendor's own**, `https://mattermost.com/pl/terms-of-use/`                              |
| **Plane**      | **No.** Two **hardcoded** absolute URLs in one shared sign-up component                      | `https://plane.so/legals/{terms-and-conditions,privacy-policy}`, unconditionally, for every self-hoster                                      |
| **Sentry**     | **No.** `https://sentry.io/privacy/` is linked from ONE screen                               | the vendor's policy — correctly, because that screen is the self-hosted telemetry-beacon consent, a feature Sentry Inc. itself operates      |
| **GitLab**     | **No.** No policy directory at the repository root                                           | `about.gitlab.com/terms` cited in SUBSCRIPTION documentation — i.e. in prose about buying from the vendor, not as the deployment's own terms |

**Unanimous on the thing this story is doing: none of the four ships the
vendor's policy text in the tree.** That is the strongest support this record
can have for the removal, and it is a measurement rather than an intuition.

**They differ from us on Q2, and the record answers that rather than omitting
it.** Mattermost DEFAULTS an unconfigured deployment to the vendor's own terms;
Plane hardcodes them. Our Q2 below is stricter than both. The ladder's rule is
that a deviation from the mirror needs a concrete reason — and here it is the
mirrors themselves: **Plane's shipped behaviour is precisely the defect
MOTIR-3909 exists to remove**, a self-hoster's own sign-up page telling their own
employees they agree to another company's Terms. Mattermost's default is the
same shape with a settings page in front of it. Copying either would move
moooon's contract text out of the tree and leave moooon's contract _link_ in it.

**And Mattermost supplies the positive precedent for Q1**, which is the more
useful half: `CustomTermsOfServiceEnabled` plus
`SupportSettingsDefaultReAcceptancePeriod = 365` is a shipped product in which
**the operator supplies the terms and the PRODUCT supplies the mechanism and the
re-acceptance clock**. That is exactly the shape decided below, in a comparable
product, already in production.

### §C — Q6: what does `motir-core` read once `content/legal/` leaves?

#### The decision

**A CONFIGURED LEGAL-DOCUMENT MANIFEST.** `lib/legal/documents.ts` keeps its
purpose and changes its SOURCE, from the filesystem to configuration.

| field           | type             | meaning                                                                                               |
| --------------- | ---------------- | ----------------------------------------------------------------------------------------------------- |
| `slug`          | `string`         | the document's stable identifier — what an acceptance row is keyed on, and what `consent.ts` matches  |
| `title`         | `string`         | the human name, rendered on the re-consent row                                                        |
| `version`       | `string`         | semver, verbatim. **The load-bearing field**: `consent.ts` reads its components to decide materiality |
| `effectiveDate` | `string \| null` | when it comes into force, or `null` while not yet set — the existing `null` contract, unchanged       |
| `changeSummary` | `string \| null` | one sentence on what moved, or `null`. Already a supported null (the design names the degraded form)  |
| `url`           | `string`         | the **absolute** URL of the published document, on whatever host the operator publishes               |

**`body` GOES**, and that is what makes this a source swap rather than a
redesign: **no surviving caller reads it.** The two pages that did are leaving.

**The shape is ONE environment variable holding a JSON array —
`MOTIR_LEGAL_DOCUMENTS` — and the array's ORDER is authoritative.**

- One variable, because the consumer is `fly secrets set` (the hosted
  deployment) or a single line in a self-hoster's env. A config module read from
  a committed file would put a _file_ back in the repository, which is the thing
  being removed; a per-document variable set makes seven documents seven
  secrets and makes "which documents exist" unanswerable without enumerating
  variable names.
- **The order is the operator's**, so `PREFERRED_ORDER` and `byPreferredOrder`
  are REMOVED rather than kept. The constant existed because a directory listing
  has no order. An authored array does, and a hardcoded list in the open product
  re-sorting an operator's manifest imposes moooon's document ordering on every
  self-hoster — a smaller instance of exactly what this story is undoing.

**Downstream is unchanged in shape.** `lib/legal/consent.ts` stays pure and keeps
`RECONSENT_DOCUMENT_SLUGS` closed at three; `legalAcceptanceService` keeps its
read-at-call-time contract (its no-cache argument holds a fortiori — parsing a
string is cheaper than the `readdirSync` it replaces); `reconsentGate` is
untouched.

#### Validation — and this is the half that can make the gate WRONG rather than absent

`parseSemanticVersion` returns `null` for a version it cannot read, and
`isMaterialChange` then answers **true**. So a single typo in a manifest entry
does not degrade to _absent_ — it holds **every signed-in reader** at
`/re-consent`, on a screen they cannot clear, across the whole product.

**DECIDED: an entry that does not validate is REJECTED — it never reaches
`listLegalDocuments()` — AND the rejection is LOUD.** Loud means three things,
and the third is the one that matters:

1. it logs at error level, naming the offending `slug` (or its index) and the
   field that failed;
2. the deployment's health / preflight surface reports the manifest as
   **faulted**, not as unconfigured — _unconfigured_ and _misconfigured_ must
   never render as the same state;
3. **a rejected entry whose `slug` is in `RECONSENT_DOCUMENT_SLUGS` is a
   separately named condition**, because that is the case where the gate quietly
   stops asking for a document it is supposed to gate on.

| Alternative                                                           | Why rejected                                                                                                                                                                                                                                                                              |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Refuse to boot on a malformed manifest**                            | A typo in a legal-copy value must not be able to take sign-in down. It makes the blast radius of editing a version string the entire application, and the operator most likely to make the edit is the one least able to roll it back.                                                    |
| **Let the malformed entry through and let `isMaterialChange` decide** | It answers `true` for an unparseable version — by design, and rightly, since an unreadable version is one whose materiality nobody can rule out. But that arm was written for a version in a file we control; applied to operator input it converts a typo into a total signed-in outage. |
| **Reject silently and treat as unset**                                | This is the failure the whole story exists to prevent, arrived at from the other side: a legal gate that stops holding people, with nothing to see. The rejection is right; the SILENCE is what is rejected here.                                                                         |
| **Reject the WHOLE manifest when any entry is bad**                   | One malformed optional document would disable the gate for the three that govern it. Per-entry keeps the failure proportional to the fault.                                                                                                                                               |

### §D — Q7: what does an UNCONFIGURED build do?

#### The decision

**Nothing legal renders, and nobody is held. The surface is ABSENT, not
degraded** — the same line §5 draws for public projects, one document over.

| surface                  | with `MOTIR_LEGAL_DOCUMENTS` unset                                                                                                                        |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **sign-up notice**       | **ABSENT.** The whole `<p>` does not render. **Not re-flowed to plain text** — see below                                                                  |
| **the rail's Legal row** | **ABSENT.** `SidebarNav`'s bottom section renders without it, exactly as it renders without any other row it is not given                                 |
| **the re-consent rows**  | **UNREACHABLE.** `outstandingReconsent` answers `[]`, so nothing holds anybody and the screen is never rendered. Reached directly, it has no rows to draw |
| **the re-consent gate**  | **HOLDS NOBODY**, and stays `MOTIR_CLOUD`-gated — see below                                                                                               |
| **acceptance recording** | **WRITES NOTHING**, which is correct: there is no document to record an acceptance of                                                                     |

**⚠️ AMENDED 2026-09-02 (MOTIR-4010) — what the rail row points at when it IS
configured, which this section left open.** The table above answers the
unconfigured arm, and §C's field set is per-DOCUMENT, so the manifest carries no
index url — while the rail row is a door to the SET rather than to a document.
The gap was found by building it.

**DECIDED: the index is DERIVED from the urls the operator already supplied — if
every configured url is `<base>/<slug>`, the index is `<base>` — and where that
does not hold the row is ABSENT rather than guessed.** It holds for the hosted
arrangement (`https://motir.co/legal/<slug>`) and for any operator who publishes
a document set at one place, which is what having an index means. An operator
publishing at unrelated addresses — `acme.com/terms-of-service`,
`legal.acme.com/privacy` — genuinely has no index for the row to point at, and
sending a reader to an invented one is worse than sending them nowhere. Sign-up
and the re-consent rows still link each document directly, so nothing becomes
unreachable; what is missing is a single door, which is exactly what is missing
in reality. `lib/legal/links.ts`'s `legalIndexUrl()` is the implementation, and
`tests/legal/legalLinks.test.ts` pins both arms.

| Alternative                                         | Why rejected                                                                                                                                                                                                                                                                                                                         |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Add an `indexUrl` to the manifest**               | The cleanest answer, and it needs a SHAPE change: the manifest is a JSON array, so an index would make it an object. That widens the operator's configuration and re-opens a contract §C settled, for a row derivable from data they already supply. Worth revisiting if a second set-level value ever appears — one is not a shape. |
| **Point the row at the first document**             | It is a door to the SET. Landing a reader on the Terms when they asked for _Legal_ is a wrong answer wearing a right one.                                                                                                                                                                                                            |
| **Keep the row pointing at the old `/legal` route** | That route is deleted by the story after this one, so the row would 404 by design.                                                                                                                                                                                                                                                   |
| **Drop the rail row entirely**                      | It is a shipped affordance and the hosted arrangement has a perfectly good index. Removing it for every operator to avoid deriving it for some is the wrong trade.                                                                                                                                                                   |

**⚠️ The sign-up notice is ABSENT rather than re-flowed, and this reverses the
form MOTIR-3909 was authored with.** The string is
`legal.signUpNotice` — _"By creating a Motir account you agree to our
`<terms>`Terms of Service`</terms>` and `<privacy>`Privacy Policy`</privacy>`."_
The entire sentence is ABOUT the two documents. Rendering it with the anchors
turned into plain text does not produce a weaker notice; it produces a **false
one** — an assertion that the reader has agreed to documents that do not exist
and that nobody has published. A self-hoster running Motir for their own team
has no Terms of Service, and the honest sign-up form is one that does not claim
otherwise.

It is also the cheapest form available: it needs **no new copy string and no
`zh` twin**, so there is no new catalogue key to keep in parity. `signUpNotice`
survives, unchanged, for the configured case.

> **Consequence for three sibling cards, applied here rather than left as
> prose** (`plan-rules`' _a decision recorded beside a card does not re-scope the
> card_): MOTIR-3909's verification recipe, MOTIR-4006's design and MOTIR-4015's
> E2E were each written for _"re-flows without its two links"_ / _"reads as a
> finished sentence"_. Those clauses are amended on their own cards in the same
> pass that writes this record. A record that decides one thing while three
> cards instruct a runner to build another is a record nobody follows.

**And the gate stays `MOTIR_CLOUD`-gated — DECIDED here, not deferred.**
`isMotirCloud()`'s own comment says it answers _"is moooon B.V. the counterparty
to these documents?"_. A configured manifest does not answer that question: an
operator who publishes their own terms has not thereby acquired moooon's
re-consent semantics, its thirty-day DPA objection window or its §14 materiality
promise. Widening it is a product decision this record explicitly does not make
and does not owe a follow-up card, because nothing in MOTIR-3909 depends on it.

| Alternative                                                      | Why rejected                                                                                                                                                                                                    |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Default the manifest to moooon's published URLs** (Mattermost) | It is §B's own finding: it moves the TEXT out of the tree and leaves the LINK in it, so every self-hoster still points their users at another company's contract. The problem was never where the bytes render. |
| **Render the notice as plain text with no links** (as authored)  | A statement that a reader agrees to documents nobody published. A weaker link is a degradation; an unlinkable claim is a false one.                                                                             |
| **Ship a second "no legal documents configured" string**         | A sign-up form is not the place to tell a user about the operator's configuration. It also buys a new key in two catalogues, with a `zh` twin to keep in parity, to say something no reader needs.              |
| **Point the unconfigured build at a generic template**           | There is no such document, and inventing one would be moooon drafting terms on behalf of a stranger's deployment.                                                                                               |

### §E — Q8: where does the subprocessor guard's evidence live?

`tests/legal/subprocessor-list-guard.test.ts` holds
`content/legal/{subprocessors,model-providers}.md`'s vendor rows against
**`motir-core`'s own** `package.json` dependencies and the outbound host
literals in `lib/` and `app/` (`tests/helpers/subprocessorRegistry.ts`'s
`VENDOR_SIGNATURES`). **The page moves; the evidence cannot.** Deleting the
guard is not available: its own header records the page going stale FOUR times
on 2026-08-26/27, each caught by a person who happened to look.

#### The decision

**Split it at the repository line, and give each half to the repository that
owns the thing it measures — which is §3's rule (_the guard belongs in the
PRODUCING repository_) applied per side.**

| half                | lives in          | asserts                                                                                                                              | fires when                                                            |
| ------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| **the MEASUREMENT** | `motir-core`      | the committed **egress manifest** still equals what the tree measures — dependencies and outbound hosts, through `VENDOR_SIGNATURES` | somebody adds a dependency or an outbound host and does not update it |
| **the DISCLOSURE**  | `motir-marketing` | every vendor row on its `subprocessors.md` / `model-providers.md` has a manifest entry, **and every manifest entry has a row**       | the published page and the software's actual egress disagree          |

**The `motir-core` half is the load-bearing one**, and it is why the split is
this way round rather than the reverse. It fires **on the pull request that adds
the dependency, in the repository that added it, before it ships** — which is
instance 3's exact shape, preserved whole. A guard that lived only in the
consumer would report that `motir-core` broke a published legal page after it
had already shipped: §3's smoke alarm in the wrong building.

**The manifest is a COMMITTED artifact in `motir-core`, SERVED at a versioned
public path, and FETCHED by the consumer.** It carries only what the guard can
actually see — the vendor name and the evidence that makes it live (the package,
the host). It carries **nothing** about transfer bases, regions or the deployed
platform: the existing guard's header already records that those need a
credential CI does not have and a judgement CI cannot make, and putting them in
a machine-checked artifact would license exactly the belief that let instance 3
through.

#### The transport, and the coupling this record is required to state

**MOTIR-3909's Q3 asks the same question §8's cost 3 raised for `/docs`, and the
answer must be the same one or one of the two records is wrong. It is the same
one.** MOTIR-3932 answered `/docs` in MOTIR-4046, and the answer is shipped and
readable:

- `motir-marketing` `lib/docs.ts` fetches `${APP_ORIGIN}/api/openapi/v1.json`
  fresh, with the comment _"This repository consumes that published artifact
  rather than copying a spec that would drift"_;
- `motir-marketing` `tests/docs/docs.test.ts` asserts **structurally** that the
  source fetches the published URL and that **no copied artifact is committed**
  (`existsSync('content/docs') === false`).

**So: a SERVED, VERSIONED artifact the consumer FETCHES — never a committed
copy — and a repository-local guard that the consumption is still of the
published artifact.** The egress manifest takes the same transport and the same
guard shape. §8's sentence governs both: _a published artifact `motir-core`
emits and the consumer installs does not rot; a copied spec does._

**The requirement this record imposes is the PROPERTY, not the transport: the
seam must FAIL when the two sides diverge.** A copy with no drift check does not
satisfy it, whatever else is true of it.

#### ⚠️ The cost, stated as a cost: the seam is TWO failures, not one, and there is a window between them

A new vendor turns `motir-core`'s guard red on the pull request that adds it.
Updating the manifest turns it green — and the published page is still wrong
until `motir-marketing`'s own CI runs and somebody edits the page. **That window
is real and this record does not close it**, because closing it would mean one
repository's CI blocking on another's, which is the coupling the whole split
exists to avoid.

What it does instead: **`motir-core`'s guard failure message NAMES the page and
the repository**, so the person holding the red check is told where the other
half is. That is a mitigation, not a fix, and it is written here as a cost so
that nobody later reads a green `motir-core` build as evidence that a published
legal document is accurate.

| Alternative                                                         | Why rejected                                                                                                                                                                                                                            |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Move the whole guard with the page**                              | It would measure a marketing website's dependency tree against a disclosure about the application — passing for ever, on evidence that has nothing to do with the software the page is about. This is the cheap answer and it is a lie. |
| **Delete the guard**                                                | The page went stale four times in two days while a person was watching. Not available for a document an auditor reads.                                                                                                                  |
| **Commit a copy of the manifest into `motir-marketing`**            | Rejected by §8 and by MOTIR-4046's shipped answer for the same class of artifact. A copy with no drift check is the failure mode, and a copy WITH one needs the fetch anyway.                                                           |
| **Keep both halves in `motir-core` by fetching the published page** | Inverts the direction: `motir-core`'s CI would depend on a live marketing site, and a red build in the producing repository would be caused by a change in the consumer.                                                                |

### §F — What this amendment changes about §7

**§7's `MOTIR-3909` row is SUPERSEDED.** It read **UNCHANGED**, and it was
written before anyone had asked what the re-consent gate reads once
`content/legal/` leaves. The row now reads **BOUND by this amendment**, and the
table above carries it.

### §G — What this amendment deliberately does NOT decide

- **Whether the re-consent gate should ever be available to a self-hoster.**
  §D keeps it `MOTIR_CLOUD`-gated with its reason. No card is owed.
- **The `motir-marketing` page's layout or copy.** MOTIR-3932's, and shipped.
- **How the egress manifest is generated** (a script, a test fixture, a build
  step) — MOTIR-4008's, within the property §E requires.
- **The manifest's own versioning.** It is an internal artifact between two
  repositories under one owner, not a public contract with third-party readers;
  if it ever gains one, AMENDMENT 1 §D is the policy to copy.

### Sources

- `motir-core` `origin/main` `5fb216b21`, 2026-09-01 — `lib/legal/documents.ts`,
  `lib/legal/consent.ts`, `lib/legal/reconsentGate.ts`,
  `lib/services/legalAcceptanceService.ts`, `lib/billing/availability.ts`,
  `app/(auth)/sign-up/_components/SignUpCard.tsx`,
  `app/(authed)/_components/SidebarNav.tsx`,
  `tests/legal/subprocessor-list-guard.test.ts`,
  `tests/helpers/subprocessorRegistry.ts`, `messages/{en,zh}.json`
- `motir-marketing` `origin/main` — `lib/docs.ts`, `tests/docs/docs.test.ts`,
  `content/legal/` (the seven documents, shipped by MOTIR-3932)
- Mattermost — https://github.com/mattermost/mattermost/blob/master/server/public/model/config.go
  (`SupportSettingsDefaultTermsOfServiceLink`, `SupportSettings.TermsOfServiceLink`,
  `SupportSettingsDefaultReAcceptancePeriod`); `CustomTermsOfServiceEnabled` in
  https://github.com/mattermost/mattermost/blob/master/webapp/channels/src/components/admin_console/custom_terms_of_service_settings/custom_terms_of_service_settings.tsx
- Plane — https://github.com/makeplane/plane/blob/preview/apps/web/core/components/account/terms-and-conditions.tsx
  (hardcoded `https://plane.so/legals/*`)
- Sentry — https://github.com/getsentry/sentry/blob/master/static/app/views/beaconConsent/index.tsx
  (`https://sentry.io/privacy/`, on the self-hosted beacon consent screen)
- GitLab — no policy directory at the repository root of
  https://github.com/gitlabhq/gitlabhq ; `about.gitlab.com/terms` appears only in
  subscription documentation (`doc/subscriptions/*`)
- `docs/decisions/legal-document-set.md` §7 (the seven-document set),
  `billing-tiering.md` §6 (`MOTIR_CLOUD` is explicit, never inferred)

---

## AMENDMENT 3 — the subprocessor seam gets the assertion neither half makes: a LIVE comparison, on the deploy and on a schedule, red when it cannot be checked (MOTIR-4139, 2026-09-02)

AMENDMENT 2 §E split the subprocessor guard at the repository line and stated the
binding requirement as a PROPERTY rather than a pipe: **the seam must FAIL when
the two sides diverge.** Both halves then shipped — and the property did not.

| half                                                     | what it actually asserts                                                   | shipped    |
| -------------------------------------------------------- | -------------------------------------------------------------------------- | ---------- |
| `motir-core` `tests/legal/egress-manifest-guard.test.ts` | the manifest matches **that tree's** signatures, both directions           | MOTIR-4008 |
| `motir-marketing` `tests/legal/subprocessorSeam.test.ts` | the **parse** against the real pages, and the comparison **from fixtures** | MOTIR-4011 |

One proves the manifest describes its own tree. The other proves the comparison
**would** report a divergence if it were handed one — not that there is none.
**Compose them and nothing anywhere compares the published page against the
manifest `motir-core` is actually serving.** A vendor could be added to
`motir-core`'s tree, land in its manifest, turn that repository's guard green,
and never appear on the published page, with both suites green throughout —
which is the state the whole mechanism was created to end.

Neither card was wrong to stop where it did. MOTIR-4011's lane is offline by
design, and the only way to compare the two sides from a test is to fetch a live
deployment — the coupling §E's split exists to avoid. Choosing between the ways
out of that is an architecture decision, and making it inside a test card would
have been deciding it by accident.

### §A — The decision

**One mechanism, TWO TRIGGERS.** `motir-marketing` gains a lane
(`pnpm test:seam`, `vitest.seam.config.mts` → `tests/seam/`) that fetches the
served manifest and compares it with the real pages — no fixture on either side —
and that lane is triggered from exactly two places:

| trigger                                                   | the question it answers                                                              | what it bounds                                                               |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| **the DEPLOY job** (`ci.yml`, a `needs` gate on `deploy`) | _are we about to publish a page that disagrees with the manifest motir-core serves?_ | what this repository PUBLISHES — the site cannot deploy while it is lying    |
| **a daily SCHEDULE** (`subprocessor-seam.yml`)            | _has the manifest changed under a page we already published?_                        | how long a divergence introduced by the OTHER repository can stand unnoticed |

**They are not alternatives, and shipping one would have been the mistake.** The
deploy gate is structurally blind to the second question: `motir-core` can add a
dependency, update its manifest, turn its own guard green and deploy without this
repository building anything at all, and the gate will not run again until
somebody happens to land an unrelated change here. That is **precisely the
two-failure window §E already writes down as a cost**, and the schedule is what
bounds it — to roughly a day.

**The transport is unchanged and was not this card's to choose.** §E decided _a
SERVED, VERSIONED artifact the consumer FETCHES — never a committed copy_, and
this consumes exactly that (`motir-marketing` `lib/legal/liveSeam.ts`), the same
shape `lib/docs.ts` uses for the OpenAPI document. No copy of the manifest is
committed in `motir-marketing`; a test there asserts it, as MOTIR-4046's does for
the spec.

### §B — Where it may be triggered from, which is the load-bearing half

**NEVER on `pull_request`.** The seam lane reaches `app.motir.co`, so running it
on pull requests would turn unrelated pull requests in `motir-marketing` red
whenever `motir-core` restarts — the cross-repository CI coupling §E's split
exists to avoid, re-introduced through the back door by the very card sent to
close §E's gap.

Three things hold that line, and the redundancy is deliberate because the
tempting simplification is one line of YAML:

1. `vitest.config.mts` **excludes** `tests/seam/**`, so the default `Test` job
   cannot pick it up by growing a glob;
2. the `ci.yml` job carries an `if` that **mirrors `deploy`'s exactly**, so the
   two skip together on a pull request;
3. both files carry the reason at the point of the exclusion, because a lane
   excluded without one gets folded back in by the next person tidying configs.

**`ci.yml`'s header note about having no path filtering is unaffected.** That
note is about `design-guards` being reached by every diff, and it still is; this
is an EVENT condition on one job, not a path filter.

### §C — What an UNREACHABLE manifest does: it FAILS. It is never skipped.

Required by the card, and the answer is the strict one.

A fetch that fails is reported as **UNREACHABLE** and exits non-zero, in both
lanes, after four attempts five seconds apart. The retries are for a transient
deploy window — `motir-core` restarts on its own releases — not for an outage.

**The rejected arm is the comfortable one:** pass when the fetch fails, so a
`motir-core` outage never blocks a `motir-marketing` release. That arm publishes
a legal representation nobody checked **and reports success**, and in the log it
is indistinguishable from a check that ran and agreed. Not being ABLE to verify a
disclosure is not permission to publish it.

**UNREACHABLE and DIVERGED are rendered distinctly**, because they send a reader
to different places: DIVERGED names the vendors and which side each is missing
from, UNREACHABLE names the URL and says in as many words that it is _not_
evidence about whether the pages are correct. A **shape** error — the document
arrived and could not be read — is reported as UNREACHABLE with its reason,
since the consequence for a reader is the same: the seam was not checked.

**And an empty vendor list is a shape error, not an empty manifest.** A
serialization change in `motir-core` would otherwise arrive as _"the manifest
names nobody"_, and the seam would report every disclosed vendor as un-evidenced
— a red check blaming the wrong repository — or a GREEN one if the page-side
parse broke in the same window.

### §D — Rejected alternatives

| Alternative                                                             | Why rejected                                                                                                                                                                                                                                                                                                                                              |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Fetch inside the existing `pnpm test` suite**                         | The cheapest change and the one §E forbids: every pull request in `motir-marketing` would then depend on `app.motir.co`'s uptime. A check that goes red for reasons unrelated to the diff is a check that gets disabled.                                                                                                                                  |
| **Fetch in the `/legal/subprocessors` PAGE RENDER, failing the render** | Puts a legal document behind another deployment's availability at READ time — a privacy reviewer gets an error page when the app restarts. The disclosure must stay readable even when the check cannot run.                                                                                                                                              |
| **Publish the manifest as an INSTALLED npm artifact instead**           | Would give CI the manifest with no network, and §8's _"a published artifact the consumer installs does not rot"_ applies literally. But it CHANGES §E's decided transport, adds a package publish and a version to keep current for one JSON file, and re-introduces staleness as _"which version is pinned?"_. The fetch already satisfies the property. |
| **The scheduled check ALONE, with no deploy gate**                      | Reports after the divergence has shipped. For a published legal representation the window between publishing and noticing is the one that matters.                                                                                                                                                                                                        |
| **The deploy gate ALONE, with no schedule**                             | Blind to a divergence `motir-core` introduces after our last release — §E's own two-failure window, left open.                                                                                                                                                                                                                                            |
| **Auto-file a GitHub issue from the scheduled run**                     | Needs `issues: write`, a dedup key and a close path — three moving parts guarding a once-a-day check whose resolution is a two-repository judgement a person makes by hand. A failed scheduled run already notifies the repository owner. If that proves insufficient, it is a card, not a quiet addition.                                                |

### §E — What this changes about AMENDMENT 2 §E

**Its cost note stands, narrowed.** §E says the two-failure window "is real and
this record does not close it", because closing it would mean one repository's CI
blocking on another's. That remains true and this amendment does not close it
either — **it BOUNDS it**, to about a day, without adding the coupling.

So the sentence §E asks nobody to misread is still the operative one, with one
word changed: a green `motir-core` build is not evidence that a published legal
document is accurate, and neither is a green `motir-marketing` pull request. What
IS evidence is the seam lane's last run — and it now exists, names its own
staleness, and goes red when it cannot speak.

### §F — What this amendment deliberately does NOT decide

- **The cadence.** Daily, on the argument that the window it bounds is measured
  in days. Tightening it buys nothing until somebody has been paged by it.
- **What `motir-core` does about a divergence.** Nothing changes on that side:
  its guard is correct and complete about its own tree, and this card did not
  touch it.
- **Whether the marketing site should also verify the manifest at BUILD time**
  (as distinct from in the deploy gate). The gate runs on the same commit and
  the same origin the release is built against, so a build-time fetch would
  measure the same thing twice while making `next build` depend on the network.

### Sources

- `motir-core` `origin/main` `8d80ac8db`, 2026-09-02 —
  `lib/legal/egress-manifest.json`, `lib/legal/egressManifest.ts`,
  `app/api/legal/egress-manifest/route.ts`,
  `tests/legal/egress-manifest-guard.test.ts`
- `motir-marketing` `origin/main` `031befd` — `lib/legal/subprocessorSeam.ts`,
  `tests/legal/subprocessorSeam.test.ts`, `lib/docs.ts`,
  `tests/docs/docs.test.ts`, `.github/workflows/ci.yml`, `vitest.config.mts`
- `GET https://app.motir.co/api/legal/egress-manifest` → `200`,
  `version: 1`, 21 vendors, 2026-09-02 — the artifact this seam consumes,
  obtained as its consumer
