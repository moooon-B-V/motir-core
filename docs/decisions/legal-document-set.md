# The legal foundation — governing law, controller identity, and the launch document set

- **Status:** Accepted (2026-08-26, drafted for Story MOTIR-657 per the
  decision-subtask ladder). **No application behaviour ships in this subtask** —
  it writes this file and changes no code, no route, no schema and no config.
  Every document it scopes is authored by a card listed under **Consequences**.
- **Story / Subtask:** MOTIR-657 (8.4 Legal — ToS + privacy) · Subtask
  MOTIR-1133 (8.4.1).
- **Consumed by:** MOTIR-1158 (ToS + AUP), MOTIR-1159 (Privacy Policy + Cookie
  Policy), MOTIR-1160 (DPA template + subprocessor list), MOTIR-1134 (the
  rendered `/legal/*` routes), MOTIR-1135 (signup acceptance + re-consent),
  MOTIR-1136 (data-subject requests).
- **Builds on:** `production-service-stack.md` (accepted 2026-08-10) — its **Q4**
  picks the cookieless Plausible, which is what lets §6 below state the
  cookie-banner answer positively rather than conditionally, and its **Q8**
  assigns the per-vendor transfer basis to MOTIR-1160 rather than to this record.
  `application-hosting.md` — Fly.io, Neon and Tigris are the processors §7's
  document set must name, and its **Amendment 6 (Q10)** fixes the data region.
- **Supersedes / superseded by:** nothing. This is the first record in this
  directory that decides anything about the product's published legal position.

> Convention (set by `work-item-type-taxonomy.md`, followed by
> `billing-tiering.md` / `application-hosting.md` / `production-service-stack.md`):
> a decision record is a markdown file under `docs/decisions/`, structured
> **Status → Context → Decision → Consequences**, with load-bearing facts pinned
> in explicit tables.

---

## The problem

Story 8.4 has seven cards behind one unanswered sentence: _"under whose law, on
whose behalf, and which documents actually gate launch."_ None of the three
drafting cards (MOTIR-1158/1159/1160) can start while the governing law, the
controller and the document set are open, and MOTIR-1134 cannot render pages
whose copy does not exist.

Two of this record's inputs were settled **after** MOTIR-1133 was written, and
both change an answer the card anticipated:

1. `production-service-stack.md` **Q4** (2026-08-10) chose **Plausible**,
   explicitly _because_ it is cookieless. The card asks for the cookie-banner
   answer to be recorded as _conditional on 8.5's analytics choice_. That
   condition has since resolved, so recording it as still-conditional would be
   recording a question the project has already answered. §6 states the answer.
2. **MOTIR-2596** (the `motir.co` mailbox, done 2026-08-10) provisions the
   mailbox but deliberately defers _which role addresses must exist_ to this
   record: _"an address that is printed in a published document (the privacy /
   data-protection contact, the security contact) must exist and be monitored
   before that document publishes."_ §4 decides that set.

---

## §1 — The decisions, in one table

|        | Question                                     | Decision                                                                                                                                                              |
| ------ | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Q1** | Whose law governs the cloud service?         | **Netherlands law**, courts of moooon B.V.'s registered seat — with the EU consumer carve-out stated, not overclaimed (§2)                                            |
| **Q2** | Who is the controller?                       | **moooon B.V.** for the **cloud** offering only. A self-hoster is their own controller, and every document says so on its face (§3)                                   |
| **Q3** | What is the controller's published identity? | Legal name **moooon B.V.**; registered address and KvK number are an **OPEN INPUT the founder supplies** — named here as a publication precondition, not guessed (§3) |
| **Q4** | What contact addresses are printed?          | `privacy@motir.co`, `security@motir.co`, `legal@motir.co` — free aliases into the existing `zhuyue@motir.co` mailbox (§4)                                             |
| **Q5** | Is a DPO required?                           | **No**, on the Art. 37(1) reading in §5, with the trigger to revisit recorded                                                                                         |
| **Q6** | Is a cookie-consent banner required?         | **No — positively, not conditionally.** Every cookie the product sets is strictly necessary or functional, and the analytics vendor sets none (§6)                    |
| **Q7** | Which documents gate launch?                 | ToS, Privacy Policy, AUP, Cookie Policy, subprocessor list **block launch**. The DPA template is **ready-on-request and does not gate** (§7)                          |
| **Q8** | Who authors them?                            | **Vetted template → agent drafts → counsel reviews → founder approves.** The drafting atom and the review atom are different executors, and §8 splits them            |

---

## §2 — Q1: Netherlands law, and the consumer carve-out is stated

### The decision

The Terms of Service are governed by **the laws of the Netherlands**, with
exclusive jurisdiction in the courts of moooon B.V.'s registered seat.

moooon B.V. is a Dutch _besloten vennootschap_; it is the contracting party, it
is established in the Netherlands, and the regime the rest of this record reads
against — GDPR as implemented by the **UAVG**, plus the Dutch implementation of
the **ePrivacy** Directive in the Telecommunicatiewet — follows from that. There
is no second establishment to weigh and no reason to reach for a foreign law.

### What the ToS must NOT claim

A blanket _"Dutch law and Dutch courts, exclusively, for everyone"_ is
unenforceable against EU consumers and should not be written as though it were.
Two mandatory rules survive any choice-of-law clause:

- **Rome I Art. 6** — a consumer keeps the protection of the mandatory rules of
  their own country of habitual residence.
- **Brussels I bis Art. 18** — a consumer may sue, and may generally only be
  sued, in the courts of their own domicile.

So MOTIR-1158 writes the choice of law **and** a carve-out sentence preserving
those rights. A clause that has to be climbed down from in a dispute is worse
than the narrower clause written correctly the first time.

---

## §3 — Q2/Q3: moooon B.V. is the controller, for the cloud only

### The decision

**moooon B.V. is the data controller for the hosted Motir service at
`app.motir.co`, and for that service only.**

Motir is open-core: the PM substrate is GPL-3.0 and self-hostable. **A self-hoster
running their own Motir install is their own controller** — moooon B.V. processes
nothing for them, sees nothing of theirs, and can make no representation about
their processing. This is not a footnote; it is the first thing each document
must establish, because a self-hoster who reads a policy that appears to cover
them is misled about who answers for their data.

Every document authored under this record therefore opens with an explicit scope
line naming the cloud service, and none of them speaks for a self-hosted install.

### ⚠️ The published identity carries an OPEN INPUT — and it is not guessable

GDPR Art. 13(1)(a) requires the controller's **identity and contact details**.
Two of those values are facts moooon B.V. holds and this repository does not:

| value                  | state                                                                | where it must come from        |
| ---------------------- | -------------------------------------------------------------------- | ------------------------------ |
| legal name             | **known** — `moooon B.V.` (`CLA.md` names it as the receiving party) | settled                        |
| **registered address** | **NOT KNOWN — open input**                                           | the founder / the KvK register |
| **KvK number**         | **NOT KNOWN — open input**                                           | the founder / the KvK register |

**These are named here rather than invented.** A registered address is a
verifiable public fact about a real company; a plausible-looking one written into
a published privacy notice is a false statement in a legal document, and it would
be indistinguishable from a correct one to every reader downstream. Searching the
repository for either value returns nothing — `CLA.md` names the entity and no
address, and no other file carries one.

**This is a publication precondition, not a drafting blocker.** MOTIR-1158/1159/1160
draft against the placeholders `«REGISTERED ADDRESS»` and `«KVK NUMBER»`;
MOTIR-1134 must not publish a document that still contains either token. That is
a mechanical check, and §9 assigns it.

---

## §4 — Q4: the printed contact addresses

### The decision

Three role addresses are printed in the launch documents:

| address             | printed in                                             | why it must exist first                                                                               |
| ------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `privacy@motir.co`  | Privacy Policy (Art. 13(1)(a)/(b)), Cookie Policy, DPA | the data-subject-rights channel; a policy naming an address that bounces is a broken legal commitment |
| `security@motir.co` | AUP, ToS (abuse/vulnerability reporting)               | the abuse-reporting path the AUP promises                                                             |
| `legal@motir.co`    | ToS, DPA (notices)                                     | contractual notice address                                                                            |

**All three are free aliases forwarding into the existing `zhuyue@motir.co`
mailbox**, not paid mailboxes. MOTIR-2596 established the mailbox on Spacemail,
published the apex `MX`, and recorded that aliases onto an existing mailbox cost
nothing — which is exactly what makes a three-address set affordable, and is why
that card left the size of the set to this one.

**They must exist and be monitored before the documents publish.** MOTIR-2596 is
`done` and provisioned the mailbox, not these aliases; creating them is a console
action on Spaceship. §9 records it as an open operational step against MOTIR-1134,
which is the card that publishes the addresses.

`hello@` / `support@` are **out of scope here** — they are needed when the
marketing site names them, which is Story 8.3's question, not this one.

---

## §5 — Q5: no DPO, and the reasoning is recorded

### The decision

**moooon B.V. does not designate a Data Protection Officer at launch.**

GDPR **Art. 37(1)** makes designation mandatory in exactly three cases, and none
holds:

| Art. 37(1) limb                                                                                                      | applies? | why                                                                                                                                                                                                                                                                            |
| -------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| (a) processing by a **public authority or body**                                                                     | **no**   | moooon B.V. is a private company                                                                                                                                                                                                                                               |
| (b) core activities are **regular and systematic monitoring of data subjects on a large scale**                      | **no**   | the core activity is hosting a project-management tool for the customers who sign up for it. It does not track individuals across services, does not profile them, and the analytics chosen is cookieless and does not identify individuals (`production-service-stack.md` Q4) |
| (c) core activities are **large-scale processing of special categories** (Art. 9) or criminal-offence data (Art. 10) | **no**   | no special category is collected, and none is inferred. Account data, project content, billing references and AI prompts are ordinary personal data                                                                                                                            |

**The trigger to revisit, written down so it is not re-derived from scratch:** if
a later card introduces behavioural profiling, cross-service tracking, or any
Art. 9 category (the obvious candidate being health or biometric data arriving as
customer _content_ at scale), limb (b) or (c) may flip. Revisit this section then
— and note that the UAVG adds no Dutch-specific designation trigger beyond
Art. 37, so this reading does not change on national law alone.

The Privacy Policy states that no DPO is designated and gives `privacy@motir.co`
as the contact point instead. Saying so plainly is better than silence, which
reads as an omission.

---

## §6 — Q6: no cookie banner — and this is now a POSITIVE answer

### The decision

**Motir requires no cookie-consent banner, because it sets no non-essential
cookies.**

MOTIR-1133 asked for this to be recorded as _conditional on 8.5's analytics
choice_. **That condition has resolved and this record closes it.**
`production-service-stack.md` **Q4** chose Plausible _because_ it is cookieless,
and says so in terms: _"MOTIR-1159's Cookie Policy can say the true and simple
thing: the product analytics sets no cookies. That is a better legal artifact
than a banner."_ Recording a conditional here would re-open a question the
project has already answered, and would leave MOTIR-1159 drafting hedged copy
around a vendor that never earned the hedge.

The ePrivacy consent requirement (Art. 5(3), and the Dutch Telecommunicatiewet
implementation) exempts storage that is **strictly necessary** to provide the
service the user explicitly requested. Every cookie below qualifies.

### ⚠️ The cookie inventory, re-measured — the card named FOUR, and the product sets far more

MOTIR-1133's own context refs enumerate four cookies (`NEXT_LOCALE`, `motir.org`,
the workspace cookie, the Better-Auth session). **That count was short.** Measured
on `origin/main` at `4f70366d6` — not on a working tree — the shipped set is:

**⚠️ CORRECTED 2026-08-26, while MOTIR-1159 drafted the Cookie Policy from this table.**
This section first said the product sets **fifteen** cookies. The precise figures are
**THIRTEEN set by application code** — twelve named `*_COOKIE` constants plus the inline
`NEXT_LOCALE` — **plus the Better-Auth framework's own set** (the session cookie, the
two-factor challenge cookie, and `trust_device`). The table below is complete; the
single total was not, because it silently mixed the two sources.

**The correction matters more than the arithmetic does.** A count is exactly the kind of
claim this section exists to warn about, and writing one into a decision record — where a
later card's acceptance criterion then cites it as a target — reproduced the defect one
level up. **The published Cookie Policy therefore states no total at all**: it enumerates,
and an enumeration is checkable against the code while a total is checkable only against
whoever last counted.

| cookie                                                                           | purpose                                                                                    | class                         |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ----------------------------- |
| Better-Auth `session_token`                                                      | the signed-in session (`httpOnly`, `SameSite=Lax`, `Secure` in production)                 | strictly necessary            |
| `trust_device`                                                                   | 2FA "remember this device"; a signed pointer to a row in the existing `verification` table | strictly necessary (security) |
| the Better-Auth two-factor challenge cookie                                      | short-lived, spans the password step and the second factor                                 | strictly necessary (security) |
| `workspace_id`                                                                   | which workspace the session is looking at                                                  | functional                    |
| `motir.org`                                                                      | which organization the session is looking at                                               | functional                    |
| `NEXT_LOCALE`                                                                    | the user's chosen language                                                                 | functional                    |
| `motir_pending_idea`                                                             | **see below**                                                                              | functional                    |
| `github_oauth_state`                                                             | CSRF state, GitHub connect                                                                 | strictly necessary (security) |
| `gitlab_oauth_nonce`                                                             | CSRF nonce, GitLab connect                                                                 | strictly necessary (security) |
| `jira_oauth_state`, `jira_oauth_verifier`                                        | CSRF state + PKCE verifier, Jira import                                                    | strictly necessary (security) |
| `linear_import_oauth_state`                                                      | CSRF state, Linear import                                                                  | strictly necessary (security) |
| `plane_import_oauth_state`, `plane_import_oauth_base`, `plane_import_oauth_slug` | CSRF state + instance coordinates, Plane import                                            | strictly necessary (security) |
| `import_oauth_return`                                                            | post-OAuth return path                                                                     | functional                    |

**The conclusion is unchanged and the inventory is not.** Every added cookie is
either an OAuth CSRF/PKCE token or a UI preference, so the no-banner answer holds
on a set nearly four times the size. But the Cookie Policy is a _published
enumeration_, and MOTIR-1159 would have shipped one missing eleven entries —
including every OAuth cookie and both 2FA cookies, the latter merged
**three hours before this record was written** (PR #2314, MOTIR-1213).

**⚠️ `motir_pending_idea` is the one that needs prose, not just a table row.** It
is set on the **public landing page, before any account exists**, and holds up to
**2000 characters of text the visitor typed** — their project idea — carried
across sign-up to seed the first planning conversation (`lib/onboarding/pendingIdea.ts`).
It is functional: it delivers precisely the thing the visitor asked for. But it is
the only cookie that stores **user-authored content** rather than an identifier or
a preference, and it is written **pre-authentication**. MOTIR-1159 describes it in
those terms — what it holds, how long, and that it is discarded once consumed —
rather than filing it under "preferences" where a reader would never find it.

**The standing rule this implies:** the Cookie Policy is an enumeration measured
against shipped code, so a card that adds a cookie amends it. §9 records the
follow-up.

---

## §7 — Q7: what blocks launch

### The decision

| document                  | launch-blocking?          | why                                                                                                                                                                                                                                            |
| ------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Terms of Service**      | **YES**                   | there is no contract with the user without it                                                                                                                                                                                                  |
| **Privacy Policy**        | **YES**                   | Art. 13 transparency is owed at collection — i.e. at the first sign-up                                                                                                                                                                         |
| **Acceptable Use Policy** | **YES**                   | Motir hosts **public projects** where signed-in strangers post feature requests and comments. Moderation and takedown need a published basis _before_ the first submission, not after the first problem                                        |
| **Cookie Policy**         | **YES**                   | cheap, and it is the artifact §6's answer lives in. Its absence is conspicuous next to a Privacy Policy                                                                                                                                        |
| **Subprocessor list**     | **YES**                   | the Privacy Policy's processors section must mirror it (MOTIR-1160), so it exists at launch by construction. Publishing it is the marginal step                                                                                                |
| **DPA template**          | **NO — ready on request** | Art. 28 binds a controller↔processor relationship that begins when a _business customer_ asks. Drafting it is launch work; a countersigned DPA is not a launch gate, and gating on one would block launch on a customer who does not exist yet |

The DPA's exclusion is a scheduling decision, not a quality one: MOTIR-1160 still
authors it in full, and it must be sendable the day it is first requested.

---

## §8 — Q8: who authors, and the split it forces

### The decision — the authoring path

**A vetted template is the starting point, an agent produces the draft, counsel
reviews it, and the founder approves.** Not bespoke counsel drafting from a blank
page: these are five standard SaaS documents, the facts they turn on are already
written down in this repository (the processor set, the cookie inventory, the
open-core split, the billing model), and paying for original drafting of standard
clauses buys nothing that review of a good draft does not.

What counsel is for is the part a template cannot supply: whether the liability
cap and the choice-of-law carve-out hold under Dutch law, whether the
subprocessor disclosures are complete, and whether the AUP's takedown rights are
enforceable. That is a review engagement, and it is the gate on **publication**.

### ⚠️ AMENDED 2026-08-26 — counsel review was DEFERRED, and the documents were approved without it

**This section decided the path; the path was then changed by the founder, and the record
says so rather than leaving §8 describing something that did not happen.**

The four-step path above — vetted template, agent drafts, counsel reviews, founder
approves — ran three of its four steps. **Counsel review was deferred**, deliberately, on
the founder's decision, and the six documents were approved on an **agent analysis against
the regulations they cite**. That analysis found and fixed four defects: the missing Dutch
`opzet of bewuste roekeloosheid` carve-out and the consumer cap, the absent DSA Art. 16/17
machinery, an SCC module misapplied to an intra-EEA leg, and three clauses (third-party
services, confidentiality, indemnification) that both comparator products carry.

**Counsel review is not legally required** — no rule anywhere obliges a lawyer to draft or
review these; the obligations bind the controller and the content, never the author. So
this is a risk decision rather than a compliance gap, and it is recorded as one.

**Where the residual risk sits, named rather than averaged away:** Dutch civil-code
application (Art. 6:248(2) BW, the _grijze lijst_), SCC module selection — where the first
draft was outright wrong — and DSA scope, including whether the Art. 19 micro-enterprise
exemption survives the linked-and-partner-enterprise test. **The recommendation on the
record is to buy a scoped review before the first paying B2B customer**, which is when the
DPA is first read adversarially.

**The published documents carry no claim either way**, which is normal — no product's terms
state their review provenance. The provenance lives here and on MOTIR-3621.

### ⚠️ This splits three cards, because drafting and reviewing are different executors

MOTIR-1158, MOTIR-1159 and MOTIR-1160 each bundle both atoms, and the bundle is
visible three separate ways:

- each card's **body** says `Type: manual (legal) · Executor: human (founder +
counsel)` and `No PR — marked done on the user's confirmation`, while its
  **fields** say `type: content · executor: coding_agent`;
- each is estimated at **240 / 300 / 210 minutes** — human counsel time, and
  three to four times the ~70-minute ceiling the estimation gate puts on an agent
  run. `validate_work_item` flags all three as `likely-over-gate-sizing`;
- MOTIR-1134 consumes their output as **Markdown committed in-repo**, which the
  `No PR` line says will never exist.

**A card cannot be both.** The drafting atom is agent work with a pull request;
the counsel-review-and-approve atom is human work with no diff. Per the
decide-manual-**per atom** rule, they are separate cards joined by a `blocked_by`
edge — which is also what brings each card back under the estimation gate.

**This record decides the path; it does not perform the split.** Restructuring
those three cards is a plan change, and a run does not reshape the plan it is
executing. MOTIR-1133's own deliverable is this decision, and the split is its
consequence — submitted as a plan for approval, per §9.

---

## §9 — Consequences

**Cards this record unblocks (they may start on its merge):**

| card                               | what it takes from here                                                                                                                                                                      |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MOTIR-1158 (ToS + AUP)             | §2's governing law **and its consumer carve-out**; §3's scope line; §4's `security@` / `legal@`; §8's template-then-review path                                                              |
| MOTIR-1159 (Privacy + Cookie)      | §3's controller block and its two placeholders; §4's `privacy@`; §5's no-DPO statement; **§6's inventory, which replaces the four its own body carries**, and the `motir_pending_idea` prose |
| MOTIR-1160 (DPA + subprocessors)   | §7's ready-on-request status; §3's cloud-only scope. Its per-vendor transfer basis is **`production-service-stack.md` Q8's**, unchanged by this record                                       |
| MOTIR-1134 (`/legal/*` routes)     | §7's five launch-blocking documents = the five routes that must exist at launch                                                                                                              |
| MOTIR-1135 (signup acceptance)     | the ToS + Privacy Policy are the two documents acceptance is recorded against                                                                                                                |
| MOTIR-1136 (data-subject requests) | §4's `privacy@motir.co` is the manual fallback the surface names                                                                                                                             |

**Open items this record NAMES and does not close:**

1. **The registered address and KvK number** (§3) — founder input. **MOTIR-1134
   must not publish a document still containing `«REGISTERED ADDRESS»` or
   `«KVK NUMBER»`**; that is a mechanical check on rendered copy, and it belongs
   to MOTIR-1137's render assertions.
2. **The three email aliases** (§4) — a Spaceship console action, so a `manual`
   atom. MOTIR-2596 provisioned the mailbox, not the aliases. They must resolve
   before MOTIR-1134 publishes copy that prints them.
3. ~~**Counsel review** (§8) — the gate on publication, not on drafting.~~ **DEFERRED
   2026-08-26** on the founder's decision; the set was approved on agent analysis
   instead (see the amendment in §8). Recommended before the first paying B2B
   customer.
4. **The Cookie Policy is an enumeration** (§6) — a card that adds a cookie
   amends it. The 2FA cookies reached the product without touching MOTIR-1159,
   which is how the four-entry list went stale in the first place.

**What this record does NOT decide:** the per-vendor transfer basis (DPF or SCCs)
— `production-service-stack.md` **Q8** assigns that to MOTIR-1160, and this record
does not move it. Whether the Spacemail mailbox itself appears on the published
subprocessor list is likewise MOTIR-1160's counsel call, as that card already says.

---

## Rejected alternatives

| alternative                                                                  | why not                                                                                                                                                                                   |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Irish or Delaware law**, for familiarity                                   | moooon B.V. is Dutch and has no other establishment. Choosing a foreign law adds a conflicts question to every dispute and buys nothing                                                   |
| **A blanket exclusive-jurisdiction clause** with no consumer carve-out       | unenforceable against EU consumers under Rome I Art. 6 / Brussels I bis Art. 18. A clause that must be abandoned in a dispute is worse than the correct narrower one                      |
| **Record the cookie-banner answer as still conditional**, as MOTIR-1133 asks | the condition resolved on 2026-08-10 when Q4 chose a cookieless vendor. Re-recording it as open would make MOTIR-1159 hedge copy that does not need hedging                               |
| **Ship a cookie banner anyway**, defensively                                 | consent theatre for cookies that are exempt. It trains users to dismiss consent UI and implies non-essential tracking the product does not do                                             |
| **Designate a DPO defensively**                                              | Art. 37(1) does not require it, and a designated DPO carries real statutory duties (Art. 38–39). Designating one to look careful creates obligations with no corresponding protection     |
| **Gate launch on a countersigned DPA**                                       | Art. 28 binds a relationship that starts when a business customer asks. There is no such customer yet, and the template being ready is the whole obligation                               |
| **Bespoke counsel drafting from a blank page**                               | five standard documents whose load-bearing facts are already recorded in this repository. Counsel's value is review, not transcription                                                    |
| **Invent a plausible registered address** to close §3's gap                  | it is a verifiable public fact about a real company, and a wrong one is a false statement in a published legal document — indistinguishable from a correct one to every reader downstream |
