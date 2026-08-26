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

moooon B.V. («REGISTERED ADDRESS», KvK «KVK NUMBER») uses the companies below to
provide the hosted service. We publish this list so that a customer acting as a
controller can assess it, and we keep it current: the list is derived from what the
running application actually integrates with, not from a plan.

Last reviewed against the codebase: **2026-08-26.**

---

## Core subprocessors — every hosted customer

These receive data as a necessary part of running the service. There is no way to use
the hosted service without them.

| Subprocessor                   | Purpose                                                                           | Data reached                                                         | Location                              |
| ------------------------------ | --------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------- |
| **Fly.io** (Fly.io, Inc.)      | Application hosting — Motir runs as a long-running Node process                   | All data in transit through the application                          | Primary region `iad`, Ashburn, USA    |
| **Neon** (Neon Inc.)           | Managed PostgreSQL — the primary database                                         | All stored account, workspace and work-item data                     | USA (co-located with the application) |
| **Tigris** (Tigris Data, Inc.) | S3-compatible object storage — file attachments and public assets, in two buckets | Uploaded files and their metadata                                    | USA                                   |
| **Inngest** (Inngest, Inc.)    | Durable background-job queue — scheduled and event-driven work                    | Job payloads, which reference work items and may carry their content | USA                                   |
| **Resend** (Resend, Inc.)      | Transactional email — invitations, password resets, notifications                 | Recipient address, name, and the message body                        | USA                                   |

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

| Subprocessor                 | Purpose                                                               | Data reached                                                            | Location                  |
| ---------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------- |
| **motir-ai** (moooon B.V.)   | Our own AI gateway — routing, metering, and the planning intelligence | Prompts, plan text, and the work-item content you ask it to reason over | Fly.io, region `iad`, USA |
| **Upstream model providers** | The large-language-model and embedding providers motir-ai routes to   | The prompt text and the content sent for embedding                      | Predominantly USA         |

**⚠️ The upstream provider set is not settled in this draft, and it is not
settleable from the repository.** motir-ai does not call a model provider directly: it
posts to moooon B.V.'s own **gateway** over an OpenAI-compatible interface, and the
gateway is a multi-provider relay whose enabled upstream _channels_ are configured in its
own administration rather than declared in source. The one upstream pinned in code is the
**embedding model** (`text-embedding-3-small`, an OpenAI model), used for lesson and
plan-tree search.

**Before this page publishes, the enabled channel set must be read back from the
gateway's own configuration** and this table narrowed to exactly the providers that
actually receive data. Naming a provider that receives nothing is as wrong as omitting one
that does, and neither error is visible from the code.

**⚠️ This is not a formality — see the DeepSeek row under _Transfer bases_.** The gateway's
code can reach providers in jurisdictions with no EU adequacy decision. Which of them are
switched on is precisely the fact this section cannot answer, and it is the fact that
decides whether the AI features are lawful for EU customers at all.

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

**⚠️ Open counsel question.** This row receives personal data that arrives _outside_ the
product, from people who may not be users at all. Whether that makes it a subprocessor
of the service — belonging on this published list — or simply a vendor of moooon B.V.'s
own correspondence, is a judgement this draft deliberately leaves open rather than
resolving in either direction. Pending MOTIR-3621.

---

## Not yet subprocessors — planned, and receiving nothing today

**Listing a company that receives no data would be a false statement**, so these are
recorded separately rather than in the tables above. Each moves up when the integration
actually ships, and this page is amended in the same change.

| Company                                            | Intended purpose                  | Status on 2026-08-26                                                                                                                              |
| -------------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Sentry** (Functional Software, Inc.)             | Error monitoring                  | **Not integrated.** No SDK dependency and no configuration exist in the application. The work is in progress and unmerged                         |
| **Stripe** (Stripe, Inc. / Stripe Payments Europe) | Payments and subscription billing | **Not integrated.** No SDK dependency exists; the only reference is a test fixture. Billing is not yet live, so no payment data exists to process |

---

## Transfer bases

Most of the companies above are established in the United States and receive personal
data from a controller established in the Netherlands. That is lawful **conditionally**,
and the condition is a mechanism under Chapter V of the GDPR — either the receiving
organisation's certification under the EU–US Data Privacy Framework, or Standard
Contractual Clauses.

**Read per vendor on 2026-08-26**, from each vendor's own published terms. Recorded
below rather than assumed. A row marked _not confirmed_ is an open item, not a pass.

| Vendor                                   | Basis                                                                                                                                                    | Read from                                   |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| **Fly.io**                               | **DPF-certified** — active participant under the EU–US Data Privacy Framework and its UK and Swiss extensions                                            | Fly.io's published DPF privacy policy       |
| **Resend**                               | **DPF-certified** — EU–US DPF and the UK Extension                                                                                                       | Resend's own certification announcement     |
| **Neon**                                 | **SCCs** — its DPA incorporates the Commission-approved SCCs and the UK Addendum, and it also relies on the DPF                                          | Neon's published DPA                        |
| **Tigris**                               | **SCCs** — its DPA incorporates the Approved EU SCCs with the UK Addendum, with the Irish supervisory authority named as competent for EEA data subjects | Tigris's published Data Processing Addendum |
| **OpenAI** (embeddings, via the gateway) | **SCCs** — Module 2 where we are controller, Module 3 where we are processor                                                                             | OpenAI's published DPA                      |
| **Plausible**                            | **No Chapter V transfer** — established and hosted in the EU                                                                                             | Its stated EU hosting                       |
| **Google** (optional sign-in)            | **Not confirmed by this draft**                                                                                                                          | —                                           |
| **Inngest**                              | **NOT CONFIRMED — no published DPA or SCC terms were found.** This is a core subprocessor that handles job payloads, so it cannot stay unresolved        | Searched; nothing published found           |
| **Spaceship (Spacemail)**                | **Not confirmed by this draft**                                                                                                                          | —                                           |
| **Upstream model providers**             | **See below — the open question on this page**                                                                                                           | —                                           |

### ⚠️ The upstream model providers are the unresolved risk, not a checkbox

The gateway can route to providers hosted outside the EEA in jurisdictions **with no
adequacy decision**, and the code carries no residency constraint that would prevent it.
The concrete case is **DeepSeek**, whose hosted API is served from mainland China:

- **China has no EU adequacy decision**, and has never had one.
- DeepSeek's published privacy terms **do not offer Standard Contractual Clauses**, so
  the ordinary Article 46 fallback is not available off the shelf.
- European regulators have acted: the Italian authority blocked the consumer app in
  January 2025, and authorities in France, Ireland, Germany, Belgium and Portugal opened
  investigations into the hosted service.

**If a China-hosted channel is enabled for EU customers' prompt content, there is no
lawful transfer basis for it**, and that is a product decision rather than a wording
problem on this page. It is filed as its own defect and must be resolved — by
constraining which channels may serve EU traffic, by choosing providers that offer a
basis, or by self-hosting the model — before the AI features are offered to EU customers.

**This page does not publish until every row above carries a recorded basis**, and the
AI row is not dischargeable by editing this file.

---

## Changes to this list

We will update this page before a new subprocessor begins processing, and record the
date of each change. If you have a data-processing agreement with us, the notification
and objection terms in that agreement apply.

Questions: **privacy@motir.co**.
