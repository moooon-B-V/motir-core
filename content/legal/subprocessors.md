---
title: Subprocessors
version: 0.1.0-draft
effectiveDate: TBD
status: draft
---

# Subprocessors

**This page covers the hosted Motir service at `app.motir.co`, operated by moooon B.V.
It does not describe a self-hosted installation.** If you run Motir yourself, you are
your own controller and you choose your own subprocessors; none of the companies below
receives your data unless you configure it to.

> **⚠️ DRAFT — not yet reviewed by counsel and not yet published.** Pending
> MOTIR-3621. The transfer-basis column is incomplete by design: see
> _Transfer bases_ below.

moooon B.V. (Menkemaborg 65, 8226 TB Lelystad, Netherlands, KvK 97763144) uses the companies below to
provide the hosted service. We publish this list so that a customer acting as a
controller can assess it, and we keep it current: the list is derived from what the
running application actually integrates with, not from a plan.

**Last reviewed: 2026-08-27**, in three passes that are not interchangeable and are
recorded separately throughout this page:

| Pass                | What it read                                                                                                                                  | Date           |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| **Repository read** | The dependency manifests and outbound HTTP clients of `motir-core`, `motir-ai` and `motir-gateway`, at each repository's `origin/main`        | **2026-08-27** |
| **Platform read**   | The three Fly applications' secret NAMES and running environment, and the gateway's own channel and option tables, read from inside a machine | **2026-08-27** |
| **Vendor read**     | Each vendor's own published terms, for the transfer basis                                                                                     | **2026-08-27** |

**The distinction is load-bearing, not bookkeeping.** A repository read cannot see
an integration that is configured but not yet coded, and it cannot see one whose
credentials live in a service's own database rather than in source. A platform read
cannot see an integration that is coded but not yet configured. **The passes have
to be able to disagree before the list is trustworthy, and on this review they
did** —
see _How this list is compiled_ at the foot of the page, which states the method in
full and names every surface walked.

`docs/decisions/ai-upstream-transfer-basis.md` records how the gateway's channel
set was first read, and what it decided.

---

## Core subprocessors — every hosted customer

These receive data as a necessary part of running the service. There is no way to use
the hosted service without them.

| Subprocessor                                                 | Purpose                                                                                                                                                                      | Data reached                                                                                                                  | Location                              |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| **Fly.io** (Fly.io, Inc.)                                    | Application hosting — Motir runs as a long-running Node process                                                                                                              | All data in transit through the application                                                                                   | Primary region `iad`, Ashburn, USA    |
| **Neon** (Neon Inc.)                                         | Managed PostgreSQL — the primary database                                                                                                                                    | All stored account, workspace and work-item data                                                                              | USA (co-located with the application) |
| **Tigris** (Tigris Data, Inc.)                               | S3-compatible object storage, in **three** buckets — see below                                                                                                               | Uploaded files and their metadata; **and** code-graph snapshots derived from the repositories you connect                     | USA                                   |
| **Inngest** (Inngest, Inc.) ⚠️ **BEING RETIRED — see below** | Durable background-job queue. **Being replaced by an in-product Postgres queue; still carries the 14 scheduled jobs and 3 container supervisors that have not yet cut over** | Job payloads, which reference work items and may carry their content                                                          | USA                                   |
| **Resend** (Resend, Inc.)                                    | Transactional email — invitations, password resets, notifications                                                                                                            | Recipient address, name, and the message body                                                                                 | USA                                   |
| **Sentry** (Functional Software, Inc.)                       | Error monitoring — server, edge and browser                                                                                                                                  | Error and performance events: stack traces, request URLs, and the IP address and user agent of the browser that hit the error | USA                                   |

**The three Tigris buckets**, because the count and the third bucket's contents
both changed at this review: `motir-core-public` (public assets) and
`motir-core-private` (file attachments) hold what you upload. A third,
`motir-codegraph-snap`, holds **code-graph snapshots built from the repositories a
workspace connects** — a different category of data from an uploaded file, and one
this page did not previously describe. It is the same vendor, the same region and
the same transfer basis; only the description was incomplete.

## Sign-in

| Subprocessor                                  | Purpose                 | Data reached                                                                                  | Location |
| --------------------------------------------- | ----------------------- | --------------------------------------------------------------------------------------------- | -------- |
| **Google** (Google Ireland Ltd. / Google LLC) | Optional Google sign-in | Your Google account identifier, name and email address, **only if you choose Google sign-in** | Global   |

Email-and-password sign-in reaches no third party.

## Product analytics

| Subprocessor                          | Purpose                     | Data reached                                                                       | Location               |
| ------------------------------------- | --------------------------- | ---------------------------------------------------------------------------------- | ---------------------- |
| **Plausible** (Plausible Insights OÜ) | Aggregate product analytics | Page-level usage events. **Cookieless**, and it does not identify individual users | EU (Estonia / Germany) |

## AI features — only when you use them

Motir's AI planning features send the text you provide to **motir-ai**, moooon B.V.'s
own gateway, which forwards it to an upstream model provider. **If you never use an AI
feature, no prompt data leaves the core service.**

| Subprocessor                     | Purpose                                                                                   | Data reached                                                            | Location                  |
| -------------------------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------- |
| **motir-ai** (moooon B.V.)       | Our own AI gateway — routing, metering, and the planning intelligence                     | Prompts, plan text, and the work-item content you ask it to reason over | Fly.io, region `iad`, USA |
| **OpenAI** (OpenAI, L.L.C.)      | The language model that answers a planning request, and the embedding model behind search | The prompt text, and the content sent for embedding                     | USA                       |
| **Brave** (Brave Software, Inc.) | Web search, when a planning request needs one                                             | The search query, which is derived from what you asked                  | USA                       |

**The upstream set was read from the gateway on 2026-08-26 and RE-READ on
2026-08-27**, not inferred from the code. motir-ai does not call a model provider
directly: it posts to moooon B.V.'s own **gateway** over an OpenAI-compatible
interface, and the gateway is a multi-provider relay whose enabled upstream
_channels_ live in its own administration rather than in source. The table above
lists the model provider that serves customer content. A separate per-call
upstream, the **Brave Search API**, serves web search when a planning request needs
one; the gateway's per-call-unit path prices exactly one unit, `search.brave`, so
Brave is the whole of that path.

**Only providers with a recorded transfer basis may serve this traffic.** That is
decided in `docs/decisions/ai-upstream-transfer-basis.md`, which enumerates every
enabled upstream, records its basis, and requires the gateway to enforce the
constraint rather than merely state it. Each provider above has its own row in
_Transfer bases_ below.

> **⚠️ Contingency — this section describes the DECIDED state, and neither step of
> it is applied yet. RE-READ 2026-08-27: the DeepSeek channel is STILL ENABLED.**
> The channel table was read again on 2026-08-27 by the method in _How this list
> is compiled_ below, and returned the same four rows as on 2026-08-26: **DeepSeek
> `status: 1` (enabled)**, OpenAI `status: 1` (enabled), Anthropic and Moonshot
> `status: 2` (disabled). DeepSeek serves the planner's default model from mainland
> China with no Chapter V transfer basis. The decision record retires it: the
> planner's default moves to an OpenAI model first, and the DeepSeek channel is
> disabled second.
> **This page does not publish until both steps are applied and the channel set
> has been re-read to confirm it** — the same kind of publication precondition
> `docs/decisions/legal-document-set.md` §3 sets for the registered address. The
> re-read is what this contingency asks for, and it currently returns _not yet_.

## Optional integrations — only if you connect them

These are connected by you, per workspace, and they receive or supply data only for the
workspace that authorised them. **A workspace that connects nothing reaches none of
them.** In most of these the flow is inbound — we read data you already hold there.

| Service                                  | Purpose                                                                                                                 | Direction                                                                                 |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| **GitHub** (GitHub, Inc. / Microsoft)    | Repository access, pull-request and CI status, and the agent-dispatch workflow. The most commonly connected integration | Both — we read repository and pull-request data, and we act on repositories you authorise |
| **GitLab** (GitLab Inc.)                 | Repository connection                                                                                                   | Both                                                                                      |
| **Atlassian / Jira** (Atlassian Corp.)   | Issue import                                                                                                            | Inbound                                                                                   |
| **Linear** (Linear Orbit, Inc.)          | Issue import                                                                                                            | Inbound                                                                                   |
| **Plane** (Plane / self-hosted instance) | Issue import                                                                                                            | Inbound — the endpoint is whichever instance you name                                     |

## Corporate correspondence

| Subprocessor              | Purpose                                                                                                                            | Data reached                     | Location |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- | -------- |
| **Spaceship (Spacemail)** | The `motir.co` mailbox that receives the addresses printed in our published documents — privacy, security and legal correspondence | The content of email you send us | —        |

**⚠️ Open counsel question — and it is now only ONE question, not two.** This row
receives personal data that arrives _outside_ the product, from people who may not be
users at all. Whether that makes it a subprocessor of the service — belonging on this
published list — or simply a vendor of moooon B.V.'s own correspondence, is a judgement
this draft deliberately leaves open rather than resolving in either direction. Pending
MOTIR-3621. **Its transfer basis is no longer open:** Spaceship publishes a Data
Processing Addendum incorporating the SCCs, read 2026-08-27 and recorded in _Transfer
bases_ below. The two were previously entangled in one "not confirmed" cell, which
made a readable fact look like a legal judgement.

---

## Not yet subprocessors — planned, and receiving nothing today

**Listing a company that receives no data would be a false statement**, so these are
recorded separately rather than in the tables above. Each moves up when the integration
actually ships, and this page is amended in the same change.

| Company                                            | Intended purpose                  | Status on 2026-08-27                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------------------------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Stripe** (Stripe, Inc. / Stripe Payments Europe) | Payments and subscription billing | **Receives no payment data today — but it IS integrated.** The `stripe` SDK is a production dependency of `motir-ai`, which ships live checkout, portal, subscription, seat-sync and webhook routes, and `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` are set on the running application. The account behind that key is a **sandbox** — `charges_enabled: false`, `details_submitted: false`, read from Stripe on 2026-08-27 — so it cannot take a payment. **It begins receiving when a live account is activated** |

**⚠️ Both rows above previously gave a reason that was FALSE, and both errors ran
the same way.** The page said of Sentry that "no configuration exists" and of
Stripe that "no SDK dependency exists". Sentry's configuration existed on the
platform; Stripe's SDK exists in `motir-ai`. The verdict — _receives nothing
today_ — survives in both cases, and that is exactly what made the errors
survivable: **a right answer for a wrong reason reads identically to a right
answer.** The reasons are restated above because a reader assessing this list is
entitled to check them, and because the two rows now say what would have to change
for the verdict to flip, which the old reasons could not.

---

## Transfer bases

Most of the companies above are established in the United States and receive personal
data from a controller established in the Netherlands. That is lawful **conditionally**,
and the condition is a mechanism under Chapter V of the GDPR — either the receiving
organisation's certification under the EU–US Data Privacy Framework, or Standard
Contractual Clauses.

**Read per vendor, from each vendor's own published terms** — the rows carried over
from 2026-08-26, and the three previously-open rows re-read on **2026-08-27**.
Recorded below rather than assumed. A row marked _not confirmed_ is an open item,
not a pass.

| Vendor                                            | Basis                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Read from                                                                     |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| **Fly.io**                                        | **DPF-certified** — active participant under the EU–US Data Privacy Framework and its UK and Swiss extensions                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Fly.io's published DPF privacy policy                                         |
| **Resend**                                        | **DPF-certified** — EU–US DPF and the UK Extension                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Resend's own certification announcement                                       |
| **Neon**                                          | **SCCs** — its DPA incorporates the Commission-approved SCCs and the UK Addendum, and it also relies on the DPF                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Neon's published DPA                                                          |
| **Tigris**                                        | **SCCs** — its DPA incorporates the Approved EU SCCs with the UK Addendum, with the Irish supervisory authority named as competent for EEA data subjects                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Tigris's published Data Processing Addendum                                   |
| **OpenAI** (models + embeddings, via the gateway) | **SCCs** — Module 2 where we are controller, Module 3 where we are processor                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | OpenAI's published DPA                                                        |
| **Brave** (search, via the gateway)               | **SCCs** — the Brave Search API Data Processing Addendum incorporates the EU SCCs and the UK Addendum. Query records are retained for up to 90 days                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Brave's published Search API DPA                                              |
| **Plausible**                                     | **No Chapter V transfer** — established and hosted in the EU                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Its stated EU hosting                                                         |
| **Google** (optional sign-in)                     | **DPF-certified** — Google LLC is an active participant in the EU–US DPF, the UK Extension and the Swiss–US DPF, and states it relies on **SCCs** for transfers the framework does not cover. **CLOSED 2026-08-27**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Google's published data-transfer-frameworks page                              |
| **Sentry**                                        | **DPF-certified** — Functional Software, Inc. self-certifies to the EU–US DPF, the UK Extension and the Swiss–US framework, and its DPA (v5.1.0) offers the **EU SCCs** as the fallback should the framework not apply. **CLOSED 2026-08-27**                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Sentry's published DPA and privacy pages                                      |
| **Inngest**                                       | **NO CHAPTER V MECHANISM, and none will be sought — the dependency is being REMOVED instead.** Inngest's Terms of Service and Privacy Policy carry **no DPA, no SCCs and no international-transfer language at all**; its Trust Center is access-gated. Its **SOC 2 Type II** is a security-control audit and is **not** a Chapter V transfer mechanism — named here to be refused explicitly, because the two are routinely confused. **The remedy is retirement, not a vendor agreement:** MOTIR-3413 replaces it with an in-product Postgres queue, and MOTIR-3418 deletes the SDK. **Publication of this page is gated on that deletion, so Inngest is expected to leave this list before anyone reads it published.** | Inngest's Terms and Privacy Policy, read 2026-08-27; remedy set by MOTIR-3628 |
| **Spaceship (Spacemail)**                         | **SCCs** — its published Data Processing Addendum states that data may be transferred to the US and other non-adequate locations "using an approved transfer mechanism, such as the Standard Contractual Clauses", with the SCCs attached to the DPA and moooon B.V. as the controller/exporter. **Transfer basis CLOSED 2026-08-27**; whether this row belongs on the list at all remains an open counsel question, which is a different question                                                                                                                                                                                                                                                                         | Spaceship's published Data Processing Addendum                                |
| **DeepSeek** (retired — see below)                | **NONE.** Its policy names no SCCs and no other Chapter V mechanism, and it states that personal data is processed and stored in the People's Republic of China                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | DeepSeek's published privacy policy                                           |

### The AI upstream — settled on 2026-08-26, and how

This was the one open row on this page, and it carries the most sensitive payload
on it: whatever a customer typed, plus the work-item content they asked the
planner to reason over. It is settled in
`docs/decisions/ai-upstream-transfer-basis.md`. The short version:

- **The enabled channel set was read from the gateway's own administration**, not
  from any repository — the fact this page previously said it could not settle.
  Two model channels were enabled: **OpenAI** and **DeepSeek**.
- **OpenAI carries SCCs**, and is the model provider this page lists. **Brave**,
  which serves web search through the same gateway, carries SCCs too.
- **DeepSeek carries none.** Its own privacy policy states that it processes and
  stores personal data **in the People's Republic of China** — a country with no
  EU adequacy decision — and names no Standard Contractual Clauses, only a
  generic reference to _"appropriate safeguards"_. European regulators have acted
  against the hosted service: Italy's authority blocked the consumer app in
  January 2025, and authorities in France, Ireland, Germany, Belgium and Portugal
  opened investigations.
- **The decision is that DeepSeek is retired and the constraint is enforced at
  the gateway**, so that no later configuration change can route this content to
  an upstream without a basis. The enforcement is tracked as its own work item,
  and the contingency note under _AI features_ says what is not applied yet.

**This page does not publish until every row above carries a recorded basis and
the AI contingency is discharged.** Of the three rows that were open on
2026-08-26, **two are now closed** — **Google** (DPF-certified, plus SCCs where
the framework does not reach) and **Spaceship** (a published DPA incorporating
the SCCs). **One remains open, and it is the one that matters most:**

- **Inngest — OPEN, and closing by REMOVAL rather than by agreement.** A core
  subprocessor today, receiving job payloads that reference work items and may
  carry their content, with **no published Chapter V transfer mechanism of any
  kind**. Its SOC 2 Type II attestation does not answer this.
  **No DPA will be requested**, because the dependency is being retired:
  MOTIR-3413 replaces it with an in-product Postgres queue, and MOTIR-3418
  deletes the SDK. The event-triggered jobs are already cut over in production;
  the 14 scheduled jobs and 3 container supervisors are not yet.
  **Publication of this page is gated on MOTIR-3418** (MOTIR-1134 is
  `blocked_by` it), so this row is expected to be deleted — not resolved —
  before anyone reads this page published. MOTIR-3628 owns that deletion.
- **Spaceship — one open question remains, and it is not a transfer question.**
  Whether corporate correspondence belongs on a published subprocessor list is
  for counsel (MOTIR-3621).
- **The AI contingency — OPEN.** The DeepSeek channel was still enabled on the
  2026-08-27 re-read. See _AI features_ above.

---

## How this list is compiled

This page claims to be _"derived from what the running application actually
integrates with, not from a plan."_ **On 2026-08-26 that claim was falsified**: the
Brave Search API was a live upstream, receiving search queries derived from what
customers asked the planner, and it appeared nowhere on this page — not in a table,
not under _Not yet subprocessors_, not in _Transfer bases_. It was found by a
different piece of work that happened to be reading the gateway for an unrelated
reason.

**One missed row does not tell you how many others there are. It tells you the
method had not been shown to be complete.** So the method is written down here,
and the enumeration was re-run against it. A reader who wants to check this list
rather than trust it can repeat every step below.

### Why the original method missed one

The original enumeration walked **model providers**: it read `motir-ai` for the
provider it calls, and the gateway for its channel table. Brave is neither. It is
reached on the gateway's **per-call-unit** billing path rather than through a
channel row, so a walk of providers cannot see it however carefully it is done.
**The blind spot is structural, not careless** — and the same shape covers anything
else reached on a path the walk does not traverse.

**So the method enumerates EGRESS, not providers.** Any outbound path that carries
data is in scope, whether or not it looks like a model provider, an SDK, or an
integration.

### The three passes

**No one pass is sufficient, and the method depends on their disagreement.**

1. **Repository read** — at each repository's `origin/main`, never a working tree:
   the dependency manifest, and every outbound HTTP host in application code.
2. **Platform read** — the running deployment: each Fly application's secret
   NAMES, its actual environment values for endpoints, and the gateway's own
   channel and option tables. **A configuration file is a claim about a
   deployment; the machine is the deployment.**
3. **Vendor read** — each vendor's own published terms, for the transfer basis.

**Secret names are the pass that catches what code cannot.** An integration that is
provisioned before it is coded exists only as a credential; one that is coded but
never provisioned exists only in source. Sentry and Stripe are one of each on this
review, and neither is visible to the other pass.

**And the platform pass has its own blind spot, named here so it is not
rediscovered:** the gateway's model-provider credentials are **not** Fly secrets —
they are rows in the gateway's own database. `fly secrets list -a motir-gateway`
returns one upstream credential, Brave's, and no model provider at all. That is
precisely where DeepSeek hides from a secret-name sweep, and it is why the channel
table is read separately and from inside the machine.

### Every surface walked, and what it yielded

Read 2026-08-27. **A row that yielded nothing is recorded, not omitted** — an
absent row and an unexamined surface are indistinguishable otherwise.

| Surface                                                                     | Yielded                                                                                                                                            |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `motir-gateway` — the **channel table**, read from inside a running machine | **OpenAI** (enabled) · **DeepSeek** (enabled — the open contingency) · Anthropic, Moonshot (both disabled, so neither receives anything)           |
| `motir-gateway` — the **per-call-unit** path, `motir/search/`               | **Brave** — and only Brave. Exactly one priced unit, `search.brave`, with one provider implementing it                                             |
| `motir-gateway` — its **option table** (OAuth providers, SMTP)              | **Nothing.** No OAuth provider is enabled and no SMTP server is configured, so the relay's own login and mail paths reach no third party           |
| `motir-core` — dependency manifest                                          | **Tigris** (S3 SDK) · **Inngest** · **Sentry** (`@sentry/nextjs`, merged 2026-08-27 — this row said "no Sentry SDK" hours earlier) · no Stripe SDK |
| `motir-core` — outbound HTTP hosts in application code                      | **GitHub** · **GitLab** · **Atlassian** · **Linear** · **Plane** · **Google** (OAuth) · **Resend** · **Plausible** · **Fly** (machines API)        |
| `motir-ai` — dependency manifest                                            | **Tigris** (S3 SDK) · **Stripe** — the SDK this page previously said did not exist                                                                 |
| `motir-ai` — outbound HTTP hosts in application code                        | **Nothing new.** Its model and search calls go to moooon B.V.'s own gateway, not to a provider                                                     |
| **`motir-core`** Fly secret names                                           | **Sentry** — configured in production, ahead of its code · everything else already listed                                                          |
| **`motir-ai`** Fly secret names                                             | **Stripe** — live keys in production · **Tigris** as its object store, in a third bucket this page did not describe                                |
| **`motir-gateway`** Fly secret names                                        | **Brave** only. The model-provider credentials are not here — see the blind spot above                                                             |
| The agent-runner fleet (`motir-ci-runners`, `motir-index-runners`)          | **Nothing.** Both hold **no secrets at all**; they are machine pools, credentialed per machine at creation, and introduce no vendor of their own   |

### Two things that look like subprocessors and are not

Recorded because each is a plausible false positive, and an enumeration that
silently drops one is indistinguishable from one that never looked.

- **Google Fonts.** The application loads its typefaces through `next/font/google`,
  which downloads them **at build time and self-hosts them**. A visitor's browser
  makes no request to Google, so no IP address reaches Google by this path. (Google
  is a subprocessor on this page for a different reason: optional sign-in.)
- **The coding agents.** Motir generates an agent-ready prompt; the agent runs
  under **your own credential**, on your machine or in your sandbox. Its vendor is
  not a subprocessor of the hosted service, because moooon B.V. never transmits to
  it.

### What has to be re-run, and when

Before any change to this page, and at each `Last reviewed` date: **all three
passes, all of the surfaces above.** A change to one repository does not license a
single-repository re-read — the row this page missed was in neither the repository
that was being read nor the one that was being edited.

---

## Changes to this list

We will update this page before a new subprocessor begins processing, and record the
date of each change. If you have a data-processing agreement with us, the notification
and objection terms in that agreement apply.

Questions: **privacy@motir.co**.
