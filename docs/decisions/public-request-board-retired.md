# ADR: motir.co's public feature-request board is retired, and a public project's pending requests move into the app as Requested features

- **Status:** Proposed (2026-09-28). The direction was set by the owner (Yue) on 2026-09-28 while
  MOTIR-6171 was being planned. Revised the same day after the owner requested changes at this
  record's decision gate: the name "triage" retires everywhere, not only where a Visitor looks
  (Decision 4). Approving this record confirms that the direction below is what the owner asked for.
- **Work item:** MOTIR-6744 (`type: decision`), epic MOTIR-6164
- **Supersedes:**
  - **MOTIR-4116** (done), which shipped motir.co's Roadmap tab as the feature-request board. The tab
    becomes a redirect, and the list of pending requests it showed moves into the app (Decision 2).
  - **MOTIR-4119** (done), **its vote hand-off on the roadmap cards only**. That hand-off leaves with
    the board. Its upvote and comment hand-offs on each request's own page stay.
  - **MOTIR-6664** (done), `visitor-sign-in-and-records.md`, **in part**. Its _"nothing that writes"_
    still holds for every Visitor entrance. This record adds one exception: a Visitor may upvote a
    request from inside the app, using the public-request grant they already hold (Decision 3).
- **Consumed by:** MOTIR-6171 (motir.co's read pages move into the app) and its cards: MOTIR-6742
  (the design of motir.co's project page) · MOTIR-6743 (the redirects) · MOTIR-6745 (the project
  page's links) · MOTIR-6746 (the public contract, and `public-surface-hosts.md` AMENDMENT 8, which
  cites this record) · MOTIR-6767 (the Requested features view, drawn) · MOTIR-6768 (its read) ·
  MOTIR-6769 (its page)

---

## Context

motir.co's **Roadmap** tab, at `/p/<identifier>/roadmap`, is the public **feature-request board**. It
shows four columns ordered by votes: Submitted, Planned, In progress and Done. They hold a project's
public requests, and each card links to its request page and to a vote hand-off. It is rendered by
`motir-marketing` `app/p/[identifier]/roadmap/page.tsx` from `GET /api/public/p/{identifier}/roadmap`.

The approved MOTIR-6171 moved motir.co's read pages into the app. It redirected "roadmap → roadmap"
and said motir.co keeps "the feature requests" and "voting" exactly as before. It did not say that
motir.co's roadmap **is** the voting board, so the plan both kept the board and redirected it away.

The owner settled it in four turns on 2026-09-28, and a fifth at this record's decision gate:

1. about the board: _"drop the feature, it's useless"_;
2. asked how far: _"only the request board"_;
3. after the plan was approved: _"triage needs to be open for the visitors, the visitors can upvote
   there"_;
4. on the name: _"it should be called requested feature not triage, a common user won't understand
   what the triage is"_;
5. at the gate, on the first version of this record, which kept "Triage" as the Managers' own name:
   _"We can call it requested feature everywhere, so triage as a name retires."_

## Decision

1. **The board is retired.** `/p/<identifier>/roadmap` on motir.co redirects **permanently** to the
   in-app Visitor roadmap at `app.motir.co/p/<identifier>/roadmap`, like the board, items, tree and
   item pages. motir.co keeps no list of a project's requests.
2. **A public project's pending requests move into the app, as Requested features.** A signed-in,
   consented Visitor (`visitor-sign-in-and-records.md`) reads them at
   `app.motir.co/p/<identifier>/requested-features`, ordered by votes.
   - **The set** is the one the board's Submitted column showed: pending requests, attributed to a
     submitter, not in a done status, and not snoozed. (As read on `origin/main` `a08dc1762`:
     `workItemRepository.findPublicRoadmapSubmitted`, which requires `triagedAt` and
     `submittedByUserId` to be set, the status category not to be `done`, and no active snooze.)
   - **Submitters are shown by name only**, never by email.
   - **The Visitor gets no Manager action.** They cannot accept, decline, promote, merge, snooze or
     edit a request.
   - **A member** who follows the same address lands in their own Requested features: the inbox
     that is called Triage today, with its actions, renamed by Decision 4.
3. **The Visitor can upvote there.** The upvote is the existing public-request act
   (`public_request:upvote`). Every actor already holds it on a public project, decided by the
   project's access level and not by a role (`lib/permissions/builtinRoles.ts`,
   `PUBLIC_PROJECT_PERMISSIONS`). Its route (`POST /api/public-requests/[id]/upvote`) needs a
   signed-in session and no workspace membership. So it is **not** a Visitor-entrance write, and the
   Visitor's role stays read-only: it holds the same view keys and gains no new key.
4. **The name is "Requested features", everywhere, and "triage" retires as a name.** A reader
   outside the team will not understand "triage", and one thing gets one name. So the Visitor's view
   and the members' inbox are both **Requested features**, in every place a person reads the name:
   - the navigation entry, the page heading and the address, for the Visitor's view and for the
     members' inbox (today `/triage`, labelled "Triage");
   - the permission's label in the role editor (today "Triage requests") and its description;
   - the copy that tells a submitter or a member where a request went (today "the team's triage
     queue", "No items to triage", "Select a submission to triage" and their siblings);
   - every locale's translation of those strings.
5. **What stays on motir.co, unchanged:**
   - the "Request a feature" doorway, `/p/<identifier>/requests/new`;
   - each request's own page, `/p/<identifier>/requests/<KEY>`, with its upvote and comment
     hand-offs. The page is anonymous to read, and the two hand-offs still act on `app.motir.co`
     under that application's session, as `public-surface-hosts.md` AMENDMENT 4 decided;
   - follow, subscribe and the changelog.
6. **The doorway and the request page lead back to the project page**, `/p/<identifier>`, instead of
   the retired board.

### Rejected

- **Keep the board on motir.co.** The owner called it useless and asked to drop it.
- **Drop the pending requests altogether.** The owner asked for them to stay visible, and votable,
  to the people watching the project.
- **Open the members' inbox to Visitors as it is.** It carries acts a Visitor must not have. The
  Visitor gets its own read-only view, with the same name and a single act.
- **Keep "Triage" as the members' own name** (the first version of this record). The owner rejected
  it at the gate: the name retires everywhere.
- **Keep a vote hand-off on motir.co's project page in place of the in-app view.** That would be the
  same board in a smaller form, which is the thing being retired.

## Consequences

- motir.co loses its roadmap page, its loader and the roadmap-card vote hand-off. The request form and
  the request page change only where they link back (MOTIR-6743, MOTIR-6745).
- `GET /api/public/p/{identifier}/roadmap` has no caller on motir.co any more. It is deprecated in
  the public contract with the other read operations and keeps answering until the contract's next
  major (MOTIR-6746).
- The app gains one Visitor view, **Requested features**. It gets a read of the set in Decision 2,
  cursor-paged by votes and carrying the reader's own voted state (MOTIR-6768). It gets a page with
  an upvote toggle on the existing upvote route and an entry in the Visitor navigation, and it is
  admitted by the Visitor routing (MOTIR-6769). It is drawn first (MOTIR-6767).
- No permission key is added and no role set changes. The upvote reaches the Visitor through the
  public-level grant they already hold.
- **The members' inbox is renamed** (Decision 4): its navigation entry, heading and address, the
  permission's label and description, and the copy that names it, in every locale. As of
  2026-09-28, on `origin/main` `a08dc1762`, the name lives in `app/(authed)/_components/SidebarNav.tsx`
  (`nav.triage`, `href: '/triage'`), the `app/(authed)/triage/` route and its components, and
  `messages/en.json` / `messages/zh.json` (16 strings in `en.json`). **No card owns this rename yet.**
  It is new scope for MOTIR-6171, and it is proposed as a plan change there rather than decided here.

### The clauses this record makes false

This record names them and does not edit them. The `public-surface-hosts.md` edit rides MOTIR-6746,
which writes that record's AMENDMENT 8. As of 2026-09-28 no card is planned to put a pointer to this
record in `role-model.md` or `visitor-sign-in-and-records.md`. Until one does, this record is the
amendment of record for the clauses below.

- `role-model.md` **§5** and the _public-pages split_ table: _"voting"_ on motir.co now means the
  upvote hand-off on a request's own page only. The roadmap moves into the app as before, and it no
  longer carries requests.
- `role-model.md` **§4**: the Visitor holds _"nothing that writes"_ **except** the public-request
  upvote in Requested features.
- `visitor-sign-in-and-records.md` **Decision 5**: _"nothing that writes"_ carries the same
  exception. **Decision 6**: motir.co is unchanged **except** that its request board is retired.
- `triage-model.md` names the members' surface the _"Triage inbox"_. Its model stands: a
  submission is still a work item in a `triage` state. The surface a person reads is now
  **Requested features** (Decision 4).
- `public-surface-hosts.md` **§2** as amended by AMENDMENT 7: `/p/<identifier>/roadmap` joins the
  paths motir.co redirects, and the request pages stay on motir.co.

## What this does NOT decide

- **Whether a Visitor may comment on or submit a request from inside the app.** Both stay on
  motir.co's request page and its hand-offs.
- **Whether promoted requests appear in Requested features.** Only the pending set in Decision 2
  does. What a promoted request becomes is the in-app roadmap's business, unchanged.
- **The view's layout, states and copy** beyond its name. That is the design's (MOTIR-6767).
- **How the Visitor's upvote is rate limited.** The existing public-write limit applies, and the
  cards that build the view decide anything more (MOTIR-6768, MOTIR-6769).
- **When the deprecated roadmap operation is removed.** It goes at the public contract's next major,
  which nobody has decided to cut.
- **The members' inbox's behaviour.** Only its name changes. What it lists, and the acts it offers,
  stay as they are.
- **Internal identifiers.** Names no person reads, such as the `triagedAt` column, the
  `work_item_triage` permission key, the `/api/**/triage` routes and component names, are the
  implementing card's choice. This record renames what people read.
- **What the old `/triage` address does** once the inbox has moved: redirect or retire. That is the
  implementing card's choice.
