# The production service stack — email, error monitoring, product analytics, and the rate-limit store

- **Status:** Accepted (2026-08-10, drafted for Story MOTIR-658 per the
  decision-subtask ladder). **No application behaviour ships in this subtask** —
  it writes this file and changes no code, no workflow and no config. Every value
  it names is provisioned or wired by a card listed under **Consequences**.
- **Story / Subtask:** MOTIR-658 (8.5 Production hardening + observability) ·
  Subtask MOTIR-1122 (8.5.1).
- **Consumed by:** MOTIR-1123 (email provisioning), MOTIR-1127 (email wiring),
  MOTIR-1161 (Sentry + analytics provisioning), MOTIR-1162 (Sentry wiring),
  MOTIR-1163 (analytics wiring), MOTIR-1165 (app-level rate limiting),
  MOTIR-2037 (`/api/v1`'s shared counter), MOTIR-1160 (the DPA template and the
  public subprocessor list), MOTIR-1124 (production go-live).
- **Builds on:** `application-hosting.md` — accepted three days before this
  record and the reason it exists in this shape. motir-core runs as ONE
  long-running Node process on Fly, not as per-request serverless functions, and
  that changes both **where a value lives** and **which store is the cheap
  answer**.
- **Supersedes / superseded by:** nothing. This is the first record in this
  directory that names an outside service the running application depends on.

> Convention (set by `work-item-type-taxonomy.md`, followed by
> `billing-tiering.md` / `application-hosting.md`): a decision record is a
> markdown file under `docs/decisions/`, structured **Status → Context →
> Decision → Consequences**, with load-bearing facts pinned in explicit tables.
> The numbered-**Q** section shape and the per-Q rejected-alternatives table are
> `public-api-conventions.md`'s (Amendments 9–11).

---

## The problem

Four cards under Story 8.5 are blocked on the same sentence: _"some provider, to
be decided."_ Motir is running in production today with **no error monitoring,
no real transactional email, no analytics, and a rate limit each instance counts
on its own**. Each hole has a provisioning card and a wiring card waiting behind
it, and none of them can start while the vendor is an open question.

Making the four choices together is not merely cheaper than making them one at a
time. It is the only way to notice the place where two of them should share
something instead of each bringing its own bill — which is exactly what §6 below
finds.

**Two constraints bind every answer, and both come from the hosting move rather
than from the services themselves.**

**1 — A value's HOME is now a two-way choice, and picking wrong fails silently.**
On Vercel every value went to one dashboard. On Fly there are two mechanisms:

| kind of value                 | home                               | when it is read                           |
| ----------------------------- | ---------------------------------- | ----------------------------------------- |
| a server-side secret          | `flyctl secrets set -a motir-core` | `process.env`, at RUNTIME                 |
| anything the BROWSER must see | a Docker **build argument**        | inlined by `next build`, INSIDE the image |

A `NEXT_PUBLIC_*` value is inlined into the client bundle when `next build` runs,
and on Fly that build happens in the image (`flyctl deploy --local-only`, in
`ci.yml`'s `deploy` job). **A Fly secret set afterwards is invisible to it.** The
failure mode is the reason this is stated first: an integration wired that way
looks complete, passes review, and never reports a single browser event.

**⚠️ The build-argument seam does not exist yet.** `Dockerfile` on `origin/main`
declares **zero** `ARG`s (`grep -c '^ARG' Dockerfile` → `0`, read 2026-08-10) and
`ci.yml`'s deploy step passes no `--build-arg`. Building it is code work, and §7
assigns it to exactly one card. **A choice whose public surface is small is
therefore worth real money here**, and §5 takes that seriously.

**2 — The runtime is a warm process holding a live Postgres pool.** Not a cold
function per request. The pool is `machine_count: 2` — created deliberately by
`fly scale count 2`, asserted from Fly's API on every deploy by `ci.yml`. Any
argument of the form _"we need an external store because serverless"_ is an
argument about a deployment Motir no longer has, and §6 is where that matters.

---

## §1 — The decisions, in one table

| #      | Question                              | Decision                                                                                                    |
| ------ | ------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| **Q1** | Who sends transactional email?        | **Resend**, one of the two arms `lib/email.ts` already accepts. `EMAIL_PROVIDER=resend`, runtime Fly secret |
| **Q2** | Who catches production errors?        | **Sentry** (`@sentry/nextjs`), org created in the **EU data region** — an irreversible choice at creation   |
| **Q3** | What identifies a Sentry RELEASE?     | The **commit SHA**, carried in as a build argument. The **environment** is a separate runtime secret        |
| **Q4** | Who counts visitors?                  | **Plausible** — cookieless, EU-hosted, and it needs **no build-time public value at all**                   |
| **Q5** | Where does the rate-limit tally live? | **A Postgres counter table** on the database the app already holds open. Redis is the named alternative     |
| **Q6** | Is that table tenant-scoped?          | **No** — deliberately no `workspace_id`, no RLS, and the migration must say so in its own header            |
| **Q7** | Who builds the build-argument seam?   | **MOTIR-1162** (Sentry wiring), once, for the one value that needs it. No second card reuses it             |

**Every choice stays env-configurable.** A self-hoster swaps or omits any of the
four without a code change; the abstraction in `lib/email.ts` — a provider
resolved from one environment variable, an unknown value crashing at boot rather
than on the first send two days into a deploy — is the template for the others.

---

## §2 — Q1: transactional email is Resend

### The decision

**`EMAIL_PROVIDER=resend`**, with `RESEND_API_KEY` as a **Fly runtime secret**.

`lib/email.ts` already contains the seam. `getEmailProvider()` resolves the
provider eagerly at module import and offers exactly five arms — `console`
(default), `file` (test-only, refused in production), `resend`, `postmark`, and a
`default` that throws. `resend` and `postmark` are today
`unimplementedProvider(name)` stubs that throw a clear not-yet-implemented error.
So this decision does not add an abstraction; it names which of the two arms the
one that already exists gets a body.

**Why Resend over Postmark.** Both are equal-footing in the code. The tiebreak is
that the templates that will feed it already assume Resend's stack: the eight
templates in `lib/emailTemplates/` are React components rendered through
`@react-email/render`, which is the same project Resend maintains. Domain
authentication is ordinary DNS on `motir.co`, which MOTIR-1123 owns either way.

**Unaffected by the hosting move.** The send path is an HTTPS call out of a
server process; it looked the same on Vercel and looks the same on Fly. This is
the one choice of the four that the platform change does not touch.

### What MOTIR-1123 must record, and one thing it must check FIRST

- `RESEND_API_KEY` → **Fly runtime secret**, `flyctl secrets set -a motir-core`.
- `EMAIL_PROVIDER=resend` → **Fly runtime secret** (or `[env]` in `fly.toml`; it
  is not secret, but keeping it beside the key keeps the pair together).
- The **From address** on `motir.co` — MOTIR-1127 owns the env name for it,
  because `lib/email.ts` has no `EMAIL_FROM` today (read 2026-08-10) and inventing
  the name here would pin a seam that does not exist.
- **⚠️ Check Resend's sending REGION before creating anything, and record what
  you find.** Where a provider processes message content is a term of the DPA
  (MOTIR-1160) and providers commonly fix it at account or domain creation. This
  record does not assert what Resend's options are — nobody has read them — and
  guessing here is precisely the shape `notes.html` #241 punishes. Read it, record
  it, and if the choice is irreversible say so on the card.

### Rejected alternatives

| Alternative                           | Why not                                                                                                                                           |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Postmark**                          | A genuine peer, and the abstraction keeps it one env value away. Loses only on the React-Email adjacency the eight existing templates already use |
| **Amazon SES**                        | Cheapest at volume and the worst at zero volume: a sandbox-exit review, no template story, and deliverability tooling we would have to build      |
| **SMTP direct / self-hosted**         | Deliverability is the entire product being bought. A reset email in spam is indistinguishable from an outage, and unarguable with                 |
| **Keep `console` until after launch** | The default today, and the reason password reset does not work in production. This card exists because that stopped being acceptable              |

---

## §3 — Q2: error monitoring is Sentry, in the EU region

### The decision

**Sentry**, via `@sentry/nextjs`, with the org created in Sentry's **EU data
region**.

`grep 'sentry' package.json` returns nothing (read 2026-08-10) — there is no
partial installation to reconcile, and nothing in the repo constrains the choice.
Sentry is chosen on the ordinary merits: one SDK covering both the server process
and the browser, source-map upload so a minified stack trace is readable, a tunnel
route so an ad-blocker does not silently swallow client reports, and a Next.js
integration that understands Server Components and Route Handlers.

**⚠️ The EU region is chosen at ORG CREATION and cannot be changed afterwards.**
This is the sentence in this record most likely to cost real money if skipped.
moooon B.V. is a Dutch entity, MOTIR-1160 must publish a subprocessor list naming
where each processor holds data, and an error payload routinely carries user email
addresses, request URLs and IDs. Moving regions later means a new org, new DSN,
new tokens, and the loss of the issue history — the same class of
irreversible-dashboard-flip that MOTIR-2009 recorded for GHCR visibility. It is
called out here, not left for the provisioning agent to discover.

### Where each Sentry value lives

| value                     | home                                     | why                                                                      |
| ------------------------- | ---------------------------------------- | ------------------------------------------------------------------------ |
| `SENTRY_AUTH_TOKEN`       | **GitHub Actions secret**                | consumed by the source-map upload, which runs during the **image build** |
| `SENTRY_ORG` / `_PROJECT` | GitHub Actions secret or variable        | same — build-time inputs                                                 |
| `NEXT_PUBLIC_SENTRY_DSN`  | **Docker build argument** (from Actions) | inlined by `next build`; a Fly secret set later is invisible to it       |
| `SENTRY_DSN` (server)     | **Fly runtime secret**                   | read from `process.env` by the server process at runtime                 |
| `SENTRY_ENVIRONMENT`      | **Fly runtime secret**                   | see §4 — the deployment's identity, not the build's                      |

**This is the only value in the whole stack that needs the build-argument seam**
(`NEXT_PUBLIC_SENTRY_DSN`, plus §4's release SHA). §5 and §7 are where that fact
does its work.

### Rejected alternatives

| Alternative                               | Why not                                                                                                                                            |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Sentry in the US region (the default)** | Cheaper in effort by one dropdown, and wrong for a Dutch controller publishing a subprocessor list. Irreversible, so the default is not neutral    |
| **GlitchTip / self-hosted Sentry**        | Removes a subprocessor and adds an operational surface — a service to run, upgrade and page on — to a team of one. Reconsider when there is a team |
| **Fly logs + `console.error` only**       | Logs are not an error tracker: no grouping, no release attribution, no source maps, no alert on a spike, nothing at all from the browser           |
| **Highlight / Bugsnag / Rollbar**         | Peers on features; none of them wins by enough to outweigh Sentry's Next.js integration being the one with source-map + tunnel support built in    |
| **Defer monitoring until after launch**   | Inverted: the window where nobody is watching is exactly the window where the first real users arrive                                              |

---

## §4 — Q3: what identifies a release now that no platform variable does

### The decision

**Two values, two homes, and they are not the same axis:**

| axis                         | value                  | home                      | example                                       |
| ---------------------------- | ---------------------- | ------------------------- | --------------------------------------------- |
| **which BUILD is this**      | the 40-char commit SHA | **Docker build argument** | `--build-arg MOTIR_RELEASE=${{ github.sha }}` |
| **which DEPLOYMENT is this** | `production`           | **Fly runtime secret**    | `SENTRY_ENVIRONMENT=production`               |

The old convention leaned on `VERCEL_ENV` plus the commit SHA. `VERCEL_ENV` is
gone — `grep -rn 'VERCEL_ENV'` over the repository returns no hit outside this
file (read 2026-08-10) — and **nothing replaced it**: Fly injects
`FLY_APP_NAME`, `FLY_MACHINE_ID` and friends at runtime, and every one of them
identifies the machine or the app — **none identifies the build**. A source map
uploaded under one release name and an event tagged with another produce an
unreadable stack trace and no error at all, which is why this gets its own
question.

**Why the split is load-bearing rather than tidy.** The release must be a build
argument because the source maps are uploaded during the image build and must be
tagged with the same string the running code reports. The environment must NOT
be, because it is the one thing that distinguishes two deployments of the _same
image_ — the day a staging app exists, it must be able to say so without a
rebuild. Baking the environment into the image would make that impossible and the
mistake would be invisible until staging errors started arriving labelled
`production`.

**The commit SHA, not a version tag.** motir-core is not released by tag; `main`
deploys on push (`ci.yml`'s `deploy` job, `if: github.ref == 'refs/heads/main'`).
The SHA is the only identifier that always exists, is always unique, and always
resolves back to a diff.

### Rejected alternatives

| Alternative                                       | Why not                                                                                                                  |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| **A `package.json` version**                      | Hand-bumped, therefore stale, therefore many builds share one release name. The failure is silent misattribution         |
| **`FLY_MACHINE_ID` / `FLY_IMAGE_REF` at runtime** | They identify the machine or the image digest, not the source. Neither can tag a source-map upload that already happened |
| **A git tag per deploy**                          | Would make the tag lane the release trigger and change the deployment model to solve a labelling problem                 |
| **One combined `release=sha-env` string**         | Collapses two axes into one, so the same image deployed twice reads as two different builds                              |

---

## §5 — Q4: product analytics is Plausible

### The decision

**Plausible**, self-hostable and cookieless, embedded as a script tag carrying
`data-domain="app.motir.co"`.

**The decisive property is that it needs no build-time public value.** Plausible's
embed is a `<script>` tag whose only site identifier is the site's own domain —
a string that is public, already known, and renderable by the server at request
time. There is no project API key, no `NEXT_PUBLIC_*` variable, and therefore
**no second consumer of the build-argument seam.** Given that seam does not exist
yet (`grep -c '^ARG' Dockerfile` → `0`), a choice that does not need it is
strictly cheaper — this is what §1's _"prefer a choice whose public surface is
small"_ was for.

**The consent story, stated exactly.** Plausible sets no cookies and stores no
personal data, so loading it is not the kind of terminal-equipment access that
requires prior consent. That does **not** license a hardcoded script tag:

1. **The load stays behind ONE seam.** MOTIR-1163 renders the script through a
   single `analyticsEnabled()`-style accessor, never inline at a call site, so a
   consent gate can be added later without touching the surface that renders it.
2. **Unset environment means no analytics at all.** A self-hoster who sets
   nothing ships an app that phones nowhere. This is not a nicety in an
   open-core product — it is the difference between a self-hosted install and a
   telemetry client.
3. **MOTIR-1159's Cookie Policy can say the true and simple thing**: the product
   analytics sets no cookies. That is a better legal artifact than a banner.

**A finding this decision surfaces rather than papers over.** MOTIR-1163's title
is _"Wire consent-gated product analytics (ties to 8.4 cookie consent)"_, and
Story 8.4 as planned today contains no cookie-consent BANNER card — its children
are the legal documents (MOTIR-1158/1159/1160), the pages that render them
(MOTIR-1134), and signup-time ToS acceptance (MOTIR-1135). Under a cookie-setting
analytics vendor that gap would have blocked MOTIR-1163 on a card nobody had
written. Under Plausible it does not, because there is nothing to gate. **The gap
is real and belongs to Story 8.4** — it is recorded here so that the next person
to reach for a cookie-setting vendor knows what it would cost.

### Rejected alternatives

| Alternative                        | Why not                                                                                                                                                                                                                                                       |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **PostHog**                        | Genuinely more capable — funnels, replay, flags — and it buys them with a public project key (the build-arg seam), a much larger script, and cookieless as a setting rather than a property. Revisit when the questions are behavioural, not "is anyone here" |
| **Google Analytics**               | Sets cookies, needs a consent banner nobody has planned, and puts the least defensible processor on the subprocessor list of a European product                                                                                                               |
| **Umami / Matomo, self-hosted**    | Same privacy shape as Plausible and another service to operate. Plausible is also self-hostable, so this door stays open without being walked through now                                                                                                     |
| **Nothing until after launch**     | "Is anyone using it" is the launch's own question. Answering it a month later means answering it about a month nobody measured                                                                                                                                |
| **Server-side event logging only** | No client-side context and a schema to design and maintain. It is a bigger build than the thing it replaces                                                                                                                                                   |

---

## §6 — Q5: the rate-limit store is a Postgres counter table

### The decision

**One shared store, implemented as a counter table in the application's own
Postgres**, behind the `RateLimitStore` interface that already ships in
`lib/api/v1/rateLimit.ts`. `/api/v1` (MOTIR-2037) and the app-level surfaces
(MOTIR-1165) use **the same store** — one dependency, one implementation, one
window.

**⚠️ This reverses the recommendation this card was authored with, and the
reversal is the point.** The previous answer was Upstash Redis, argued as
_"serverless-native"_ because the instance count was _"neither small nor
stable."_ That reasoning described Vercel. It does not describe Fly:

| the old argument                | what is actually true (read 2026-08-10)                                                                 |
| ------------------------------- | ------------------------------------------------------------------------------------------------------- |
| a cold function per request     | ONE long-lived Node process per machine, holding an open connection pool                                |
| instance count unpredictable    | `machine_count: 2` — set by an explicit `fly scale count 2` and asserted from Fly's API on every deploy |
| no database connection to spare | the process already holds a Postgres pool and uses it on essentially every request                      |

Once those three lines are true, adding Redis means **a new vendor, a new bill, a
new subprocessor on MOTIR-1160's list, and a new failure domain in the path of
every API request** — to answer a question the database in the same datacentre
answers in one round trip.

### The shape, pinned so that MOTIR-2037 and MOTIR-1165 need no second decision

- **The increment is one statement, and it is atomic.**
  `INSERT … ON CONFLICT (key, window_start) DO UPDATE SET count = count + 1 RETURNING count`
  — in a repository method taking `tx` (the 4-layer rule). Never read → compare →
  write. This is the shipped interface's own contract, not a new one:
  `RateLimitStore.increment` is documented as indivisible and returning the NEW
  value, and the comparison happens on what that call returned.
- **Fail-open survives unchanged.** `consumeRateLimit` already catches a store
  throw, logs, and allows the request with `degraded: true`. A shared store adds a
  dependency to every limited request, so this matters more, not less: the call
  gets a **hard timeout** as well as a catch, because a hung store must not hold a
  request open. An outage in the limiter must never be an outage in the API.
- **Two configurable budgets, one store.** `/api/v1` keeps
  `MOTIR_API_V1_RATE_LIMIT` / `_WINDOW_MS`; the 8.5.9 surfaces get their own
  budget names. Sharing the store is not sharing the ceiling.
- **The escape hatch is `MOTIR_RATE_LIMIT_STORE`**, resolved through the shipped
  `setRateLimitStore` seam: `postgres` (the default wherever `DATABASE_URL` is
  set) and `memory` (the in-process store that ships today, for tests and for a
  single-instance self-host that would rather not write). **`redis` is not a
  value the code accepts** until a card adds that arm — naming an alternative in a
  decision record is not the same as building it.
- **Expired rows are swept, not accumulated.** A daily cron job following the
  established pattern in `lib/jobs/definitions/` (`attachmentGc`,
  `automationRetentionSweep`, `codeGraphOffboardSweep` are the models) deletes rows
  whose window has passed. Without it the table grows forever and the limiter
  becomes the product's largest table.

### The trigger that would flip this to Redis — and it must be MEASURED

Redis wins on evidence, never on intuition. The named triggers:

- the counter's `INSERT … ON CONFLICT` shows a **p99 above ~5 ms** measured
  against the production database, or
- limiter writes measurably **contend with application writes** (lock waits, pool
  saturation attributable to this table), or
- sustained write rate against the table passes roughly **200/s**, at which point
  the cost of a dedicated counter store starts to look like the cheaper side.

**No number above has been measured** — they are thresholds at which to go and
measure, deliberately not claims about how the table performs. A capacity claim
with no file or reading behind it is an assumption wearing a measurement's clothes
(`notes.html` #200).

### Rejected alternatives

| Alternative                                              | Why not                                                                                                                                                                                                                                  |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Upstash Redis** (the previous recommendation)          | The reasoning behind it was about serverless and no longer describes this deployment. Real cost today: a vendor, a bill, a subprocessor, a failure domain on every request. Stays the named alternative, gated on the measurements above |
| **Redis as a Fly extension / sidecar**                   | Removes the vendor and keeps the operational surface — a second stateful thing to run, monitor and fail over, for a counter                                                                                                              |
| **Keep the in-process store**                            | The defect MOTIR-2037 exists to fix. The advertised ceiling is `limit × 2` today and doubles again the day the pool grows                                                                                                                |
| **Sticky sessions so one token lands on one machine**    | Makes correctness depend on the proxy's routing, and dies the moment a machine restarts mid-window. Solves the symptom by constraining the deployment                                                                                    |
| **Two stores — Postgres for `/api/v1`, Redis for 8.5.9** | Exactly the divergent-limiter failure MOTIR-1165 was written to prevent. One store, one interface, whichever card lands second reuses the first's                                                                                        |

---

## §7 — Q6 and Q7: the counter table is NOT tenant-scoped, and one card owns the seam

### Q6 — no `workspace_id`, no RLS, and the migration says so

motir-core's standing contract is that **every workspace-scoped table carries a
non-null `workspace_id` and ships its RLS policy in the same migration** — "no
unguarded window". **The rate-limit counter is deliberately outside that
contract**, for a reason that is structural rather than a preference:

1. **The 8.5.9 surfaces have no tenant at the moment the limiter runs.** Sign-in,
   sign-up, password reset and the public-write endpoints are rate-limited
   _before_ any workspace is known — that is the whole point of limiting them. A
   `workspace_id NOT NULL` column would be unfillable on exactly the requests
   that need the limiter most.
2. **An RLS policy reading `current_setting('app.workspace_id')` would deny those
   writes outright**, turning a protection into an outage on the pre-auth path.
3. **The key holds no tenant content.** It is a hash — the `/api/v1` key is
   already the token's SHA-256 fingerprint — so there is nothing for a tenancy
   boundary to protect.

**Two obligations follow, and they are not optional:**

- **The key must contain no plaintext personal data.** An IP address is personal
  data under GDPR, and the 8.5.9 surfaces key on IP. Hash it (and any identifier
  composed into the key) the way the `/api/v1` fingerprint already is, so the
  table holds opaque strings with a short life rather than a log of who tried to
  sign in from where.
- **The migration's header must state that the exemption is deliberate**, naming
  reasons 1–3. A table that silently lacks `workspace_id` and RLS is
  indistinguishable from one that forgot, and a reviewer who reads the absence as
  an oversight will either "fix" it — breaking the pre-auth path — or file a
  security finding against it. Writing the reason down is the cheaper half of the
  decision.

### Q7 — MOTIR-1162 builds the build-argument seam, once

`Dockerfile` declares no `ARG`s and `ci.yml`'s deploy step passes no
`--build-arg`. Exactly **one** value in this whole record needs that seam:
`NEXT_PUBLIC_SENTRY_DSN`, plus §4's `MOTIR_RELEASE`. So:

- **MOTIR-1162 (Sentry wiring) owns it** — the `ARG` lines in the `Dockerfile`,
  the `--build-arg` flags on `flyctl deploy`, and the Actions secret/variable
  behind each.
- **MOTIR-1163 (analytics wiring) does NOT reuse it**, because §5's choice needs
  no build-time public value. MOTIR-1161's provisioning notes say the analytics
  public id would be a build argument; **with Plausible chosen there is no such
  id**, and that row of its table drops out.

This is one of the two places where the four choices interact, and it is worth
naming plainly: choosing Plausible over PostHog did not only pick an analytics
vendor, it kept a piece of build plumbing at one consumer instead of two.

---

## Consequences — what this record binds on Story 8.5's cards

| card                                         | what changes                                                                                                                                                                                             |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **MOTIR-1123** — email provisioning          | Provision **Resend**. `RESEND_API_KEY` → Fly runtime secret. **Read and record the sending region before creating anything**, and whether it is fixed at creation                                        |
| **MOTIR-1127** — email wiring                | Implement the `resend` arm of `getEmailProvider()`; it is a stub throwing today. Owns the From-address env name — `lib/email.ts` has none                                                                |
| **MOTIR-1161** — Sentry + analytics accounts | Create the Sentry org **in the EU region (irreversible)**. Analytics is **Plausible** — capture the domain, not a key. **Drop the "analytics public site id → build argument" row: there is no such id** |
| **MOTIR-1162** — Sentry wiring               | Owns the build-argument seam (§7): the `Dockerfile` `ARG`s and `flyctl deploy --build-arg`. Tags releases with the commit SHA; environment stays runtime (§4)                                            |
| **MOTIR-1163** — analytics wiring            | Plausible script behind ONE `analyticsEnabled()` seam; unset env = no analytics. **No build argument needed.** No cookie banner is required, and none is planned (§5)                                    |
| **MOTIR-1165** — app-level rate limiting     | **Not Upstash.** Build against the shared Postgres store; hash IP and identifier into the key (§7). There is no vendor env to leave unset — the escape hatch is `MOTIR_RATE_LIMIT_STORE=memory`          |
| **MOTIR-2037** — `/api/v1`'s shared counter  | Build the Postgres arm of `RateLimitStore` — the exact shape in §6. Whichever of 2037 / 1165 lands first writes the store and the migration; the second reuses it                                        |
| **MOTIR-1160** — DPA + subprocessor list     | The processors are now named: **Resend** (email content), **Sentry** (error payloads, EU region), **Plausible** (aggregate usage). Rate limiting adds **none** — that is a point in its favour           |
| **MOTIR-1124** — production go-live          | The prod secret set on `app.motir.co` is the union of the runtime rows in §2–§4, plus the Actions/build-arg half being present before the image is built                                                 |

**MOTIR-1160 was not previously blocked on this decision, and now is.** A
subprocessor list is a legal artifact that names third parties who process
personal data; it cannot be accurate before those third parties are chosen. The
missing edge was found by auditing this decision's ANSWERS against the cards that
would act on them (`notes.html` #181: _a decision's outputs are deliverables, and
an un-owned one is invisible_), and by #248's sweep rule — the same sweep whose
absence left twenty cards planning against a retired platform. The edge is added
as part of accepting this record.

---

## What this record deliberately does NOT decide

- **Alert routing and thresholds.** Which Sentry alerts fire, to whom, at what
  error rate. MOTIR-1161 decides it while provisioning; it needs the account to
  exist and does not need this record.
- **Whether the marketing site uses the same analytics.** The landing page lives
  in `motir-marketing`, not motir-core. Its analytics is that repo's decision,
  though Plausible's per-domain model makes sharing an account straightforward.
- **The 8.5.9 budgets.** Which limit applies to sign-in versus a public write
  versus an AI call, and how those numbers are picked. MOTIR-1165 owns them; this
  record pins only the STORE they share.
- **Log aggregation.** Fly's own log stream is what exists today. Whether that
  needs a destination is a separate question from error tracking, and nothing in
  Story 8.5 asks it.
- **Uptime / synthetic monitoring.** `ci.yml`'s post-deploy check proves a release
  answers once. Continuous external probing is not planned and is not this.

---

## Sources

- `lib/email.ts` — `getEmailProvider()`, the five arms, `resend`/`postmark` as
  `unimplementedProvider` stubs, the eager module-load resolution (read
  2026-08-10).
- `lib/emailTemplates/` — eight React templates (`ls -1 lib/emailTemplates/*.tsx`,
  read 2026-08-10) rendered via
  `@react-email/render`.
- `lib/api/v1/rateLimit.ts` — the `RateLimitStore` interface and its atomicity
  contract, `createInProcessRateLimitStore`, `setRateLimitStore`,
  `consumeRateLimit`'s fail-open arm, `rateLimitBudget()`'s env reads.
- `docs/decisions/public-api-conventions.md` §6 — the per-token budget, the
  headers, and the **recorded per-process limitation** this decision's store
  removes.
- `docs/decisions/application-hosting.md` — Q1 (Fly, one process), Q6 (the pool of
  two and who creates it), and Q3 (the app-URL contract that replaced the three
  `VERCEL_*` URL variables).
- `Dockerfile` — `grep -c '^ARG'` → `0` (read 2026-08-10): the build-argument seam
  does not exist.
- `.github/workflows/ci.yml`, `deploy` job — `flyctl deploy --local-only`, the
  post-deploy assertions, and the machine-count read from Fly's API.
- `fly.toml` — the runtime configuration, and its own warning that a config file
  is a claim about a deployment rather than a reading of it.
- `lib/jobs/definitions/` — `attachmentGc`, `automationEngine`'s retention sweep,
  `codeGraphOffboardSweep`: the cron-sweep pattern §6 reuses.
- `package.json` — no `sentry`, `plausible`, `posthog`, `resend`, `postmark` or
  `upstash` dependency today (read 2026-08-10).
- `notes.html` #181 (a decision's answers are deliverables), #200 (capacity is a
  rung-2 fact), #241 (do not assert an unmeasured population), #248 (sweep the
  PLAN, not only the code).
