# ADR: Motir does not adopt organization-addressable URLs — and the "Organization URL" field leaves the settings page

- **Status:** Accepted (2026-08-10)
- **Story / Subtask:** MOTIR-2542 (Refine the organization settings page) · Subtask MOTIR-2543
- **Supersedes / superseded by:** none
- **Consumed by:** MOTIR-2546 (the design amendment that redraws the General card),
  MOTIR-2548 (the General card itself), MOTIR-2549 (the shell control, which drops the
  unused `slug` prop)

> Convention (set by `work-item-type-taxonomy.md`): a decision record is a markdown file
> under `docs/decisions/`, named for the thing it fixes, structured
> **Status → Context → Decision → Consequences**. No application behaviour ships in this
> subtask; what it freezes is what makes the two UI cards buildable.

---

## Context

The organization settings page renders a field labelled **Organization URL** — a
read-only input prefixed `motir.co/` and filled with `Organization.slug`, under the
helper text:

> "Used in links to this organization. Lowercase letters, numbers and hyphens."

That sentence is a claim about the product, and it is false. Nothing in Motir links to
an organization by slug, and `motir.co/<slug>` resolves to nothing.

The question this record answers is therefore not "should we delete a form field" but
the one underneath it: **does Motir want organizations to be addressable by URL at
all?** The two are different decisions, and answering only the first is how the field
gets deleted this quarter and helpfully re-added next quarter by someone who noticed
that every competitor has one.

### Evidence — what the code actually does (rung 2)

Re-run on this branch's base, `origin/main` at `d810b1a5`.

**1. `organizationRepository.findBySlug` has zero production callers.** It is a method,
not a path.

```
$ git grep -n "findBySlug"
lib/repositories/organizationRepository.ts:43:  async findBySlug(slug: string): Promise<Organization | null> {
lib/repositories/projectRepository.ts:121:      async findBySlug(workspaceId: string, slug: string): Promise<Project | null> {
lib/repositories/workspaceRepository.ts:14:   async findBySlug(slug: string): Promise<Workspace | null> {
scripts/stampOnboardingRan.ts:70:             const workspace = await workspaceRepository.findBySlug(workspaceSlug);
tests/organizations-repository.test.ts:29,41,47,88   (4 hits)
```

The one production caller in that list — `scripts/stampOnboardingRan.ts` — calls
`workspaceRepository.findBySlug`, a different method on a different entity. Every hit
against the **organization** repository's method is a test.

**2. No route addresses an organization.** Every organization endpoint is keyed by id:
`app/api/organizations/[orgId]/…` (route, members, usage, billing). There is no
`[orgSlug]` segment anywhere under `app/`; the only dynamic `slug` directory in the
tree is `app/(public)/explore/topic/[slug]`, which is a _category_ slug and unrelated.
Public project pages are `/p/[identifier]`. The authed shell resolves the active
organization from the `ORGANIZATION_COOKIE_NAME` cookie and the active workspace's
`organizationId` — never from a path segment.

**3. The value is threaded to a component that ignores it.**
`app/(authed)/layout.tsx:84` puts `slug` on the `activeOrg` object, and
`OrgControlActiveOrg` declares it — but neither `OrgControl.tsx` nor `ShellTierNav.tsx`
contains a single read of `.slug`.

**4. It is not editable and not re-derived.** `organizationsService` slugifies the name
once at create (with a random four-character suffix on collision) and
`renameOrganization` writes `name` only. An organization created as "Acme" and renamed
to "Beta" keeps `motir.co/acme` for ever. The field is `readOnly` in the UI by an
explicit decision (MOTIR-2495), which spent a card making a value focusable and
selectable so that people could copy an address that goes nowhere.

### Evidence — what the mirror products do (rung 1, observed)

Both mirrors _do_ route on a tenant slug. That is the strongest argument for adopting
one, so it is recorded first and in full rather than paraphrased away.

- **Linear** — the workspace slug **is** the address: every URL is
  `https://linear.app/<workspace-slug>/…`, and the slug is surfaced as the _URL key_ in
  **Settings → Workspace**. Linear's own workspace documentation lists
  _"Update a Workspace name and URL"_ among the capabilities of an admin.
  (Observed 2026-08-10 at `https://linear.app/docs/workspaces`.)
- **Atlassian / Jira Cloud** — a site is `<name>.atlassian.net`. An **organization
  admin** can change it from `admin.atlassian.com` → Products → Product URLs, limited to
  three changes on Standard/Premium/Enterprise. Critically for us: **the old URL keeps
  working as a redirect and is never released**, and REST APIs, webhooks and CI/CD
  pipelines must be updated by hand.
  (Observed 2026-08-10 via Atlassian Support's _Update an app URL subdomain_ and the
  associated cloud-site-URL knowledge-base articles.)

The second bullet is the one that changes the answer. A tenant URL is not a text field;
it is a public identifier with a rename story, a redirect obligation, and a documented
warning that machine consumers will break. Both mirrors have all of that machinery.
Motir has none of it — and today's field has the _appearance_ of Linear's URL key with
nothing behind it, which is strictly worse than not having the field at all: a user who
copies it and sends it to a colleague learns that Motir's own description of itself
cannot be trusted.

---

## Decision

**1. Motir does not adopt organization-addressable URLs.** No route is re-based under a
tenant segment; the active organization keeps being resolved from the cookie and the
active workspace, as it is today.

**2. The "Organization URL" field is removed from the org-settings General card**,
together with its two copy strings, its dedicated test, and its depiction in the design
assets of record. A field describing a capability the product does not have is a defect,
not a placeholder.

**3. `Organization.slug` stays** — the column, its `@unique` constraint, the create-time
slugify + collision suffix, and `organizationRepository.findBySlug`. Removing a column
in order to remove a form row is a migration with no user-visible payoff, and the slug
is exactly what an addressing scheme would use if one is ever adopted. It is internal
substrate from now on, not a user-facing value.

**4. The shell stops carrying it.** `OrgControlActiveOrg.slug` is dropped and
`app/(authed)/layout.tsx` stops populating it, because a prop that no component reads is
a false signal about what the header knows.

### The reversal condition

Adopt organization-addressable URLs when Motir needs an organization-scoped address that
a person can **send to someone else** — a shared read-only surface, a public
organization page, or the need to hold two organizations open in two browser tabs. Any
of those makes the address a feature rather than a decoration. Adopting it is then a
routing change (every authed route gains a tenant segment; the cookie stops being the
source of truth) plus the rename machinery both mirrors carry: a redirect from the old
slug, and a documented warning for API and webhook consumers. It is an epic, not a
settings row — which is precisely why it should not be implied by a field.

---

## Consequences

### What must change, by path

The card acting on this decision (MOTIR-2548) inherits this list rather than
re-deriving it:

| path                                                                  | change                                                            |
| --------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `app/(authed)/settings/organization/_components/OrgGeneralCard.tsx`   | remove the URL `Input`; drop `slug` from `OrgGeneralCardProps`    |
| `app/(authed)/settings/organization/page.tsx`                         | stop passing `slug` to the card                                   |
| `messages/en.json`                                                    | delete `orgAdmin.settings.urlLabel` + `orgAdmin.settings.urlHint` |
| `messages/zh.json`                                                    | delete the same two keys — both catalogues, no orphan             |
| `tests/components/OrgGeneralCard-url-field.test.tsx`                  | delete — its entire subject is this field                         |
| `design/org-admin/org-admin.mock.html`                                | the drawn field leaves the General card                           |
| `design/org-admin/design-notes.md`                                    | two sites: the panel-2 field list, and the copy-strings section   |
| `design/org-admin/create-workspace.design-notes.md`                   | see below                                                         |
| `app/(authed)/_components/OrgControl.tsx` · `app/(authed)/layout.tsx` | drop the unused `slug` prop (MOTIR-2549)                          |

### The one non-obvious referrer

`design/org-admin/create-workspace.design-notes.md` justifies its own passive
`motir.co/{slug}` workspace preview by citing this field as precedent —
_"where the org-settings 'Organization URL' field already establishes the `motir.co/`
prefix + lowercase/hyphen grammar."_ Removing the org field invalidates that citation.
The design amendment (MOTIR-2546) either corrects the sentence or records why the
create-workspace preview stands on its own. Note that the create-workspace dialog is
itself undrawn-and-unbuilt; this decision does not decide anything about a _workspace_
URL, which is a separate surface with its own question.

### What is explicitly NOT a referrer

`tests/components/input-non-editable-states.test.tsx` uses the string
`"Organization URL"` as a **label fixture** while testing the shared `Input` primitive's
read-only and disabled states. It has nothing to do with the org-settings card and stays
exactly as it is. Deleting it because it matches a grep would remove coverage of a
primitive this decision does not touch.

### What this decision does not cost

Nothing external breaks. There is no route, no redirect, no bookmark and no API consumer
addressing an organization by slug — that is the whole finding. The value removed from
the screen is zero; the value removed from the codebase is a sentence that was not true.
