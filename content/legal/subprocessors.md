---
title: Subprocessors
version: 1.0.0
effectiveDate: TBD
status: approved
---

# Subprocessors

**This page covers the hosted Motir service at `app.motir.co`, operated by moooon B.V.
It does not describe a self-hosted installation.** If you run Motir yourself, you are
your own controller and you choose your own subprocessors; none of the companies below
receives your data unless you configure it to.

moooon B.V. (Menkemaborg 65, 8226 TB Lelystad, Netherlands, KvK 97763144) uses the companies below to
provide the hosted service. We publish this list so that a customer acting as a
controller can assess it, and we keep it current: the list is derived from what the
running application actually integrates with, not from a plan.

**This is the set as at general availability.** Motir is not yet generally
available, so no customer data has reached any company named here. The list
therefore describes what each company **will** receive once the service is live,
rather than sorting vendors into live and pending — a distinction that would be
meaningless while the answer for every row is the same. A company that will not be
part of the service at launch is not listed at all, and a company that joins later
is added here in the change that integrates it.

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

| Subprocessor                           | Purpose                                                           | Data reached                                                                                                                  | Location                              |
| -------------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| **Fly.io** (Fly.io, Inc.)              | Application hosting — Motir runs as a long-running Node process   | All data in transit through the application                                                                                   | Primary region `iad`, Ashburn, USA    |
| **Neon** (Neon Inc.)                   | Managed PostgreSQL — the primary database                         | All stored account, workspace and work-item data                                                                              | USA (co-located with the application) |
| **Tigris** (Tigris Data, Inc.)         | S3-compatible object storage, in **three** buckets — see below    | Uploaded files and their metadata; **and** code-graph snapshots derived from the repositories you connect                     | USA                                   |
| **Resend** (Resend, Inc.)              | Transactional email — invitations, password resets, notifications | Recipient address, name, and the message body                                                                                 | USA                                   |
| **Sentry** (Functional Software, Inc.) | Error monitoring — server, edge and browser                       | Error and performance events: stack traces, request URLs, and the IP address and user agent of the browser that hit the error | USA                                   |

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

| Subprocessor                                                       | Purpose                                                                                   | Data reached                                                            | Location                   |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | -------------------------- |
| **motir-ai** (moooon B.V.)                                         | Our own AI gateway — routing, metering, and the planning intelligence                     | Prompts, plan text, and the work-item content you ask it to reason over | Fly.io, region `iad`, USA  |
| **OpenAI** (OpenAI, L.L.C.)                                        | The language model that answers a planning request, and the embedding model behind search | The prompt text, and the content sent for embedding                     | USA                        |
| **Brave** (Brave Software, Inc.)                                   | Web search, when a planning request needs one                                             | The search query, which is derived from what you asked                  | USA                        |
| **DeepSeek** (Hangzhou DeepSeek Artificial Intelligence Co., Ltd.) | The language model serving the planner's default — see the transfer note below            | The prompt text, and the work-item content sent with it                 | People's Republic of China |

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

> **⚠️ DeepSeek is listed, and it is the one row on this page whose paperwork is
> incomplete.** It serves the planner's default model from mainland China, and it
> publishes **no Art. 28 processing agreement and no Standard Contractual Clauses**
> for its hosted API. We name it rather than omit it, because a customer assessing
> this list is entitled to weigh it. What that does and does not mean is set out in
> full under _Transfer bases_ below, including the fact that it is **removable
> without changing models** — DeepSeek publishes its weights under the MIT licence,
> and self-hosting them on our own EU infrastructure would remove the processor,
> the transfer and the gap together.

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

## Payments

| Subprocessor                                       | Purpose                           | Data reached                                                           | Location |
| -------------------------------------------------- | --------------------------------- | ---------------------------------------------------------------------- | -------- |
| **Stripe** (Stripe, Inc. / Stripe Payments Europe) | Payments and subscription billing | Billing contact details, subscription and seat counts, payment records | USA      |

Card numbers are entered on Stripe's own hosted checkout and **never reach Motir's
servers**. The `stripe` SDK is a production dependency of `motir-ai`, which ships the
checkout, portal, subscription, seat-sync and webhook routes.

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

| Vendor                                            | Basis                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Read from                                                                    |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| **Fly.io**                                        | **DPF-certified** — active participant under the EU–US Data Privacy Framework and its UK and Swiss extensions                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Fly.io's published DPF privacy policy                                        |
| **Resend**                                        | **DPF-certified** — EU–US DPF and the UK Extension                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Resend's own certification announcement                                      |
| **Neon**                                          | **SCCs** — its DPA incorporates the Commission-approved SCCs and the UK Addendum, and it also relies on the DPF                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Neon's published DPA                                                         |
| **Tigris**                                        | **SCCs** — its DPA incorporates the Approved EU SCCs with the UK Addendum, with the Irish supervisory authority named as competent for EEA data subjects                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Tigris's published Data Processing Addendum                                  |
| **OpenAI** (models + embeddings, via the gateway) | **SCCs** — Module 2 where we are controller, Module 3 where we are processor                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | OpenAI's published DPA                                                       |
| **Brave** (search, via the gateway)               | **SCCs** — the Brave Search API Data Processing Addendum incorporates the EU SCCs and the UK Addendum. Query records are retained for up to 90 days                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Brave's published Search API DPA                                             |
| **Plausible**                                     | **No Chapter V transfer** — established and hosted in the EU                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Its stated EU hosting                                                        |
| **Google** (optional sign-in)                     | **DPF-certified** — Google LLC is an active participant in the EU–US DPF, the UK Extension and the Swiss–US DPF, and states it relies on **SCCs** for transfers the framework does not cover. **CLOSED 2026-08-27**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Google's published data-transfer-frameworks page                             |
| **Sentry**                                        | **DPF-certified** — Functional Software, Inc. self-certifies to the EU–US DPF, the UK Extension and the Swiss–US framework, and its DPA (v5.1.0) offers the **EU SCCs** as the fallback should the framework not apply. **CLOSED 2026-08-27**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Sentry's published DPA and privacy pages                                     |
| **Spaceship (Spacemail)**                         | **SCCs** — its published Data Processing Addendum states that data may be transferred to the US and other non-adequate locations "using an approved transfer mechanism, such as the Standard Contractual Clauses", with the SCCs attached to the DPA and moooon B.V. as the controller/exporter. **Transfer basis CLOSED 2026-08-27**; whether this row belongs on the list at all remains an open counsel question, which is a different question                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Spaceship's published Data Processing Addendum                               |
| **DeepSeek** (planner models, via the gateway)    | **No Art. 28 processing agreement is on offer, and that — not the destination — is the gap.** DeepSeek publishes no data processing agreement and no SCCs for its hosted API, and its privacy policy states that personal data is processed and stored in the **People's Republic of China**, for which there is no EU adequacy decision. Two things follow, and they are routinely run together: **(a)** SCCs under Art. 46(2)(c) are available for _any_ third country, adequacy or not, so nothing about China forecloses a lawful transfer — the obstacle is that this vendor offers no clauses to sign; **(b)** because the model must read the prompt in plaintext, the supplementary measure the EDPB relies on (encryption where the importer holds no key) is unavailable, so a transfer impact assessment here would rest on contractual measures alone. **It is removable without changing models:** DeepSeek's weights are published under the MIT licence, and self-hosting them on EU infrastructure would remove the processor, the transfer and this row together. | DeepSeek's published privacy policy and open-platform terms, read 2026-08-27 |

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
- **DeepSeek offers neither**, and it serves the planner's default model. It
  publishes no processing agreement and no clauses, and it states that personal
  data is processed and stored in the People's Republic of China.
- **What that is, stated precisely.** It is a gap in one vendor's paperwork. It is
  **not** a consequence of where that vendor is established: Art. 46(2)(c) SCCs
  are available for transfers to any third country, and an EU controller may use a
  Chinese processor that signs them. Nor do the European regulatory actions say
  otherwise — Italy's authority ordered **DeepSeek** to stop processing Italian
  users' data through its consumer app, and the investigations opened in France,
  Ireland, Germany, Belgium and Portugal are of the same kind. They are findings
  about DeepSeek as a controller of its own users. None of them restricts a
  European company from calling the API.
- **The decision is to list it and say so**, rather than to omit it or to drop the
  model. A subprocessor list is worth reading only if it names the uncomfortable
  row, and this is ours. The escape route, if a customer needs it closed, is
  self-hosting the MIT-licensed weights on EU infrastructure — which removes the
  processor rather than replacing the model.

Of the three rows that were open on 2026-08-26, **two are now closed** —
**Google** (DPF-certified, plus SCCs where the framework does not reach) and
**Spaceship** (a published DPA incorporating the SCCs). What remains open is
recorded here rather than resolved silently:

- **Spaceship — one open question remains, and it is not a transfer question.**
  Whether corporate correspondence belongs on a published subprocessor list is
  for counsel (MOTIR-3621).
- **DeepSeek's processing agreement — OPEN, and disclosed rather than gating.**
  No Art. 28 agreement is on offer, so the row above carries a gap a customer may
  weigh. It does not block publication: this page's job is to state the position
  accurately, and an omitted row would serve a reader worse than a candid one.
  Reopened if DeepSeek publishes a DPA, if a supervisory authority addresses
  business use of the API, or if a customer requires it closed.

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

| Surface                                                                     | Yielded                                                                                                                                          |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `motir-gateway` — the **channel table**, read from inside a running machine | **OpenAI** (enabled) · **DeepSeek** (enabled — serves the planner default) · Anthropic, Moonshot (both disabled, so neither receives anything)   |
| `motir-gateway` — the **per-call-unit** path, `motir/search/`               | **Brave** — and only Brave. Exactly one priced unit, `search.brave`, with one provider implementing it                                           |
| `motir-gateway` — its **option table** (OAuth providers, SMTP)              | **Nothing.** No OAuth provider is enabled and no SMTP server is configured, so the relay's own login and mail paths reach no third party         |
| `motir-core` — dependency manifest                                          | **Tigris** (S3 SDK) · **Sentry** (`@sentry/nextjs`, merged 2026-08-27 — this row said "no Sentry SDK" hours earlier) · no Stripe SDK             |
| `motir-core` — outbound HTTP hosts in application code                      | **GitHub** · **GitLab** · **Atlassian** · **Linear** · **Plane** · **Google** (OAuth) · **Resend** · **Plausible** · **Fly** (machines API)      |
| `motir-ai` — dependency manifest                                            | **Tigris** (S3 SDK) · **Stripe** — the SDK this page previously said did not exist                                                               |
| `motir-ai` — outbound HTTP hosts in application code                        | **Nothing new.** Its model and search calls go to moooon B.V.'s own gateway, not to a provider                                                   |
| **`motir-core`** Fly secret names                                           | **Sentry** — configured in production, ahead of its code · everything else already listed                                                        |
| **`motir-ai`** Fly secret names                                             | **Stripe** — live keys in production · **Tigris** as its object store, in a third bucket this page did not describe                              |
| **`motir-gateway`** Fly secret names                                        | **Brave** only. The model-provider credentials are not here — see the blind spot above                                                           |
| The agent-runner fleet (`motir-ci-runners`, `motir-index-runners`)          | **Nothing.** Both hold **no secrets at all**; they are machine pools, credentialed per machine at creation, and introduce no vendor of their own |

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
