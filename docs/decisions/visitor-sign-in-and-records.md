# ADR: A Visitor signs in, consents once per project, and is recorded for the project's Managers

- **Status:** Proposed (2026-09-27). The direction was set by the owner (Yue) at the design gate of
  MOTIR-6641 on 2026-09-27. Approving this record confirms that the direction below is what the owner
  asked for.
- **Work item:** MOTIR-6664 (`type: decision`), epic MOTIR-6164
- **Supersedes:**
  - `role-model.md` (MOTIR-6165) **Q3**, _"Does a Visitor need to sign in? NO"_, and the sentences in
    **§4** and the _Every role_ table that say a Visitor is stored nowhere and needs no sign-in. The
    rest of §4 stands: the Visitor's key set, public projects only, private epics hidden, and never
    assigned.
  - `public-projects.md` **§5**, _READ is anonymous; WRITE requires sign-in_, for the in-app Visitor
    views only. For motir.co's pages §5 still holds.
  - `public-projects.md` **AMENDMENT 2** (MOTIR-6642, on the parent branch
    `parent/MOTIR-6170-visitor-view`), where _"an anonymous reader … is that project's Visitor,
    granted automatically and stored nowhere"_.
- **Consumed by:** MOTIR-6170 (the Visitor story) and its cards MOTIR-6641 (design) · MOTIR-6665 (the
  visitor record) · MOTIR-6666 (session, consent and the amendments) · MOTIR-6669 (the consent screen)
  · MOTIR-6667 (the Managers' Visitors list) · MOTIR-6668 (the account data export) · MOTIR-6647 (the
  client data doors) · MOTIR-6648 (the route tree) · MOTIR-6650 (integration gate) · MOTIR-6651 (E2E);
  and MOTIR-6171 (motir.co's read pages move into the app)

---

## Context

`role-model.md` §4 and Q3 made the Visitor anonymous. Anyone following a public project's link,
signed out included, entered as a Visitor. Nothing about them was stored, and no email was ever
shown. `public-projects.md` §5 already made public READ anonymous, and MOTIR-6642 built
`resolveVisitor` on that basis, answering an anonymous reader `visitor`.

At the design gate of MOTIR-6641 (the Visitor view, drawn), the owner changed the premise:

> A visitor needs to sign in to view the public project. The workspace manager should be able to see
> the visitor record in the project, including the user's email. So, before the user enters the live
> pages of the project, the user needs to be told his information will be shared with the project.
> It's because if the user is interested in the project, the user is a potential user of the
> product.

The reason is a product one. A person interested enough to watch a project work in the real app is a
likely customer, and the project should know who they are. That requires an account, and it requires
telling the person before their details are shared.

The shipped precedent for a screen that asks for explicit agreement before going on is the legal
re-consent interstitial (`app/(auth)/re-consent/page.tsx`, `lib/services/legalAcceptanceService.ts`).
It holds a signed-in person on their way somewhere until they agree, and it never treats silence as
agreement.

## Decision

1. **Reading a Public project's live views in the app requires a signed-in account.** This covers the
   in-app Visitor views at `app.motir.co/p/<identifier>/<view>`. A signed-out reader is sent to sign
   in and returns to the view they asked for.
2. **The first time for each project, a consent screen comes first.** It applies to a signed-in person
   who cannot enter the project. The screen says that their **name and email will be visible to the
   project's workspace Managers**, and it offers **Continue** and **Go back**.
   - **Continue** records the consent and goes on to the view they asked for.
   - **Go back** leaves without a record. They are asked again next time.
   - Consent is given **once per (person, project)**. Once a record exists, that person is not asked
     again for that project, and consenting on one project says nothing about another.
3. **The consent writes a VISITOR RECORD**, one per (person, project), holding:
   - the project and the person;
   - **consented at**, when they pressed Continue;
   - **first visit**, when they first read the project as a Visitor;
   - **latest visit**, touched by each Visitor read.
4. **The project's workspace Managers see its visitor records, email included.** The list lives on
   the project's Settings › Access & members page. Each row shows the visitor's name, email, first and
   latest visit and consent time. This list is the one place a Visitor's email is shown.
5. **Everything else about the Visitor stands** (`role-model.md` §4):
   - they hold the Viewer's view keys and nothing that writes;
   - they never see what sits under a private epic;
   - they see other people by **display name only**, never by email;
   - a person who can enter the project is sent to their own view, not the Visitor view, and is never
     asked to consent.
6. **motir.co is unchanged.** Its landing page, explore pages and act features (follow, subscribe,
   changelog, feature requests, votes, comments) stay anonymous to read. Only the app's live views
   change.

### Rejected

- **Keep the Visitor anonymous** (the old Q3). It keeps the widest audience, but the project learns
  nothing about who is watching. The owner rejected it for that reason.
- **Record signed-in visitors silently, with no consent screen.** It gives the project the same
  information, but the person is never told that their email goes to another organisation's
  Managers. The owner asked for them to be told first.
- **Ask on every visit.** Once is enough to tell the person. Asking again adds friction and no
  information.

## Consequences

- The Visitor resolution gains two answers before `visitor`: **sign in** (no session) and **consent**
  (a signed-in person who cannot enter and has no record for this project). A Visitor read touches
  the record's latest visit. Built by MOTIR-6666, on the table from MOTIR-6665.
- A person's visitor records are **their data**:
  - they appear in that person's account data export (MOTIR-6668);
  - they are deleted when the person's account is deleted, or when the project is (MOTIR-6665).
- A Visitor's email reaches exactly one surface, the Managers' list (MOTIR-6667). The Visitor-facing
  payloads stay free of email, which MOTIR-6650's no-email scan checks.
- Under `role-model.md` AMENDMENT 1, an org Owner or Admin is a Manager in every workspace, so they
  read the list too. Nothing new is decided here; it follows from who a Manager is.
- The signed-out Visitor paths already planned or built are withdrawn: the signed-out banner and its
  Sign in action (MOTIR-6641), and `resolveVisitor` answering an anonymous reader `visitor`
  (MOTIR-6642). They are re-scoped on the cards named above.

### The clauses this record makes false

This record decides and does not edit them. The edits ride **MOTIR-6666**.

- `role-model.md` **Q3**: the answer becomes **yes, for the in-app views**, with a one-time consent
  per project. Also the _Every role_ table's Visitor row, _"nowhere: never stored"_ and _"no sign-in
  needed (Q3)"_.
- `role-model.md` **§4**: _"A Visitor is whoever arrives at a public project from outside"_ becomes a
  signed-in person who cannot enter it, has consented, and is recorded. _Never assigned_ stands.
- `public-projects.md` **§5**: READ stays anonymous on motir.co and requires sign-in for the in-app
  Visitor views.
- `public-projects.md` **AMENDMENT 2**: _"an anonymous reader"_ leaves the list of who is a Visitor,
  and _"stored nowhere"_ becomes one visitor record per (person, project).

## What this does NOT decide

- **Withdrawing a consent, or hiding from a project's list.** Nobody asked for it. Deleting the
  account removes the records.
- **Whether Managers are notified** of a new visitor.
- **Exporting the visitor list**, for example to CSV or a CRM.
- **motir.co's anonymous pages**, which are unchanged (Decision 6).
- **The consent screen's layout and copy**, beyond what it must say. That is the design's
  (MOTIR-6641).
- **How Visitor reads are rate limited** now that every reader has an account. That is left to the
  cards that build the doors (MOTIR-6647).
- **How long a record is kept** while both the person and the project still exist.
