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

## AI features — the model you choose

Motir's AI features — planning, and the hosted agents that carry out the work — send
the text you provide to a **model provider you select**. **If you never use an AI
feature, no prompt data leaves the core service.**

**moooon B.V. operates its own relay between the two, and it is NOT a subprocessor.**
`motir-ai` and `motir-gateway` are our own services, run by the same legal entity that
operates Motir. A subprocessor is a _third party_ a processor engages; these are us,
and listing them here would pad this page with our own server names while telling you
nothing about who else can see your data. What they run **on** is a different question
and a real one: they are hosted by **Fly.io**, which is a subprocessor and is listed
under _Core subprocessors_ above.

So the chain is `Motir → our gateway → the provider you chose`, and the only rows below
are that last hop.

| Subprocessor                                                       | Purpose                                                   | Data reached                                            | Location                    |
| ------------------------------------------------------------------ | --------------------------------------------------------- | ------------------------------------------------------- | --------------------------- |
| **OpenAI** (OpenAI, L.L.C.)                                        | A selectable model, and the embedding model behind search | The prompt text, and the content sent for embedding     | USA                         |
| **Anthropic** (Anthropic PBC)                                      | A selectable model (Claude)                               | The prompt text, and the work-item content sent with it | USA                         |
| **Alibaba Cloud** (Alibaba Cloud Computing Ltd.)                   | A selectable model (Qwen), served from Model Studio       | The prompt text, and the work-item content sent with it | **Frankfurt, Germany (EU)** |
| **Zhipu AI** (Beijing Zhipu Huazhang Technology Co., Ltd.)         | A selectable model (GLM)                                  | The prompt text, and the work-item content sent with it | People's Republic of China  |
| **Moonshot AI** (Beijing Moonshot Technology Co., Ltd.)            | A selectable model (Kimi)                                 | The prompt text, and the work-item content sent with it | People's Republic of China  |
| **DeepSeek** (Hangzhou DeepSeek Artificial Intelligence Co., Ltd.) | A planner model                                           | The prompt text, and the work-item content sent with it | People's Republic of China  |
| **Brave** (Brave Software, Inc.)                                   | Web search, when a planning request needs one             | The search query, which is derived from what you asked  | USA                         |

**The set was read from the gateway's own administration on 2026-08-26 and RE-READ
on 2026-08-27**, not inferred from source. Our gateway is a multi-provider relay
whose enabled upstream _channels_ live in its own database rather than in a
repository, which is why the read has to happen against the running service — see
_How this list is compiled_ below. **Brave** is the one non-model upstream: it
serves web search when a request needs one, and the gateway's per-call-unit path
prices exactly one unit, `search.brave`, so Brave is the whole of that path.

**⚠️ This table names the providers that may serve you, not a fixed assignment.**
Which one answers a given request depends on the model selected for that project —
and, once hosted agents ship, on the model selected for the agent, which need not
be the same one. A provider is listed here if it **can** receive your content,
because that is the question a subprocessor list exists to answer. The transfer
position of each is what differs, and it is set out next.

**Only providers with a recorded transfer basis may serve EU traffic**, and that is
enforced at the gateway — a residency group a no-basis upstream cannot enter —
rather than by convention. `docs/decisions/ai-upstream-transfer-basis.md` carries
the decision. Each provider above has its own row in _Transfer bases_ below.

### The model providers fall into three tiers, and the difference is the paperwork

They are not interchangeable from a data-protection standpoint, and a list that
presented them as one undifferentiated block would hide the only distinction a
reader actually needs.

**Tier 1 — no transfer at all.** **Alibaba Cloud** serves Qwen from **Model Studio's
Frankfurt region**, and the workspace deployment scope is pinned to the EU, so
inference stays inside the Union. Chapter V does not engage. This is the strongest
position on the page, and it belongs to a Chinese company's model — which is worth
saying plainly, because the intuition that a Chinese model implies a Chinese
transfer is wrong, and it is the whole reason this section is tiered by paperwork
rather than by flag.

**Tier 2 — a third-country transfer with the full instrument.** **OpenAI** and
**Anthropic** each publish an Art. 28 processing agreement with the Commission's
Standard Contractual Clauses (Modules 2 and 3, Decision 2021/914) incorporated.
**Brave** does the same for search. These are ordinary, documented transfers.

**Tier 3 — no processing agreement is on offer.** **DeepSeek**, **Zhipu AI** (GLM)
and **Moonshot AI** (Kimi) publish no Art. 28 agreement and no clauses for their
hosted APIs. What that means, and what it does not, is set out in full under
_Transfer bases_ below. In short: it is a gap in three vendors' paperwork, **not** a
consequence of where they are established — SCCs are available for any third
country, and Tier 1 is a Chinese provider with a clean instrument.

> **⚠️ You choose which tier serves your workspace.** The planner model is a
> per-project setting, not something we pick for you. **At general availability the
> DEFAULT will be a Tier 1 or Tier 2 provider**, so reaching a Tier 3 model is a
> deliberate choice made with this page in front of you. That is a commitment about
> launch and not a description of today: the current default is a Tier 3 model,
> which is accurate to state on a page nobody can yet sign up to and would not be
> accurate to state on one they could. It is enforced at the gateway — a residency
> group that a no-basis upstream cannot enter — rather than by convention, so that
> a later configuration change cannot quietly undo it. That is the same shape the
> large model gateways use — the provider is selected by the customer, and the
> gateway's job is to make the selection informed and to enforce it — and it is why
> this page tiers the providers instead of averaging them.

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

| Vendor                                            | Basis                                                                                                                                                                                                                                                                                                                                                                                                                                              | Read from                                                                    |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| **Fly.io**                                        | **DPF-certified** — active participant under the EU–US Data Privacy Framework and its UK and Swiss extensions                                                                                                                                                                                                                                                                                                                                      | Fly.io's published DPF privacy policy                                        |
| **Resend**                                        | **DPF-certified** — EU–US DPF and the UK Extension                                                                                                                                                                                                                                                                                                                                                                                                 | Resend's own certification announcement                                      |
| **Neon**                                          | **SCCs** — its DPA incorporates the Commission-approved SCCs and the UK Addendum, and it also relies on the DPF                                                                                                                                                                                                                                                                                                                                    | Neon's published DPA                                                         |
| **Tigris**                                        | **SCCs** — its DPA incorporates the Approved EU SCCs with the UK Addendum, with the Irish supervisory authority named as competent for EEA data subjects                                                                                                                                                                                                                                                                                           | Tigris's published Data Processing Addendum                                  |
| **OpenAI** (models + embeddings, via the gateway) | **SCCs** — Module 2 where we are controller, Module 3 where we are processor                                                                                                                                                                                                                                                                                                                                                                       | OpenAI's published DPA                                                       |
| **Brave** (search, via the gateway)               | **SCCs** — the Brave Search API Data Processing Addendum incorporates the EU SCCs and the UK Addendum. Query records are retained for up to 90 days                                                                                                                                                                                                                                                                                                | Brave's published Search API DPA                                             |
| **Anthropic** (Claude, via the gateway)           | **DPA + SCCs** — Anthropic's Data Processing Addendum incorporates the Commission's Standard Contractual Clauses (Module 2 where we are controller, Module 3 where we are processor, Decision 2021/914), automatically on acceptance of its commercial terms. Zero-Data-Retention is available and is the configuration we use where a model supports it                                                                                           | Anthropic's published Data Processing Addendum                               |
| **Alibaba Cloud** (Qwen, via the gateway)         | **NO CHAPTER V TRANSFER — inference is EU-resident.** Qwen is served from Model Studio's **Frankfurt** region with the workspace deployment scope pinned to the EU, so the personal data does not leave the Union and Chapter V does not engage. Alibaba Cloud additionally publishes an **EEA Data Processing Addendum incorporating the SCCs** (Decision 2021/914), which governs anything that falls outside that scope                         | Alibaba Cloud's published EEA DPA and Model Studio region documentation      |
| **Zhipu AI** (GLM, via the gateway)               | **No Art. 28 processing agreement is on offer.** The `open.bigmodel.cn` platform publishes no DPA and no SCCs, and neither China nor Singapore has an EU adequacy decision. See _The three providers without a processing agreement_ below. **Removable without changing models:** GLM's weights are published under the MIT licence                                                                                                               | Zhipu's published open-platform terms, read 2026-08-27                       |
| **Moonshot AI** (Kimi, via the gateway)           | **No Art. 28 processing agreement is on offer.** Moonshot publishes no DPA and no SCCs for the hosted Kimi API, and it is established in Beijing. See _The three providers without a processing agreement_ below                                                                                                                                                                                                                                   | Moonshot's published Kimi Open Platform terms, read 2026-08-27               |
| **Plausible**                                     | **No Chapter V transfer** — established and hosted in the EU                                                                                                                                                                                                                                                                                                                                                                                       | Its stated EU hosting                                                        |
| **Google** (optional sign-in)                     | **DPF-certified** — Google LLC is an active participant in the EU–US DPF, the UK Extension and the Swiss–US DPF, and states it relies on **SCCs** for transfers the framework does not cover. **CLOSED 2026-08-27**                                                                                                                                                                                                                                | Google's published data-transfer-frameworks page                             |
| **Sentry**                                        | **DPF-certified** — Functional Software, Inc. self-certifies to the EU–US DPF, the UK Extension and the Swiss–US framework, and its DPA (v5.1.0) offers the **EU SCCs** as the fallback should the framework not apply. **CLOSED 2026-08-27**                                                                                                                                                                                                      | Sentry's published DPA and privacy pages                                     |
| **Spaceship (Spacemail)**                         | **SCCs** — its published Data Processing Addendum states that data may be transferred to the US and other non-adequate locations "using an approved transfer mechanism, such as the Standard Contractual Clauses", with the SCCs attached to the DPA and moooon B.V. as the controller/exporter. **Transfer basis CLOSED 2026-08-27**; whether this row belongs on the list at all remains an open counsel question, which is a different question | Spaceship's published Data Processing Addendum                               |
| **DeepSeek** (planner models, via the gateway)    | **No Art. 28 processing agreement is on offer**, and its privacy policy states that personal data is processed and stored in the **People's Republic of China**. See _The three providers without a processing agreement_ below. **Removable without changing models:** DeepSeek's weights are published under the MIT licence                                                                                                                     | DeepSeek's published privacy policy and open-platform terms, read 2026-08-27 |

### The three providers without a processing agreement

The model providers carry the most sensitive payload on this page — whatever a
customer typed, plus the work-item content they asked the planner to reason over.
**Three of the six publish no Art. 28 processing agreement and no Standard
Contractual Clauses for their hosted APIs: DeepSeek, Zhipu AI (GLM) and Moonshot
AI (Kimi).** This section says what that is, because the question is asked often
and answered badly.

**It is a gap in three vendors' paperwork. It is not a consequence of where they
are established.** Art. 46(2)(c) SCCs are available for transfers to any third
country, adequacy decision or not, and an EU controller may lawfully use a Chinese
processor that signs them. The demonstration is on this very page: **Alibaba
Cloud** is a Chinese company, and it carries both an EEA DPA with the SCCs and
EU-resident inference — a stronger position than any US provider listed here. The
obstacle for these three is that they offer no clauses to sign, and an EU-
established vendor with the same gap would be in exactly the same position.

**The European regulatory actions do not say otherwise**, and they are routinely
misread. Italy's authority ordered **DeepSeek** to stop processing Italian users'
data through its consumer app, and the investigations opened in France, Ireland,
Germany, Belgium and Portugal are of the same kind: findings about DeepSeek as
controller of its own users. **None of them restricts a European company from
calling the API.**

**What the gap does mean.** Because a model must read the prompt in plaintext, the
supplementary measure the EDPB relies on — encryption where the importer holds no
key — is structurally unavailable, so a transfer impact assessment for these three
would rest on contractual measures alone. That is a real weakness, and it is why
they are not the default.

**What we do about it.** The planner model is a per-project setting; the default is
a Tier 1 or Tier 2 provider, and reaching a Tier 3 model is a deliberate choice
made with this page in front of you. **Two of the three are removable without
changing models at all** — DeepSeek and GLM publish their weights under the MIT
licence, so serving them from our own EU infrastructure would remove the
processor, the transfer and the gap together. We list all three rather than omit
them, because a subprocessor list is worth reading only if it names the
uncomfortable rows.

Of the three rows that were open on 2026-08-26, **two are now closed** —
**Google** (DPF-certified, plus SCCs where the framework does not reach) and
**Spaceship** (a published DPA incorporating the SCCs). What remains open is
recorded here rather than resolved silently:

- **Spaceship — one open question remains, and it is not a transfer question.**
  Whether corporate correspondence belongs on a published subprocessor list is
  for counsel (MOTIR-3621).
- **The three Tier 3 processing agreements — OPEN, and disclosed rather than
  gating.** DeepSeek, Zhipu AI and Moonshot AI offer no Art. 28 agreement, so
  their rows carry a gap a customer may weigh. It does not block publication:
  this page's job is to state the position accurately, and an omitted row would
  serve a reader worse than a candid one. Each is reopened if that vendor
  publishes a DPA, if a supervisory authority addresses business use of the API,
  or if a customer requires it closed.
- **⚠️ The six-provider set is a LAUNCH intention, and must be re-read before
  general availability.** Two channels were enabled when the gateway was last
  read. Listing a provider that never ships is the same error as omitting one
  that does, in the other direction — so this page is re-read against the
  gateway's channel table before the service opens, and any provider that did not
  arrive is removed.

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
