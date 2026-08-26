---
title: Privacy Policy
version: 0.1.0-draft
effectiveDate: TBD
status: draft
---

# Privacy Policy

**This policy covers the hosted Motir service at `app.motir.co`, operated by moooon B.V.**

**It does not cover a self-hosted installation.** Motir's project-management core is open
source, and anyone can run it on their own infrastructure. If you are using such an
install, **your data never reaches moooon B.V.**, the operator of that install is the
controller, and this document does not describe what they do. Ask them.

> **⚠️ DRAFT — not yet reviewed by counsel and not yet published.** Pending MOTIR-3621.

---

## 1. Who is responsible

The controller for the hosted service is:

**moooon B.V.**
Menkemaborg 65, Lelystad, Netherlands
Registered with the Dutch Chamber of Commerce under KvK 97763144

Contact for anything in this policy: **privacy@motir.co**

**We have not appointed a Data Protection Officer.** Article 37(1) of the GDPR requires
one where an organisation is a public authority, where its core activities involve
regular and systematic monitoring of individuals on a large scale, or where they involve
large-scale processing of special-category or criminal-offence data. None of those
describes us: we host a project-management tool for the customers who sign up for it, we
do not track people across other services, our analytics does not identify individuals,
and we do not collect special-category data. Write to `privacy@motir.co` and a person
will answer.

## 2. What we collect

### You give us

|                          |                                                                                                                                                                                              |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Account**              | Your name and email address, and a hash of your password — we never store the password itself. If you sign in with Google, we receive your Google account identifier, name and email instead |
| **Two-factor details**   | If you enable it: your authenticator secret and recovery codes, held encrypted                                                                                                               |
| **Your work**            | Everything you put into Motir — workspaces, projects, work items, comments, custom fields, and any personal data you choose to place in them                                                 |
| **Attachments**          | Files you upload, and their metadata                                                                                                                                                         |
| **Public contributions** | If you take part in a public project, your submitted requests, comments and votes, shown with your name                                                                                      |
| **AI prompts**           | The text you send to the planning features, and the work-item content you ask them to reason over — **only when you use those features**                                                     |

### We generate

|                               |                                                                                      |
| ----------------------------- | ------------------------------------------------------------------------------------ |
| **Activity records**          | Who changed what and when, which is a product feature as much as a log               |
| **Usage and metering**        | For AI features and billing entitlements                                             |
| **Service and security logs** | Including IP address and browser user-agent, for operating and defending the service |
| **Email delivery metadata**   | Whether a message we sent you was delivered                                          |

### From others

Only what you ask us to fetch. If you connect a repository or import from another tool,
we receive the data that connection covers. **A workspace that connects nothing receives
nothing from anywhere.**

### What we do not collect

No special-category data (Article 9) and no criminal-offence data (Article 10) is asked
for, and none is inferred. The product has no notion of them, so please do not put them
into work-item content. We do not buy data about you, and we do not build advertising
profiles.

## 3. Why, and on what legal basis

| Purpose                                                                           | Basis                                                                                                                                                                                                          |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Providing the service — your account, your workspaces, your content               | **Contract** (Art. 6(1)(b))                                                                                                                                                                                    |
| Sending service email — invitations, password resets, notifications you asked for | **Contract**                                                                                                                                                                                                   |
| Billing and metering                                                              | **Contract**, and **legal obligation** for records we must retain                                                                                                                                              |
| Keeping the service secure and available — logs, rate limiting, abuse prevention  | **Legitimate interests** (Art. 6(1)(f)): running a service that is not abused, balanced against your interest in not being over-monitored, which is why these logs are short-lived and not used to profile you |
| Aggregate, cookieless product analytics                                           | **Legitimate interests**: understanding which features are used, with no individual identified                                                                                                                 |
| Running AI features when you invoke one                                           | **Contract** — you asked for the result                                                                                                                                                                        |

**We do not rely on consent for anything today**, which is why there is no consent banner.
If a future feature needs consent, we will ask for it then, and you will be able to say no
without losing anything you have now.

## 4. Who else sees it

We use a small number of companies to run the service. **The complete, current list —
with each company's purpose, what it reaches, and where it is — is published at
[/legal/subprocessors](/legal/subprocessors)**, and this section does not duplicate it:
one list, kept accurate, is worth more than two that can drift apart.

In outline: the application runs on **Fly.io**, the database is **Neon**, uploaded files
are in **Tigris**, background jobs pass through **Inngest**, and email is sent via
**Resend**. Analytics is **Plausible**, which is cookieless and EU-hosted. **Google**
appears only if you choose Google sign-in. AI features go through **motir-ai**, our own
gateway, to an upstream model provider. Integrations you connect yourself — GitHub,
GitLab, Jira, Linear, Plane — receive or supply data only for the workspace that
authorised them.

**We do not sell your data. We do not use your content to train machine-learning models,
ours or anyone else's.**

## 5. Sending data outside the EEA

Several of those companies are in the United States. Each such transfer is made under a
mechanism permitted by Chapter V of the GDPR — the recipient's certification under the
EU–US Data Privacy Framework, or Standard Contractual Clauses. **The basis for each
company is recorded on the subprocessor page**, per company rather than as a blanket
statement.

> **⚠️ One is unresolved and we are not going to paper over it.** The upstream provider
> behind our AI features does not yet have a recorded transfer basis, and the question is
> a real one rather than paperwork. **Until it is settled, this policy will not claim
> that it is.** The subprocessor page carries the detail.

## 6. How long we keep it

|                                   |                                                                                                                                   |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| **Account and workspace content** | While your account is open. After you delete it, we erase or anonymise within **30 days**, except where something below applies   |
| **Billing records**               | Kept as long as tax and accounting law requires, which in the Netherlands is generally **seven years**                            |
| **Security and service logs**     | Short-lived — kept only as long as they are useful for operating and defending the service                                        |
| **Backups**                       | Rotated on their own schedule and overwritten in the ordinary course. Data present only in a backup is not restored to active use |
| **Public contributions**          | See below                                                                                                                         |

**Public contributions are the case worth stating plainly.** If you posted a request or a
comment on someone else's public project, deleting your account does not simply erase it,
because it is part of a conversation others took part in. We **anonymise** your
contributions — your name is removed — rather than deleting the thread around them.

## 7. Your rights

You have the right to **access** your data, to **correct** it, to **erase** it, to
**receive it in a portable form**, to **restrict** or **object to** processing, and to
**withdraw consent** where we rely on it.

**The product provides these directly.** In your account settings you can export your
personal data and request deletion of your account, without asking anyone. That is
deliberate: a right you have to write a letter to exercise is a weaker right.

For anything the product cannot do, write to **privacy@motir.co**. We answer within one
month, and will tell you if we need longer.

**If you are unhappy with how we handle it**, you can complain to a supervisory authority.
In the Netherlands that is the **Autoriteit Persoonsgegevens**; if you live elsewhere in
the EEA, your own national authority.

## 8. Automated decision-making

**We do not make decisions about you by automated means that produce legal or similarly
significant effects.** Motir's AI features generate plans and suggestions about your
_work_ — they do not evaluate _you_, and nothing in the product decides anything about a
person automatically.

## 9. Children

Motir is a tool for work and is not directed at children. We do not knowingly collect
data from anyone under 16. If you believe a child has given us data, write to
`privacy@motir.co` and we will delete it.

## 10. Security

We describe our measures in the [Data Processing Agreement](/legal/dpa) §5, which is the
same set applied to everyone. In short: encryption in transit, tenant isolation enforced
in the database rather than only in application code, optional two-factor authentication,
least-privilege access by role, backups with a tested restore, and production credentials
held as platform secrets.

No service can promise perfect security. **If a breach affects your personal data and is
likely to result in a high risk to you, we will tell you**, as Article 34 requires.

## 11. Cookies

See the [Cookie Policy](/legal/cookies) for every cookie the service sets and why.
Summary: they are all strictly necessary or functional, there is no advertising or
tracking cookie, and therefore no consent banner.

## 12. Changes

We update this policy when what we do changes. It carries a version and an effective date
at the top so you can see which one you read. **For a change that materially affects your
rights, we will tell you** rather than relying on you noticing — and where the change
affects the terms you accepted, you will be asked to review them.

---

**Contact:** privacy@motir.co
