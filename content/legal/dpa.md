---
title: Data Processing Agreement
version: 0.1.0-draft
effectiveDate: TBD
status: draft
---

# Data Processing Agreement

**This agreement covers the hosted Motir service at `app.motir.co`, operated by moooon
B.V.** It does not apply to a self-hosted installation: if you run Motir yourself, no
data reaches moooon B.V. and there is nothing for us to process on your behalf.

> **⚠️ DRAFT — not yet reviewed by counsel, and not a document to send to a customer in
> this state.** Pending MOTIR-3621.

**This is a template, available on request.** It is not required to use the service and
signing it is not a condition of your subscription. It exists so that a customer who is
itself a controller — typically a business using Motir to manage work that involves
personal data of its own staff or users — can put an Article 28 agreement in place
without waiting for one to be drafted.

---

## 1. Parties and role

|                |                                                                                                                      |
| -------------- | -------------------------------------------------------------------------------------------------------------------- |
| **Processor**  | moooon B.V., Menkemaborg 65, Lelystad, Netherlands, registered with the Dutch Chamber of Commerce under KvK 97763144 |
| **Controller** | The customer identified in the order or account (**"you"**)                                                          |

For personal data you place into the service — your workspace content, the people you
invite, and anything your work items happen to contain — **you are the controller and
moooon B.V. is the processor.**

For the data moooon B.V. needs in order to operate the service as a business — your
account and billing records, and our own security and service logs — **moooon B.V. is
itself a controller**, and our Privacy Policy rather than this agreement governs it. This
split matters and is stated here rather than left implicit: the same company is a
processor for one set of data and a controller for another.

## 2. Subject matter, duration, nature and purpose

- **Subject matter.** Processing of personal data contained in Customer Data, for the
  sole purpose of providing the hosted Motir service.
- **Duration.** For as long as your account is active, plus the deletion window in §10.
- **Nature and purpose.** Hosting, storing, transmitting, displaying and backing up
  Customer Data; sending service email on your instruction; and, where you invoke an AI
  feature, transmitting the content you select to the gateway and its upstream provider
  for the sole purpose of returning a result to you.
- **Types of personal data.** Account identifiers (name, email address), workspace and
  work-item content, comments and attachments, and any personal data you choose to place
  in that content.
- **Categories of data subject.** Your personnel and collaborators; any individual whose
  personal data you place into Customer Data; and, where you operate a public project,
  members of the public who submit requests or comments.

**Special categories.** The service is not designed for, and must not be used to process,
data in the special categories of Article 9 or the criminal-offence data of Article 10.
Nothing in the product treats such data differently, so you should not place it here.

## 3. Instructions

moooon B.V. processes Customer Data only on your documented instructions. Your use of the
service, together with this agreement and the order, constitutes those instructions.

If we believe an instruction infringes the GDPR or another applicable data-protection
provision, we will tell you and may suspend that instruction until it is resolved.

We will not sell Customer Data, and we will not use it to train any machine-learning
model, our own or a third party's.

## 4. Confidentiality

Everyone authorised to process Customer Data is bound by an appropriate obligation of
confidentiality, and access is limited to those who need it to provide or support the
service.

## 5. Security (Article 32)

moooon B.V. maintains technical and organisational measures appropriate to the risk,
including:

- **Encryption in transit** (TLS) for all connections to the service, and encryption at
  rest for the database and object storage as provided by the platforms in §6.
- **Tenant isolation** enforced in the database itself rather than only in application
  code, so that a query cannot read across workspace boundaries.
- **Authentication** with password hashing, optional two-factor authentication (TOTP,
  email one-time codes, and recovery codes), and signed, `HttpOnly`, `SameSite` session
  cookies.
- **Least-privilege access control** by workspace role, applied on the server.
- **Backups** of the primary database, with a tested restore procedure.
- **Segregation of production credentials**, held as platform secrets rather than in the
  repository.

These measures may change as the service evolves; any change will maintain a level of
security no lower than that described here.

## 6. Subprocessors

You give **general written authorisation** for moooon B.V. to engage subprocessors.

The current list, with each subprocessor's purpose and location, is published at
`/legal/subprocessors` and kept current. **We will update that page before a new
subprocessor begins processing Customer Data.** You may object on reasonable
data-protection grounds within thirty days of an addition; if we cannot accommodate the
objection, you may terminate the affected part of the service and receive a pro-rata
refund of prepaid fees.

Each subprocessor is bound by data-protection obligations no less protective than those
in this agreement, and moooon B.V. remains fully liable to you for their performance.

## 7. International transfers

Several subprocessors are established outside the EEA, predominantly in the United
States. Each such transfer is made under a mechanism permitted by Chapter V of the
GDPR — the receiving organisation's certification under the EU–US Data Privacy
Framework, or the Standard Contractual Clauses.

Where the Standard Contractual Clauses apply between you and moooon B.V., **Module 2
(controller to processor)** is incorporated into this agreement by reference, with:

- **Clause 7** (docking) — applicable.
- **Clause 9(a)** — **Option 2**, general written authorisation, with the thirty-day
  notice period in §6.
- **Clause 11(a)** — the optional independent-dispute-resolution wording does **not**
  apply.
- **Clause 17** — governed by the law of **the Netherlands**.
- **Clause 18(b)** — the courts of **the Netherlands**.
- **Annex I** — the parties in §1, the description in §2, and the subprocessor list in §6.
- **Annex II** — the measures in §5.

> **⚠️ Counsel must confirm this section before the template is sent to anyone.** The
> module selection and the clause options are the part of an Article 28 agreement most
> often got wrong, and the per-vendor transfer bases the list in §6 depends on are still
> being gathered.

## 8. Assistance to the controller

moooon B.V. will, taking into account the nature of the processing and the information
available to it, assist you with:

- **Data-subject requests** (Articles 12–23). The service provides self-service export
  and deletion; where a request cannot be satisfied through the product, contact
  **privacy@motir.co** and we will assist.
- **Security, breach notification, impact assessments and prior consultation**
  (Articles 32–36).

## 9. Personal data breach

moooon B.V. will notify you **without undue delay** after becoming aware of a personal
data breach affecting Customer Data, and will provide the information you need to meet
your own Article 33 obligations, as it becomes available.

## 10. Deletion and return

On termination, and at your choice, moooon B.V. will delete or return Customer Data.
Unless you ask otherwise, we delete it within **thirty days** of termination, except
where storage is required by Union or Member State law.

Backups follow their own rotation and are overwritten in the ordinary course. Data
present only in a backup is not restored to active use and is deleted as that backup
expires.

## 11. Audit

moooon B.V. will make available the information necessary to demonstrate compliance with
Article 28 and will allow for and contribute to audits, including inspections, conducted
by you or an auditor you mandate. In the first instance we will respond to a reasonable
written request for information; an on-site inspection may be conducted no more than once
per year, on reasonable notice, at your cost, and subject to confidentiality.

## 12. Precedence, term and governing law

This agreement forms part of, and is subject to, the Terms of Service. Where it conflicts
with the Terms of Service **on the subject of processing personal data, this agreement
prevails.**

It takes effect when signed by both parties, or when incorporated by reference into an
order, and continues for as long as moooon B.V. processes Customer Data on your behalf.

Governed by the law of the Netherlands, with jurisdiction as set out in the Terms of
Service.

---

**Requests:** `legal@motir.co`. **Data-protection questions:** `privacy@motir.co`.
