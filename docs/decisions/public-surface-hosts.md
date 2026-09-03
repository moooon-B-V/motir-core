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

> ⚠️ **AND THAT SENTENCE IS SCOPED TO THIS DECISION — it is not a general
> statement about the tenant namespace.** It holds because the only thing served
> at `*.<base>` under §2 is a public project page whose customer-authored
> Markdown **cannot execute script**: `motir-marketing` renders it with
> `react-markdown` + `remark-gfm` and NO `rehype-raw`, so raw HTML is escaped and
> `javascript:` hrefs are stripped by the default URL transform (measured
> 2026-09-03 — zero `script`, `iframe` and `img` elements from hostile input).
> With no script on a tenant host there is no way to set a cookie at the base
> domain, which is the entire class a listing defends.
>
> **THE MOMENT ANYTHING ON `*.<base>` CAN RUN CUSTOMER CODE, THE REFINEMENT
> BECOMES A PREREQUISITE** — cookies are DOMAIN-scoped, not origin-scoped, so one
> tenant's script could set `Domain=<base>` and every other tenant would receive
> it. The same-origin policy does not cover this and no application-level fix
> does either. **MOTIR-4213 carries the mechanism, the lead time and the entry
> conditions**; the point to note here is that the listing must be MERGED AND
> SHIPPING IN BROWSERS before such a surface serves its first request, and that
> is months of other people's release cadence, not ours.
>
> This note records a CONDITION, not a plan: no decision to host customer code on
> `*.<base>` is taken here or anywhere else in this record.

---

## §5 — Q4: what a SELF-HOSTED build serves

### The decision

**Public projects are a CLOUD capability. With `MOTIR_CLOUD` false the feature is
ABSENT, not hidden.** Self-hosting is a team doing project management for
itself — single-tenant, with no directory of anybody else's work and nothing
published to strangers.

| path                     | self-hosted build (`MOTIR_CLOUD` unset)                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/explore`, `/p/*`       | **not served by `motir-core` at all** — the rendering lives in `motir-marketing`, which is moooon's site and is not shipped to self-hosters                                                                                                                                                                                                                                                   |
| `app/api/public/*`       | **absent.** The routes do not answer. This is the capability gate, and MOTIR-3908 owns it                                                                                                                                                                                                                                                                                                     |
| the publish affordance   | **absent.** A project cannot be made public                                                                                                                                                                                                                                                                                                                                                   |
| `/legal`                 | gone from the repository; `motir-core` renders legal links from configuration, unset by default                                                                                                                                                                                                                                                                                               |
| `/docs`                  | ~~**present.** It describes the software, and a self-hoster needs documentation for their own build~~ **⚠️ AMENDED 2026-09-02 (MOTIR-4167): the route is GONE** (MOTIR-3951 deleted `app/(public)`), and the rail's `Docs` row renders from configuration — `MOTIR_DOCS_URL`, an absolute url, unset by default — exactly as the `/legal` row above does. AMENDMENT 2 §D carries the decision |
| everything authenticated | unchanged                                                                                                                                                                                                                                                                                                                                                                                     |

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
| **MOTIR-3877** (`/p/*`)                      | **BOUND by §4 and by [AMENDMENT 4](#amendment-4--what-becomes-of-ps-session-aware-affordances-once-the-page-is-cross-origin-from-the-session-three-mechanisms-and-no-credential-crosses-motir-4108-2026-09-02).** The host-only cookie stops being a property to preserve and becomes an assertion it owns — and AMENDMENT 4 decides, per affordance, what the page does once no credential can cross to it.                                                                                                                                                             |
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

**⚠️ AMENDED 2026-09-02 (MOTIR-4167) — the rail's `Docs` row, which lost its
destination to the same split and was left pointing at it.** `/docs` left this
repository with MOTIR-3951 and is rendered on `motir.co` by `motir-marketing`
(MOTIR-4046); the rail row beside `Legal` kept a hard-coded app-relative path, so
a signed-in reader who clicked **Docs** got a 404. Measured 2026-09-02:
`app.motir.co/docs` → **404**, `motir.co/docs` → **200**. The `Legal` row had
already been rebuilt around a nullable resolver (above), and this row takes the
same shape — found by drawing the section (MOTIR-4130), when the address guard
refused the row's own href.

**DECIDED: the row reads `MOTIR_DOCS_URL` — ONE environment variable holding the
ABSOLUTE url of the published documentation — through `lib/docs/links.ts`'s
`docsIndexUrl()`, and it is ABSENT when that is unset or is not an absolute
`http(s)` url.** It is the contract §C gives every legal document's `url`, one
surface over: absolute, because it is no longer a page this application serves;
operator-supplied, because where the documentation is published is the
operator's arrangement and not this repository's; nullable, with `null` the
unconfigured build and the row absent rather than dead. The hosted deployment
sets it to `https://motir.co/docs`; a self-hoster may point it at that same public
documentation, at a mirror of their own, or leave it unset and have no row. A
relative value is REFUSED and logged at error level naming the variable, never
rendered, because a relative path is precisely the defect this amendment
removes. `tests/docs/docsLinks.test.ts` pins both arms and the refusal;
`tests/components/SidebarNav-docs-door.test.tsx` pins the row;
`design/shell/rail-bottom-section.mock.html` draws both arms.

| Alternative                                                                 | Why rejected                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Derive it from `MOTIR_PUBLIC_SITE_URL`** (`publicSiteOrigin()` + `/docs`) | Three reasons, any one sufficient. That accessor FALLS BACK to the application origin while unset — its ordering guarantee (MOTIR-3881) — so on today's production it would answer `https://app.motir.co/docs`, the very 404 being removed. It must stay unset until THE CUTOVER (MOTIR-3910), so the row would stay absent for as long as that takes while `motir.co/docs` is live. And `tests/hosting/appUrlSeam.test.ts` asserts that variable has exactly ONE reader. |
| **Derive it from `MOTIR_MARKETING_ORIGIN`**                                 | It is a CORS allowlist for one POST receiver — comma-separated, possibly several origins — answering _who may call `/api/idea-draft`_. One variable per question is this repository's own rule (`lib/publicProjects/urls.ts`); reading a navigation target out of a security setting couples the two for ever.                                                                                                                                                            |
| **Hard-code `https://motir.co/docs`**                                       | §B's finding, one surface over: the open product would send every self-hoster's users to moooon's site as if it were theirs. The `Legal` row rejected the same default above (_Default the manifest to moooon's published URLs_).                                                                                                                                                                                                                                         |
| **Keep the app-relative path and add a redirect**                           | The redirect off `app.motir.co` is MOTIR-3910's, and the row would still be a door that works only by bouncing; the _keep the old route_ alternative above applies verbatim.                                                                                                                                                                                                                                                                                              |
| **Put the documentation url in the legal manifest**                         | The manifest is a per-DOCUMENT array of legal documents; documentation is not one, and the `indexUrl` alternative above already rejected widening it for a set-level value.                                                                                                                                                                                                                                                                                               |
| **Drop the row**                                                            | The same trade the `Legal` row refused: a shipped affordance with a perfectly good hosted destination, removed for every operator to avoid configuring it for some.                                                                                                                                                                                                                                                                                                       |

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

---

## AMENDMENT 4 — what becomes of `/p/*`'s session-aware affordances once the page is cross-origin from the session: three mechanisms, and no credential crosses (MOTIR-4108, 2026-09-02)

§9 lists four things this record deliberately does not decide. **This was not one
of them, and it was not decided either** — it was simply open, which is the worse
of the two states, because a question named as undecided has a trigger and an
owner and an open question has neither. MOTIR-3877's own body says the ADR
resolves it. It does not, and this amendment is that resolution.

> **⚠️ THIS IS AMENDMENT 4, AND THE CARD THAT ORDERED IT SAID AMENDMENT 2.**
> MOTIR-4108 was authored on 2026-09-01 against a file whose last amendment was
> AMENDMENT 1. **The ordinal moved TWICE while this one was being written.**
> MOTIR-4004's AMENDMENT 2 merged at `8d80ac8db`, between the authoring and the
> run; MOTIR-4139's AMENDMENT 3 merged at `b615991c4`, while this section was
> being drafted, and was found by the `git merge origin/main` before the pull
> request opened. The substance is discharged here in full either way, and the
> card is amended on the record. Any sibling citing _"AMENDMENT 2"_ or
> _"AMENDMENT 3"_ for the affordance table means **this** section.
>
> **⚠️ AN ADR ORDINAL IS A SERIALIZED RESOURCE AND NOTHING SAYS SO.**
> `lib/api/public/contractVersion.ts` states exactly this hazard for the contract
> MINOR — _"every in-flight additive pull request claims the next one. Read this
> file on `origin/main` before merging and renumber if a sibling has taken it"_ —
> and the same is true of an amendment heading, with no note anywhere to say it.
> Two independent passes took `3` on one afternoon. **Merge `origin/main` and
> re-read the last heading before you open the pull request**; the renumber is
> cheap there and expensive once a dozen cross-references point at it.

### §A — The measurement this amendment is built on, and the two errors it corrects

Read on `motir-core` `origin/main` `8d80ac8db`, 2026-09-02, by walking every
`route.ts` under `app/api/public` and `app/api/public-requests` and classifying
its session read and its capability gate:

```
for f in $(find app/api/public app/api/public-requests -name route.ts); do
  grep -l 'requireCompliantSession()' $f        # requires a session
  grep -l "code: 'UNAUTHENTICATED'" $f          # requires a session, by hand
  grep -l 'publicSurfaceUnavailable()' $f       # carries the capability gate
done
```

| class                                      | count | routes                                                                                                                                                          |
| ------------------------------------------ | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| no session read at all                     | **2** | `public/explore`, `public/categories`                                                                                                                           |
| optional `actorUserId ?? null` — anonymous | **6** | `public/p/[identifier]`, `…/items`, `…/tree`, `…/roadmap`, `…/changelog`, `…/subscribe`                                                                         |
| **REQUIRES a session**                     | **5** | `public/p/[identifier]/follow`, `public/projects/[projectId]/requests`, `…/requests/duplicates`, `public-requests/[id]/upvote`, `public-requests/[id]/comments` |
| **carries no `MOTIR_CLOUD` gate**          | **2** | `public-requests/[id]/upvote`, `public-requests/[id]/comments`                                                                                                  |

**Two things the plan believed are false, and both are corrected here rather
than absorbed.**

1. **_"ONE of ten is session-gated (`follow`, a write)"_ — MOTIR-3877's re-scope
   table, and MOTIR-4108's own affordance table after it. It is FIVE of
   thirteen.** The count was taken over `app/api/public/p/*` and generalised to
   the public write surface, which also contains the request intake and, in a
   sibling directory, the two request writes.
2. **_"submit a feature request … already anonymous"_ — it is not.**
   `app/api/public/projects/[projectId]/requests/route.ts` calls
   `requireCompliantSession()` and its own comment says so in terms: _"A
   LOGGED-OUT caller is rejected 401 (sign-in-to-act — reading a public project
   is anonymous, but every WRITE needs an account)."_ Its duplicate pre-check
   carries the same gate. Reading a public project is anonymous; **posting to
   one has never been.**

The second error propagated: MOTIR-3877's verification recipe step 4 and
MOTIR-4122's acceptance criteria both ask for an anonymous submission. Both are
amended on the record by this pass. Filed as **MOTIR-4166**.

### §B — The mechanical constraint that decides most of the table, and it is not the one everybody names

§4 forbids widening the session cookie's `Domain`. That is the constraint this
record is famous for, and **it is not the binding one here.** Read on
`origin/main` at `lib/auth/index.ts:228`:

```ts
advanced: {
  cookies: {
    session_token: {
      attributes: { httpOnly: true, sameSite: 'lax', secure: shouldUseSecureCookies() },
    },
  },
},
```

**`sameSite: 'lax'` already forecloses every credentialed cross-origin write,
independently of `Domain`.** A `fetch` from `motir.co` to `app.motir.co` with
`credentials: 'include'` sends no session cookie under `lax`, and a cross-site
form POST does not either. So the option _"call the existing session-gated route
from the public page"_ is not a thing this amendment declines to do on principle
— **it is a thing that does not work**, and making it work would mean
`sameSite: 'none'`, which is a second widening §4 never had to name because the
first one covered it.

**So the normative sentence is stronger than §4's, and it is this: no credential
of any kind crosses to `motir.co`.** Not by `Domain`, not by `SameSite`, not by
a token minted for the public origin, not by `Access-Control-Allow-Credentials`.
Every row below is a mechanism that holds without one, and no row requires the
cookie configuration above to change by one attribute.

### §C — The rung-1 reading, recorded rather than remembered

| mirror           | what was observed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | source                                                                                                                                           |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Canny**        | A visitor must be identified before they can post, vote or comment. Absent SSO they make a **free Canny account** — the portal carries its own identity. With SSO, Canny sends them to the customer's own site with `redirect` and `companyID`; the customer authenticates them and redirects to `https://canny.io/api/redirects/sso` with `ssoToken`, `companyID` and `redirect`; the visitor lands back at the `redirect` URL. **This is the hand-off-and-return shape, with the return destination as an explicit parameter.** | https://help.canny.io/en/articles/1961021-setting-up-a-single-sign-on-sso-redirect · https://help.canny.io/en/articles/489272-single-sign-on-sso |
| **Statuspage**   | Anyone visiting a public status page subscribes by clicking _Subscribe to updates_ and entering an email, phone number or webhook URL. **No account is created and there is no login on the public page.** RSS subscribers are not counted at all.                                                                                                                                                                                                                                                                                | https://support.atlassian.com/statuspage/docs/enable-subscribers/ · https://support.atlassian.com/statuspage/docs/how-are-subscribers-counted/   |
| **Notion**       | The published-site help page documents exactly two things a web visitor does: **view** (_"Anyone on the web can view it"_, including toggling database views and opening nested pages) and, if the publisher enables it, **`Duplicate as template`**. It documents **no** commenting or editing affordance for a site visitor. **Recorded honestly: the article does not state that anonymous commenting is refused — it states an affordance set that does not contain it.**                                                     | https://www.notion.com/help/public-pages-and-web-publishing                                                                                      |
| **GitHub Pages** | Static, and on a separate registrable domain (`github.io`, Public Suffix List) — already §4's evidence, unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                | GitHub, _"Yummy cookies across domains"_ (§4 Sources)                                                                                            |

**Nothing in this set puts a write that needs the application's identity on the
public origin.** The two shapes on offer are _carry your own identity there_
(Canny without SSO) and _send them to the application and back_ (Canny with
SSO). This amendment takes the second, and §G says why not the first.

### §D — The decision: three mechanisms, and the affordance table

Every affordance on `motir.co/p/*` is exactly one of:

- **ANONYMOUS-DIRECT** — the browser on `motir.co` calls `app.motir.co` directly.
  The route is anonymous, so **CORS allow-lists exactly `publicSiteOrigin()` and
  `Access-Control-Allow-Credentials` is NOT set.** No credential can ride the
  request, which is what makes the allow-list a convenience rather than a trust
  boundary.
- **HAND-OFF** — the control is a **link**, not a `fetch`. It sends the visitor
  to `app.motir.co`, the act is performed there under the application's own
  session and CSRF posture, and a **validated** `next` returns them to the page
  they left. Canny's `redirect` parameter is the shape; `proxy.ts`'s
  `CURRENT_PATH_HEADER` docstring is the warning that goes with it.
- **ABSENT** — the affordance does not appear on `motir.co` at all. It lives in
  the application, where the person who needs it already signs in.

| #   | affordance                                   | mechanism            | what the visitor sees on `motir.co`                                                                                                                                                                                                       | mirror                                                                                      |
| --- | -------------------------------------------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| 1   | account menu / sign-in dialog in the top bar | **ABSENT**           | No account menu and no modal. One plain **`Sign in`** link in the chrome, to `app.motir.co`, identical for every visitor. The page cannot know whether anyone is signed in, and does not pretend to.                                      | **Notion** — a published page's chrome is the publisher's, not the reader's account surface |
| 2   | **follow** (`POST`/`DELETE …/p/{id}/follow`) | **HAND-OFF**         | A `Follow` link to `app.motir.co`, carrying the project and a `next` back to this page. The application signs the visitor in if needed, performs the follow, returns them. Comes back showing the new state.                              | **Canny SSO redirect**                                                                      |
| 3   | **subscribe** (`POST …/p/{id}/subscribe`)    | **ANONYMOUS-DIRECT** | An email field and a button, on the page, working with no account. Answers 202 whatever happened (the route's own non-oracle rule, §7 of the follow ADR).                                                                                 | **Statuspage**                                                                              |
| 4   | **roadmap vote** and **request upvote**      | **HAND-OFF**         | A vote control that is a link. The count is public and rendered anonymously; casting one leaves and returns.                                                                                                                              | **Canny SSO redirect**                                                                      |
| 5   | **request comment**                          | **HAND-OFF**         | The thread renders in full, anonymously. The composer is a link that leaves and returns to the request.                                                                                                                                   | **Canny SSO redirect**                                                                      |
| 6   | **submit a feature request**                 | **HAND-OFF**         | `Request a feature` is a link, not a form on this host — **because the intake has always required an account** (§A error 2). The duplicate-suggestion step happens in the application, where its pre-check is already gated the same way. | **Canny SSO redirect**                                                                      |
| 7   | **in-place overview editing**                | **ABSENT**           | Nothing. No `Edit` affordance, no `canManage` on the public projection. A manager edits the public overview in the application, and this page is its output.                                                                              | **Notion** — you edit in Notion; the published page is what it produces                     |
| 8   | **viewer-awareness on the reads**            | **ALWAYS ANONYMOUS** | `actorUserId` is structurally `null` for every read `motir.co` makes. §E states what that costs and what it buys.                                                                                                                         | **Statuspage / GitHub Pages** — one page, the same for everyone                             |

**Rows 1 and 7 are the two the mirrors disagree about and the reasoning is not
the same.** Row 1 is absent because a cross-origin page cannot compute the state
the menu would display. Row 7 is absent because it _could_ have been a hand-off
and should not be: an overview edit is a long-form authoring act with a preview
and a save, and routing that through a link-out-and-return is worse than putting
it where the author already works. **Absence here is a positive choice, and it
deletes an entire write path from the public origin.**

### §E — Row 8, stated as a cost and a gain

**The cost.** `actorUserId: null` is now the only case `motir.co` can produce, so:

- **The epic-privacy exclusion always applies at its most conservative.** A
  member of the project reading `/p/<identifier>` sees exactly the public
  projection a stranger sees. Today, on `app.motir.co`, they see more.
- **_"You follow this"_ cannot render.** Row 2's control is stateless: it always
  reads `Follow`, because the page cannot know. The state exists, and it is
  visible in the application.
- **Neither is recoverable by a token.** Any mechanism that told `motir.co` who
  is reading would be a credential on the public origin, which §B forbids
  outright.

**The gain, and it is not a consolation.** Every `/p/*` response is identical for
every visitor, so the whole surface is **cacheable at the edge without a
`Vary: Cookie`**. §8 cost 1 — _"a network hop replaces a Prisma read"_ — is
substantially repaid by exactly this property, and it is repaid only because
row 8 went this way.

### §F — What `motir-core` owes, by row (MOTIR-4114's specification)

- **Rows 2, 4, 5, 6 (HAND-OFF)** — one application-side act entry point that
  takes the intent, its subject and a `next`, requires a session (sending an
  unauthenticated visitor to sign-in with itself as the return), performs or
  presents the act, and then redirects to `next`. **`next` is validated against
  `publicSiteOrigin()` and falls back to a fixed safe destination otherwise** —
  never reflected. `proxy.ts`'s `CURRENT_PATH_HEADER` docstring already states
  this obligation for the one existing consumer; this is the second.
- **Row 3 (ANONYMOUS-DIRECT)** — CORS on the anonymous public routes the browser
  calls cross-origin, allow-listing `publicSiteOrigin()` only, **without**
  `Access-Control-Allow-Credentials`, and with the preflight answered.
- **Row 7 (ABSENT)** — `publicProjectsService.setPublicOverview` has had **no
  door at all** since MOTIR-3951 deleted the Server Action. It gets one in the
  application, authorised by the same `canManage` the service already computes.
- **The two ungated routes.** `app/api/public-requests/[id]/{upvote,comments}`
  stay **outside** `app/api/public/*` — after this amendment nothing on
  `motir.co` calls them, and they are application routes serving the
  application's own act surface, not entries in the public contract. **But they
  gain the `MOTIR_CLOUD` gate**, which they have never carried: public projects
  are a cloud capability (§5), and a self-hosted single-tenant build answers
  these two today. The reason for staying outside goes in each route's own
  comment, so the next reader meets a decision rather than an omission.

### §G — Rejected alternatives

- **A per-tenant or portal identity on `motir.co`** (Canny without SSO). It is a
  second identity system, a second set of accounts to support and secure, and it
  puts credentials back on the origin that holds tenant content — the exact
  thing §4 spent its length avoiding. Revisited only if MOTIR-3878 moves the
  public surface to a separate registrable domain, which is §4's reversal
  condition.
- **`sameSite: 'none'` on the session cookie**, so the public page could call
  the gated routes with credentials. This is a widening in effect and is
  rejected on §4's own grounds; §B is why it is the option that first suggests
  itself.
- **A short-lived token minted for the public origin.** It is a credential on
  `motir.co` however short its life, and an XSS on that origin — the risk §4's
  deviation is about — reaches it.
- **Forwarding row 3's write server-side through `motir-marketing`** instead of
  CORS. It collapses every visitor to one source address, and
  `publicFollowGuard` rate-limits per IP: the per-visitor ceiling would become a
  global one. Trusting a forwarded-for header from the marketing app to fix that
  is a trust relationship this arrangement does not need to create.

### §H — What this amendment changes about §7 and §9

- **§7's `MOTIR-3877` row** read _"BOUND by §4"_. It is now bound by §4 **and by
  this amendment**, which is where the affordances are decided; the table above
  is the specification MOTIR-4113 draws and MOTIR-4114 builds.
- **§9 gains nothing and loses nothing.** The affordance question was never
  listed there — that is §A's point — so there is no entry to strike. §9's
  MOTIR-3878 row is where §G's rejected portal identity is revisited, and it
  already says so.

### §I — What this amendment deliberately does NOT decide

- **The visual treatment of a hand-off** — what the link looks like, what the
  visitor sees on return, whether there is an interstitial. **MOTIR-4113**, the
  design card, which this amendment blocks.
- **The exact shape of the act entry point** — one route with an `intent`
  parameter, or one per act. **MOTIR-4114**, within §F's constraints.
- **Whether a self-hoster ever gets public projects.** §5 is unchanged; the two
  newly-gated routes join the capability, they do not re-open it.
- ~~**Per-tenant addressing and a separate registrable domain.** **MOTIR-3878**,
  with §4's reversal condition and §G's first bullet as inputs.~~ **DECIDED —
  AMENDMENT 5 (MOTIR-4206, 2026-09-03):** a separate registrable domain, recorded
  in `docs/decisions/public-tenant-addresses.md`. §4's reversal condition is
  closed. What remains under MOTIR-3878 is implementation.

### Sources

- `motir-core` `origin/main` `8d80ac8db`, 2026-09-02 — `app/api/public/**`
  (eleven route files), `app/api/public-requests/[id]/{upvote,comments}/route.ts`,
  `lib/auth/index.ts:228` (the cookie attributes), `lib/publicProjects/urls.ts`
  (`publicSiteOrigin`), `lib/publicProjects/cloudGate.ts`, `proxy.ts`
  (`CURRENT_PATH_HEADER`, `PUBLIC_REDIRECT_SEGMENTS`),
  `lib/services/publicProjectsService.ts` (`setPublicOverview`, `getOverview`'s
  `canManage`), `tests/api/public/cloud-gate-totality.test.ts` (its walk is
  `app/api/public` only)
- Canny — https://help.canny.io/en/articles/1961021-setting-up-a-single-sign-on-sso-redirect
  (`redirect` / `companyID` out, `ssoToken` / `companyID` / `redirect` back to
  `https://canny.io/api/redirects/sso`) ·
  https://help.canny.io/en/articles/489272-single-sign-on-sso (identification is
  required before posting, voting or commenting)
- Statuspage — https://support.atlassian.com/statuspage/docs/enable-subscribers/ ·
  https://support.atlassian.com/statuspage/docs/how-are-subscribers-counted/
- Notion — https://www.notion.com/help/public-pages-and-web-publishing
- MOTIR-4166 — the planning bug for §A's two measurement errors

---

## AMENDMENT 5 — the MCP tool catalogue is PUBLISHED as an anonymous, UNVERSIONED documentation artifact at `/api/docs/mcp-tools.json`, outside both contracts (MOTIR-4194, 2026-09-02)

§8's third cost — _"`/docs` is the sharpest cost and the least settled"_ — names
two registries `motir.co` must consume across the repository boundary:
`lib/apiDocs/reference` reads the OpenAPI spec, and `lib/apiDocs/mcp` reads the
tool catalogue. MOTIR-4046 settled the mechanism for the first: `/docs/api`
fetches `/api/openapi/v1.json` at request time and keeps no copy. **It did not
settle the second**, and what happened in the gap is the fixture for why the
mechanism has to be the same one: `motir.co/docs/mcp/tools` shipped a
hand-copied subset — 24 of 55 tools in five groups that matched no permission —
with nothing in that repository able to check it (MOTIR-4180), and the copy was
then removed rather than repaired, leaving the product with **no tool catalogue
published anywhere**. This amendment supplies the artifact that lets the page
come back the way `/docs/api` already works.

> **⚠️ AN ADR ORDINAL IS A SERIALIZED RESOURCE** — AMENDMENT 4's own warning,
> honoured: this section was written against `origin/main` `ac5f9ac16`, whose
> last heading is AMENDMENT 4. Re-read the last heading after merging
> `origin/main` and renumber if a sibling has taken `5`.

### §A — The measurement this amendment is built on

Read on `origin/main` `ac5f9ac16`, 2026-09-02:

| reading                                                     | value                                                                                                                                                                                                                       |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TOOL_PERMISSIONS` keys (`lib/mcp/toolPermissions.ts`)      | **55**, one permission per tool, typed `Record<McpToolName, PermissionKey>` — total by construction                                                                                                                         |
| `TOOL_SUMMARIES` (`lib/apiDocs/mcp.ts`)                     | key-equal to the map above by typecheck; `mcpCatalogue()` already DERIVES the grouping from each tool's permission and the labels from the shipped `permissions.*` copy — the only authored thing is the order              |
| runtime readers of `lib/apiDocs/mcp.ts`                     | **none.** `git grep -l 'apiDocs/mcp\|TOOL_SUMMARIES'` returns the module, its fingerprint module, two tests, a design build script and three documents — no route and no component, since MOTIR-3951 deleted `app/(public)` |
| `POST /api/mcp` `tools/list` with no `Authorization` header | **401** — `withMcpAuth(…, { required: true })` refuses before a tool runs                                                                                                                                                   |
| `motir.co/docs/mcp/tools`                                   | renders **no tool** since MOTIR-4180; `tests/docs/docs.test.ts` there asserts the page source names none                                                                                                                    |

The first two rows are why nothing here is invented: the derivation this
amendment publishes already exists, enforced by the type system. The third is
why it was invisible — a registry with no reader is one whose truth gate can be
deleted as collateral and go unnoticed for a day (MOTIR-4165). The fourth is why
the answer is a published artifact rather than a consumer reading the live
surface.

### §B — The decision

**`motir-core` serves the derived catalogue as JSON at
`GET /api/docs/mcp-tools.json` — anonymous, `force-static`, cacheable — and
`motir.co/docs/mcp/tools` (MOTIR-4195) fetches it at request time and keeps no
copy, exactly as `/docs/api` consumes `/api/openapi/v1.json`.**

The document is `mcpToolCatalogueDocument()` in `lib/apiDocs/mcp.ts`:

| field                                                          | source                                                                           | kind                                                                                                                      |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `endpoint`                                                     | `MCP_ENDPOINT_PATH` — where the tools are called                                 | derived                                                                                                                   |
| `toolCount`                                                    | the length of the rows                                                           | derived, never a literal                                                                                                  |
| `groups[]` — one per permission that gates at least one tool   | `GRANTABLE_PERMISSIONS`, filtered                                                | **order AUTHORED** (the catalog's own); membership derived                                                                |
| `groups[].permission` · `label` · `gates` · `grantedByDefault` | the permission key; the shipped `permissions.<slug>` copy; `DEFAULT_TOKEN_GRANT` | derived                                                                                                                   |
| `groups[].tools[]` — `name` · `permission` · `summary`         | `TOOL_PERMISSIONS`; the authored one-line summary                                | names and permissions derived; summaries authored and fingerprint-pinned (Amendment 13 Q2 of `public-api-conventions.md`) |

The route composes no wrapper, authenticates nothing, reads no database, takes
no user input and spends no rate-limit budget — the four properties both
OpenAPI routes already hold, asserted against the file's source by
`tests/api/docs/mcp-tools-route.test.ts`. The same file asserts **totality**:
every `TOOL_PERMISSIONS` key reaches the served document, compared as sets and
proved to fire by removing one entry from a served document inside the test.
Typecheck holds the summary map key-equal to the permission map; it cannot see
whether a serialization dropped one, which is the gap that test closes.

### §C — The VERSIONING POSTURE: an UNVERSIONED documentation artifact, not part of `v1` and not part of the public read contract

**Decided: the document carries no version, sits under no deprecation policy,
and is not an operation of either published contract.** The reasoning, so it is
on the record rather than inherited from whichever path the route happens to
sit under:

- **The MCP surface already versions itself through `tools/list`.**
  `public-api-conventions.md` Amendment 7 explicitly licenses that surface to
  churn — _"rewording a description or renaming an argument is how an agent's
  behaviour is tuned"_ — and the published fork table tells a reader as much.
  A documentation feed FOR that surface cannot promise more stability than the
  surface it documents, and a number that changed on every reworded summary
  would be noise.
- **A version is a promise, and this document has no reader who needs one.**
  AMENDMENT 1 §D's policy exists because a visitor finds an empty page when a
  field is removed. The consumer here is one page in `motir-marketing`, in the
  same organisation, deployed by the same people; a shape change is a
  two-repository event either way, and the contract test §3 asks for lives in
  the producing repository (`mcp-tools-route.test.ts`) — which is the guard
  worth having. Putting the feed under the `1.x.y` policy would buy a standing
  obligation — alongside-not-in-place majors, announced windows, a MINOR bump on
  every additive change — without buying a reader.
- **It is not a `v1` operation** for the three grounds AMENDMENT 1 §B gives: the
  wrapper authenticates by construction, the envelope differs, and the version
  would lie. **And it is not a public-contract operation** because it is not the
  public-projects capability: the contract describes `app/api/public/*`, is
  gated with it, and its totality guard would demand a declaration for a
  document about a different surface.

**What a consumer MAY rely on:** the path `/api/docs/mcp-tools.json`, that it
answers with no credential, and the field names in §B's table with their types.
**What may change without notice:** the tool set, every summary, every label,
group membership, the count, the order (it follows the permission catalog), and
the appearance of new fields — a consumer MUST tolerate keys it does not know,
the same obligation AMENDMENT 1 §D puts on the public contract's consumer.
**What a consumer MUST NOT do:** commit a copy. MOTIR-4195's own criterion says
so in its own words, and the reason is §A's fourth row: a copy that renders only
when the truth is unreachable is stale exactly when it is displayed.

**If a versioned feed is ever needed** — a third-party reader that hard-codes
the shape — it arrives ALONGSIDE at its own path, and this one keeps answering;
that is AMENDMENT 1 §D's alongside-not-in-place rule, applied in advance.

### §D — What a SELF-HOSTED build serves: the same answer as `/api/openapi/public.json`

**Served, unconditionally — MOTIR-4042's disposition, applied rather than
re-decided.** §5's table makes `/docs` present off-cloud because _"it describes
the software, and a self-hoster needs documentation for their own build"_; the
MCP server ships in every build, so its catalogue is that documentation. The
route is `force-static`, so a gate in the handler would capture the BUILDER's
flag rather than the deployment's, and making it dynamic would discard the cache
for no capability or data exposure. `tests/api/public/cloud-gate-totality.test.ts`
now pins BOTH static product documents as deliberate exclusions from the gate,
naming the card that decided each — one policy, two routes, no second rule.

### §E — Why `/api/docs/`, and not the three obvious neighbours

| candidate                 | why not                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/api/v1/…`               | authenticated by construction and audited: `v1RouteAudit` raises `bypasses-wrapper` for a handler not wrapped in `withV1Route`. The reason both OpenAPI documents sit outside it, unchanged; the test runs the counterfactual                                                                                                                                                                   |
| `/api/openapi/…`          | names a FORMAT, and this is not an OpenAPI document. A reader who finds it there looks for `paths` and `components`; a generator pointed at it errors                                                                                                                                                                                                                                           |
| `/api/mcp/…`              | the authenticated endpoint the catalogue DESCRIBES. An anonymous sibling beside the one path where every request must carry a token invites the wrong reading in both directions                                                                                                                                                                                                                |
| **`/api/docs/…`** (taken) | the neutral home for a documentation artifact that is neither an OpenAPI document nor part of a versioned contract. No guard walks it (`app/api/v1`, `app/api/public`, `app/api/public-requests` are the audited roots), so it needs no exemption from any of them; the proxy's `PUBLIC_REDIRECT_SEGMENTS` keys on the FIRST segment (`api`), so `/docs` moving to `motir.co` does not catch it |

### §F — Rejected alternatives

| Alternative                                                                | Why rejected                                                                                                                                                                                                                                                                        |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`motir.co` reads the live `tools/list`**                                 | It cannot, anonymously (§A). Making it possible means a workspace token in a marketing site's CI, a rotation owner, and a guard that goes red the day it expires — a credential added to a seam that needs none. A published artifact removes the credential from the seam entirely |
| **Move `TOOL_SUMMARIES` to `motir-marketing`**                             | Breaks the totality chain at its first link: a tool added to `MCP_TOOL_NAMES` widens `TOOL_PERMISSIONS`, which makes the summary map incomplete, which fails typecheck — HERE. In another repository nothing fails                                                                  |
| **Let `motir.co` transcribe the catalogue** (the state MOTIR-4180 removed) | Breaks the chain at its last link, and was measured: 24 of 55, five invented groups, no guard able to notice                                                                                                                                                                        |
| **A build-time artifact published as a package**                           | A generated file to keep in sync, a build step, and a new way to be stale — Amendment 13 Q2's own rejection of the same shape, for a fact a request-time read hands over with no install                                                                                            |
| **Put it under the `v1` contract or the public contract, versioned**       | §C. A standing obligation without a reader, on a surface licensed to churn                                                                                                                                                                                                          |
| **Serve the per-tool input tables too**                                    | Amendment 13 Q3 keeps them in `docs/mcp.md` deliberately — the highest-churn facts, one click away in the file beside the code. Unchanged                                                                                                                                           |

### §G — What this amendment changes about §7, §8 and §9

- **§8's cost 3** named the two registries and assigned the mechanism to
  MOTIR-3932. The OpenAPI half was settled by MOTIR-4046; **the catalogue half is
  settled here**, by the same mechanism: a request-time read of a published
  artifact, no copy.
- **§7 gains two rows.** **MOTIR-4194** — BOUND by this amendment: serves the
  artifact, records this posture, pins the off-cloud exclusion. **MOTIR-4195** —
  BOUND by §C's consumer half: fetches at request time, throws when unreachable,
  commits no list.
- **§9 is unchanged.** The `/docs` publication mechanism it listed was already
  decided for the spec; this closes the remaining half of that entry rather than
  adding one.

### §H — What this amendment deliberately does NOT decide

- **The fingerprint truth gate.** MOTIR-4165 restores the test that recomputes
  each summary's pin from a live `tools/list`. Independent of this artifact and
  shippable now: that gate proves each SUMMARY still matches the tool text it was
  written against; this amendment proves the catalogue REACHES a reader. Neither
  substitutes for the other.
- **Whether `/api/docs/` ever carries a second artifact.** The CLI's command
  catalogue (`lib/apiDocs/cli.ts`) is the obvious candidate and is nobody's card.
- **The rendering.** What the page looks like is MOTIR-4195's, within
  `motir-marketing`'s own design system.

### Sources

- `motir-core` `origin/main` `ac5f9ac16`, 2026-09-02 — `lib/mcp/toolPermissions.ts`
  (`TOOL_PERMISSIONS`, 55 keys), `lib/apiDocs/mcp.ts` (`TOOL_SUMMARIES`,
  `mcpCatalogue`), `lib/tokens/grant.ts` (`GRANTABLE_PERMISSIONS`, catalog
  order), `app/api/mcp/route.ts:87` (`withMcpAuth(…, { required: true })`),
  `app/api/openapi/{v1,public}.json/route.ts` (the two sibling documents and
  their headers), `tests/api/public/cloud-gate-totality.test.ts`, `proxy.ts`
  (`PUBLIC_REDIRECT_SEGMENTS`, `config.matcher`)
- `docs/decisions/public-api-conventions.md` — §8 (stability), Amendment 4 Q3
  (where a spec is served, and why not inside `/api/v1`), Amendment 7 (the MCP
  surface's licence to churn), Amendment 13 Q2 (the derived / authored split)
- AMENDMENT 1 §B–§D above — the three grounds against folding into `v1`, and
  the deprecation policy this document deliberately stays outside
- MOTIR-4042 (PR #2494) — the off-cloud disposition of `/api/openapi/public.json`
- MOTIR-4180 — the hand-copy this artifact replaces; MOTIR-4165 — the truth gate
  this artifact does not restore

---

## AMENDMENT 6 — §4's reversal condition is CLOSED: tenant addresses move to a separate registrable domain, and the accepted exposure is retired one project at a time (MOTIR-4206, 2026-09-03)

§4 accepted a deviation it named as a deviation — tenant-authored content on
`motir.co`, the parent domain of the host that holds the session, where every
mirror puts tenant content on a separate registrable domain. It accepted the
residual exposure **on a condition** (the session cookie stays host-only) and it
wrote a reversal condition naming MOTIR-3878 as where the arrangement is
revisited. **This amendment is that revisit, and it closes the condition.**

### §A — The decision

**Per-tenant addresses hang off a SEPARATE REGISTRABLE DOMAIN, never a subdomain
of `motir.co`.** `docs/decisions/public-tenant-addresses.md` is the record; §2 of
it fixes the shape the domain must have and ranks RDAP-checked candidates, and
MOTIR-4208 buys one.

Both of §4's own reasons are honoured rather than argued with:

1. **The exposure is not multiplied — it is REDUCED, one project at a time.**
   §4's fear was that _"one origin of user content becomes one per customer, all
   under the session's registrable domain."_ Under the new record, a tenant
   origin is `<workspace>.<base>`, which is a different **site** from
   `app.motir.co` by the browser's own rule, not merely a different origin. And
   the canonical rule (that record's §7) means that once a project claims an
   address, **`motir.co/p/<identifier>` for that project becomes a `301`** and
   serves no tenant content at all. So each claim removes an origin of tenant
   content from `motir.co` rather than adding one beside it.
2. **The certificate arithmetic works.** A two-level base gives `acme.<base>`
   under one wildcard `*.<base>`, which is §4's second reason satisfied exactly.

### §B — What is UNCHANGED

- **The host-only session cookie stays host-only.** It was the condition on which
  the residual exposure was accepted, and this amendment does not spend it — it
  removes the thing it was compensating for. MOTIR-3877's test gate stands.
- **`motir.co/p/*` survives** for every project that has claimed no address,
  which is the default and stays free. §4's arrangement remains the arrangement
  for that population; what changes is that it is no longer the _only_ one.
- **§5's cloud gate is untouched.** A build with no public projects has no
  addresses; the new surfaces inherit `publicSurfaceUnavailable()` / `isCloud()`
  rather than re-deciding.
- **No subprocessor row.** The base domain is registered at Spaceship, which
  already holds `motir.co`, and the certificates are issued by Fly on the
  `motir-marketing` app — both already in the stack. `marketing-site-hosting.md`
  §5's reasoning is what rejects the alternative (Cloudflare for SaaS) that would
  have added one.

### §C — What §9's entry becomes

§9's bullet _"Per-tenant addressing and a separate registrable domain — MOTIR-3878"_
is **discharged**. The question is decided here and in
`public-tenant-addresses.md`; what remains under MOTIR-3878 is implementation,
not a decision this record is waiting on. §9 is updated in place.

### §D — What this amendment does NOT do

- It does **not** move `app.motir.co` or `motir.co`. Both keep answering exactly
  what §2 says they answer.
- It does **not** decide the base domain's string — that is
  `public-tenant-addresses.md` §2 plus MOTIR-4208, and no code contains it either
  way.
- It does **not** depend on the Public Suffix List. §4 already said so —
  _"A separate domain gets the isolation immediately; PSL listing is a later
  refinement"_ — and MOTIR-4213 owns the submission.
