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

Last reviewed against the codebase: **2026-08-26.** The AI upstream set was
additionally read from the **gateway's own configuration** on **2026-08-26** — see
_AI features_ below, and `docs/decisions/ai-upstream-transfer-basis.md` for how it
was read and what it decided.

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

| Subprocessor                     | Purpose                                                                                   | Data reached                                                            | Location                  |
| -------------------------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------- |
| **motir-ai** (moooon B.V.)       | Our own AI gateway — routing, metering, and the planning intelligence                     | Prompts, plan text, and the work-item content you ask it to reason over | Fly.io, region `iad`, USA |
| **OpenAI** (OpenAI, L.L.C.)      | The language model that answers a planning request, and the embedding model behind search | The prompt text, and the content sent for embedding                     | USA                       |
| **Brave** (Brave Software, Inc.) | Web search, when a planning request needs one                                             | The search query, which is derived from what you asked                  | USA                       |

**The upstream set was read from the gateway on 2026-08-26**, not inferred from the
code. motir-ai does not call a model provider directly: it posts to moooon B.V.'s
own **gateway** over an OpenAI-compatible interface, and the gateway is a
multi-provider relay whose enabled upstream _channels_ live in its own
administration rather than in source. The table above lists the model provider
that serves customer content. A separate per-call upstream, the **Brave Search
API**, serves web search when a planning request needs one.

**Only providers with a recorded transfer basis may serve this traffic.** That is
decided in `docs/decisions/ai-upstream-transfer-basis.md`, which enumerates every
enabled upstream, records its basis, and requires the gateway to enforce the
constraint rather than merely state it. Each provider above has its own row in
_Transfer bases_ below.

> **⚠️ Contingency — this section describes the DECIDED state, and one step of it
> is not applied yet.** On 2026-08-26 the gateway also had a **DeepSeek** channel
> enabled, serving the planner's then-default model from mainland China with no
> Chapter V transfer basis. The decision record retires it: the planner's default
> moves to an OpenAI model first, and the DeepSeek channel is disabled second.
> **This page does not publish until both steps are applied and the channel set
> has been re-read to confirm it** — the same kind of publication precondition
> `docs/decisions/legal-document-set.md` §3 sets for the registered address.

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

| Vendor                                            | Basis                                                                                                                                                           | Read from                                   |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| **Fly.io**                                        | **DPF-certified** — active participant under the EU–US Data Privacy Framework and its UK and Swiss extensions                                                   | Fly.io's published DPF privacy policy       |
| **Resend**                                        | **DPF-certified** — EU–US DPF and the UK Extension                                                                                                              | Resend's own certification announcement     |
| **Neon**                                          | **SCCs** — its DPA incorporates the Commission-approved SCCs and the UK Addendum, and it also relies on the DPF                                                 | Neon's published DPA                        |
| **Tigris**                                        | **SCCs** — its DPA incorporates the Approved EU SCCs with the UK Addendum, with the Irish supervisory authority named as competent for EEA data subjects        | Tigris's published Data Processing Addendum |
| **OpenAI** (models + embeddings, via the gateway) | **SCCs** — Module 2 where we are controller, Module 3 where we are processor                                                                                    | OpenAI's published DPA                      |
| **Brave** (search, via the gateway)               | **SCCs** — the Brave Search API Data Processing Addendum incorporates the EU SCCs and the UK Addendum. Query records are retained for up to 90 days             | Brave's published Search API DPA            |
| **Plausible**                                     | **No Chapter V transfer** — established and hosted in the EU                                                                                                    | Its stated EU hosting                       |
| **Google** (optional sign-in)                     | **Not confirmed by this draft**                                                                                                                                 | —                                           |
| **Inngest**                                       | **NOT CONFIRMED — no published DPA or SCC terms were found.** This is a core subprocessor that handles job payloads, so it cannot stay unresolved               | Searched; nothing published found           |
| **Spaceship (Spacemail)**                         | **Not confirmed by this draft**                                                                                                                                 | —                                           |
| **DeepSeek** (retired — see below)                | **NONE.** Its policy names no SCCs and no other Chapter V mechanism, and it states that personal data is processed and stored in the People's Republic of China | DeepSeek's published privacy policy         |

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
the AI contingency is discharged.** Three rows remain open independently of the
AI question: **Inngest**, a core subprocessor for which no published DPA or SCC
terms were found, and **Google** and **Spaceship**, which this draft has not
read.

---

## Changes to this list

We will update this page before a new subprocessor begins processing, and record the
date of each change. If you have a data-processing agreement with us, the notification
and objection terms in that agreement apply.

Questions: **privacy@motir.co**.
