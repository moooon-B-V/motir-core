# Org administration — design notes

Design reference for the **`org-admin`** UI area — the **organization (root
tenancy tier) administration surfaces** (Story 6.10). The asset is the source of
truth for every UI subtask in Story 6.10. Built FROM the real design system
(`app/globals.css` `--el-*` colour tokens + `[data-display-style]` shape tokens +
the shipped `components/ui/*` primitives), so the code subtask composes the same
primitives — no Pencil→code gap.

| Surface                               | Asset                                   | Notes                                                                                                                                                                                                                                              |
| ------------------------------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Org switcher + settings + members** | **`org-admin.mock.html`** (HTML mockup) | The whole org-admin surface — no `design/org-admin/` asset existed; the 6.10.1 design gate produces this. Multi-panel: switcher (single/multi-org) · settings · paginated members · role+invite · empty/loading/error/forbidden. **Gates 6.10.5.** |

## What this area is

Story 6.10 introduces the missing **top tenancy tier** above the workspace — the
**`Organization`** (the root account a customer signs up as, the parent of N
workspaces, and the **billing entity** credits + usage roll up to). It is
**auto-created at signup and renameable**; every customer is an org from day one,
so a one-person company (**OPC**) and an enterprise share one model and one set
of surfaces — the difference is purely **progressive disclosure** (see the rule
below), not a separate "individual" product. The org-admin surfaces are the
**tenant** owner/admin's controls for that tier:

- the **org switcher** in the app shell,
- **org settings** (name / slug / metadata),
- **cross-workspace member management** (the roster across all the org's
  workspaces, with an org-scoped role and add / remove / change-role).

A NEW org-scoped `OrganizationRole` (**owner / admin / member**) sits **above**
the 6.4 workspace `MemberRole`: an org owner/admin administers the org and is
granted admin on **every** workspace under it; an org member belongs to the org
but is governed inside each workspace by their workspace role.

### Mirror product (rung 1 — cited, not asserted)

- **Atlassian / Jira Cloud** — the Organization is the topmost structure; it
  controls licensing, **billing** and security across sites. The **org admin** is
  the highest level of admin and the one who sees billing; site admins below do
  not. All org administration (users, billing, multiple sites) lives at
  `admin.atlassian.com` — a **distinct admin area** from a single site's
  settings. (Atlassian Community "Jira's Structure — Orgs, Sites, Spaces";
  Atlassian Support "types of admin roles".)
- **Linear** — a workspace is "the home for all issues in an organization"; the
  workspace **Owner** holds the org-root settings (members, billing, security);
  members belong to one-or-many teams under the root. Billing sits at the
  org/workspace **root**. (Linear Docs — Workspaces; Members and roles.)

Motir's `Organization` = the Atlassian org / Linear workspace-root (the
billing + identity root); Motir's `Workspace` ≈ an Atlassian site / a Linear
team-container under it.

### ⚠️ Out of scope here (named, NOT drawn)

- **Billing / credit / usage.** The org is the billing entity (Yue, locked), but
  6.10 ships **no** billing surface. The org-scoped usage/credit **view is
  7.12.5**; checkout/pricing is **Epic 8**. Org settings draws only a **passive
  "billing lives here later" placeholder** (the "Billing & usage" card with a
  "Coming soon" pill and a dashed note) — no active control.
- **The cross-ORG platform-staff superadmin console** that reads ACROSS all orgs
  is **Epic 10 / 10.1** — a SEPARATE platform-staff concept. This area is the
  **tenant** org-admin (the customer administering their own org), NOT that
  console.

---

## ⚠️ Progressive disclosure — the governing rule of the shell chrome

The data model **always** carries all three tiers (`Organization → Workspace →
Project`), auto-created at signup, so there is **never a migration** as a
customer grows. The **UI reveals a tier only when it offers a choice** — i.e.
when its count is at least two. "Scale" is not a mode the product detects; it
emerges from counts. There is **no "individual" branch**: a one-person company
(**OPC**) is just an organization with one member.

| Tier             | When it shows in the header                                                                                                                                                                                        |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Organization** | **Always** — the top-left anchor (a `Button` + `ChevronDown` opening its menu). Auto-created at signup, renameable. The menu's **"Switch organization" section appears only when the account belongs to ≥2 orgs.** |
| **Workspace**    | **Hidden until the org has a 2nd workspace.** One workspace is implicit and never shown. At ws #2 the workspace switcher appears to the RIGHT of the org (`Acme › Engineering`).                                   |
| **Project**      | **Always** — in the sidebar header (1.5.3), unchanged. Switching the workspace re-scopes it.                                                                                                                       |

So **only two count-driven reveals exist**: the workspace switcher at ws #2, and
the org menu's switch-org section at org #2. The same components render every
scale — OPC, small org, multi-workspace org, multi-org enterprise — by hiding any
tier whose count is 1. (Mirror: Atlassian shows the org picker "only when you
have more than one"; Linear's single-workspace view is equally clean.)

## Where it lives

- **Org control** — a new client component (mirror
  `app/(authed)/_components/WorkspaceSwitcher.tsx`) rendered in the **TopNav**
  (`app/(authed)/_components/TopNav.tsx`) as the **leftmost** anchor, ALWAYS
  present. It is a menu button (org avatar + name + `ChevronDown`), not only a
  switcher: the menu carries **Settings · Members · Billing & usage (Coming
  soon) · New workspace**, then — **only when the account is in ≥2 orgs** — a
  **"Switch organization"** section (the org list + **Create organization**).
- **Workspace switcher** — the shipped `WorkspaceSwitcher`, rendered to the
  RIGHT of the org with a `›` separator (`--el-text-faint`) **only when the
  active org has ≥2 workspaces**. Below that threshold it is not rendered at
  all. So the header reads `Acme` (1 ws) → `Acme › Engineering` (2+ ws).
- **Settings — collapsed at one workspace, but the workspace tier still does
  the work underneath.** The data is ALWAYS 3 tiers, and **workspace-scoped
  config keeps living on the `Workspace` row** (workflows, statuses, custom
  fields, labels, components, automation, dashboards, saved filters, workspace
  members — all `workspaceId`-scoped in the schema today). What collapses is
  only the _surface_:
  - **At ONE workspace:** a **single Settings area**, entered from the org menu,
    that renders **both** the org-scoped sections (org name / slug / billing
    placeholder / org members / danger zone) **and** the workspace-config
    sections — and **each section persists to its own tier underneath** (org →
    `Organization`, workspace-config → the single `Workspace`). The org settings
    "pass through" to the workspace's settings; there is **no separate
    `/settings/workspace` surface shown**, but the workspace settings are still
    the underlying mechanism being written. This avoids showing a small team an
    org-vs-workspace split that is 1:1 for them.
  - **At ≥2 workspaces:** the workspace-config sections **split out** into a
    per-workspace Settings surface (scoped by the active workspace), and the org
    Settings page keeps only the org-scoped sections. Nothing in the data moves —
    only which surface renders which sections.
  - Suggested routes: `app/(authed)/settings/organization/page.tsx` (org-scoped:
    general + billing placeholder + danger zone) and
    `app/(authed)/settings/organization/members/page.tsx` (the paginated roster);
    the existing `app/(authed)/settings/workspace/*` is the workspace-config
    surface that is **folded into** the org Settings page at one workspace and
    **re-surfaced standalone** at ws ≥ 2. All org-owner/admin gated (404-not-403
    for a non-org member; the forbidden treatment of panel 5d for a non-admin).

The page shells reuse the `/issues` + workspace-settings grammar: a serif `h2`
title + a muted subtitle, then a `stack` of `Card`s.

---

## Panels (review EACH — mistake #31)

### Panel 1 — progressive disclosure in the shell

The panel is a **ladder** demonstrating the count-driven reveal (above), not a
single switcher state:

- **A · 1 org · 1 workspace (top-left).** The header shows **only the org**
  (`Acme ▾`) as the top-left anchor; the **workspace is not shown at all**. The
  sidebar header carries the **project** switcher (`Mobile App ▾`). _This is the
  identical header for an OPC and for a 10-person small org — there is no
  individual mode._
- **B · 2+ workspaces (top-right).** The workspace switcher has appeared to the
  RIGHT of the org with a `›` separator (`Acme › Engineering`). This is the ONLY
  thing that surfaces the middle tier. Switching it re-scopes the sidebar project
  switcher.
- **C · the `Acme ▾` org menu, open (bottom).** One menu behind the org name:
  - **Settings · Members · Billing & usage (Coming soon) · New workspace** ("Adds
    the workspace switcher" — the discoverable path to reveal tier 2),
  - then a separator and the **"Switch organization"** section — **rendered only
    when the account is in ≥2 orgs**: one row per org with a `Check`
    (`--el-accent`, on the active org) + org avatar + "{n} workspaces" + the
    viewer's **org-role `Pill`**, plus **Create organization**.

**The load-bearing rule:** org is permanent top-left chrome; workspace is hidden
until ws #2; the org's switch-org list is hidden until org #2. (No "quiet label
vs dropdown" branch — the org is always a menu button; what its menu _contains_
is what scales.)

### Panel 2 — org settings (populated)

A `stack` of three `Card`s on the org-scoped settings page:

- **General** — `Input` fields: **Organization name**, **Organization URL**
  (`motir.co/` prefix + slug, with the lowercase/hyphen hint), **Contact email**.
  A header `Pill pill-owner` ("You're an owner"). Card foot: a "{n} workspaces ·
  {n} members" summary + a primary **Save changes** button.
- **Billing & usage** — the **PASSIVE placeholder** (a "Coming soon" neutral
  `Pill` + a dashed `note` reading that billing/credits/usage land later — org
  usage view 7.12.5, checkout Epic 8 — with **no active control**). This card
  exists so the layout stays stable when billing lands; it is NOT a billing UI.
- **Danger zone** — a destructive "Delete organization" `secondary`/`danger`
  button + the irreversibility copy (header in `--el-danger-text`).

**At one workspace, this page also folds in the workspace-config sections**
(workflows, statuses, custom fields, labels, components, automation, dashboards
— the existing `settings/workspace/*` surfaces), rendered below the org-scoped
cards as the same `stack` grammar. They are NOT redrawn in this org-admin asset
(they're owned by their own design areas); the org settings page simply hosts
them and writes them to the `Workspace` row underneath. At ws ≥ 2 these sections
move to a per-workspace Settings surface and this page keeps only the org-scoped
cards above. See "Settings — collapsed at one workspace" under _Where it lives_.

### Panel 3 — cross-workspace member management (PAGINATED)

The **roster of everyone across the org's workspaces**. One `Card` titled
**People** with a count `Pill` and an **"Invite to organization…"** `Combobox`
trigger in the header. Each member row (extends the workspace `MembersCard`
grammar):

- avatar + name (+ "(you)") + email,
- **workspace chips** (`pill-ws`, peach tint) naming which of the org's
  workspaces they belong to, with a **`+N` overflow** neutral pill when there are
  more than fit,
- the **org-role `Combobox`** (owner / admin / member) — except the **owner-self
  row**, whose role action is a disabled "Owner" affordance (you can't change
  your own owner role here),
- a **Remove** action (or **Revoke** for a pending invite row).
- A **pending-invite row** (faint avatar, "Invitation sent · awaiting
  acceptance", a "Pending" neutral pill) shows the invited-not-yet-joined state.

**⚠️ At-scale (finding #57 — NOT load-all).** The roster is **paginated**: a card
foot reads **"Showing 1–5 of 14"** + a **Prev / Page X of Y / Next** pager (Prev
disabled on page 1). A large org has hundreds of members across many workspaces —
the code subtask (6.10.5) MUST fetch a page at a time (the 6.10.4 service's
paginated `listMembers`), never `load-all`. Cursor or offset paging is
acceptable; the design shows page-numbered offset paging to match the count
display.

### Panel 4 — org-role + invite affordances

- **Org-role select OPEN** (owner / admin / member) with a one-line description
  per role, + a **role-explanation block** below it: an **owner/admin** pill row
  ("administer the org and are granted admin on **every** workspace under it") and
  a **member** pill row ("belongs to the org but … governed by their **workspace
  role** (the 6.4 MemberRole)"). This is where the design **distinguishes the org
  role from the workspace role** in writing.
- **Invite-to-organization picker OPEN** — a search `Combobox` over existing
  workspace members ("in workspace" meta) **plus** an **"Invite '…'"** send-email
  option for an address not yet present. Foot copy: invited people pick up the
  chosen org role; existing workspace members can be promoted to an org role here.
- An **info `note`**: _"Org membership gates workspace access: someone removed
  from the organization loses access to every workspace under it."_ (the 6.10.4
  gating decision, surfaced to the admin).

### Panel 5 — empty / loading / error + permission states

- **(a) Empty** — first-run / single-member org: an `EmptyState` ("It's just you
  so far") with an **Invite people** primary CTA.
- **(b) Loading** — the paginated-roster **`Skeleton`** (avatar + two lines +
  a chip placeholder per row), `aria-busy` / `aria-live="polite"` on the body.
- **(c) Error** — the roster fetch failed: an `ErrorState` (rose icon tint,
  "Couldn't load members") with a **Retry** secondary button.
- **(d) Forbidden** — signed in as an org **member** (not owner/admin): a gated
  `state` ("Organization settings are admin-only", lock icon, lavender tint) with
  a **Back to workspace** action — **the controls are NOT rendered** for a
  non-admin. (Distinct from the cross-tenant **404-not-403** posture for a
  non-org-member, which is a route-level not-found, not this in-app gated panel.)

---

## Primitives composed (no hand-rolling)

Every surface composes a shipped `components/ui/*` primitive. If 6.10.5 needs a
genuinely new primitive, that is a **new `design/` subtask**, not a code
workaround.

- **`Card`** — settings cards, the members card, the state panels (`--radius-card`,
  `--shadow-card`, `--spacing-card-padding`; head/body/foot regions split by
  `--el-border-soft`).
- **`Button`** — primary (Save, Invite people, Back to workspace), secondary
  (Retry), ghost (row Remove/Revoke), danger (Delete organization). Heights
  `--height-btn-md` / `--height-btn-sm`; padding `--spacing-btn-x[-sm]`.
- **`Popover` + `Combobox`** — the org switcher menu, the invite picker, the
  per-row org-role select, the per-row search. `--radius-card` container,
  `--shadow-elevated`, rows at `--spacing-control-*` / `--radius-control`.
- **`Input`** — the org-settings fields (`--height-input`, `--spacing-input-*`,
  `--radius-input`); the URL field uses a `--el-text-faint` `motir.co/` prefix.
- **`Pill`** — org-role chips (see colour roles below), workspace chips, the
  count + pending + "Coming soon" neutral pills. `--radius-badge`,
  `--spacing-chip-*`; **hue in the tint BACKGROUND with `--el-text-strong` text
  (finding #35 — AA-safe), never a tinted page surface.**
- **`EmptyState` / `ErrorState`** family — panels 5a/5c/5d.
- **`Skeleton`** — panel 5b loading roster.
- **`Tooltip`** — the read-only / disabled-affordance explainer grammar (ink bg,
  `--el-text-inverted`).
- **Pagination** — a list-foot pager (count text + Prev/Next + page indicator).
  Reuse the at-scale list pattern Story 6.4 / the issues list established; do NOT
  hand-roll a new control.
- **Org avatar** — a small `--radius-control` square initial chip (lavender tint
  by default; per-org tint when shown in the switcher list), distinct from the
  round **user** avatar.

## Colour roles (`--el-*` — palette, not grey-only · finding #54)

| Element                           | Token                                                   | Why                                                                        |
| --------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------- |
| **Org-role: owner**               | `--el-tint-lavender` bg + `--el-text-strong`            | The highest, special role — the brand-purple family; carries a crown icon. |
| **Org-role: admin**               | `--el-tint-sky` bg + `--el-text-strong`                 | Distinct blue tint, clearly below owner.                                   |
| **Org-role: member**              | `--el-tint-mint` bg + `--el-text-strong`                | Green tint — the baseline tier, still coloured (not bare grey).            |
| **Workspace-membership chips**    | `--el-tint-peach` bg + `--el-text-strong`               | "Scope" chips read as a different category from the role chip.             |
| **Count / pending / coming-soon** | `--el-surface` + `--el-text-secondary` (neutral `Pill`) | Genuinely neutral metadata.                                                |
| **Error icon tint**               | `--el-tint-rose` + `--el-danger-text`                   | Fetch-error state.                                                         |
| **Forbidden icon tint**           | `--el-tint-lavender` + `--el-text-strong`               | The lock/gated state.                                                      |
| **Primary CTAs / active check**   | `--el-accent` (+ `--el-accent-text`)                    | Save / invite / the active-org check.                                      |
| **Danger zone**                   | `--el-danger-text` / `--el-danger`                      | Delete-org header + button.                                                |
| Text / surfaces / borders         | `--el-text*`, `--el-surface*`, `--el-border*`           | Standard element tokens — never Tier-0 `--color-*`.                        |

All shaped surfaces use the **`[data-display-style]` shape tokens**
(`--radius-{btn,card,input,control,badge}`, `--spacing-{btn,input,control,chip,
card-padding}`, `--height-{btn-*,input,control}`, `--shadow-*`) — never the inert
Tier-0 radius/spacing scale or a fixed raw utility. `rounded-full` (`9999px`) is
used only for the round user avatar and status dots. Toggle the mock's dark mode
to confirm token parity (every colour flips through Tier-0 under `--el-*`).

## Copy strings (en — the `orgAdmin` i18n namespace 6.10.5 adds)

- Org menu: items **"Settings"**, **"Members"**, **"Billing & usage"** /
  **"Coming soon"**, **"New workspace"** ("Adds the workspace switcher"); the
  switch-org section (≥2 orgs only) heading **"Switch organization"**, per-org
  sub **"{count} workspace(s)"**, **"Create organization"**. Workspace switcher
  (≥2 ws only) reuses the shipped `shell.workspaceSwitcher` strings.
- Settings: **"Organization settings"** (title); **"Manage the {org}
  organization — the account your workspaces live under. Only organization owners
  and admins can change these."** (subtitle); fields **"Organization name"**,
  **"Organization URL"**, **"Contact email"**; **"Save changes"**; billing card
  **"Billing & usage"** / **"Coming soon"** / the 7.12.5 + Epic 8 placeholder
  note; **"Danger zone"** / **"Delete organization"**.
- Members: **"Members"** (title); **"Everyone in the {org} organization, across
  all its workspaces. An organization role applies org-wide; workspace membership
  is shown per person."** (subtitle); **"People"**; **"Invite to organization…"**;
  roles **"Owner / Admin / Member"** with descriptions ("Full control — billing,
  delete, all workspaces" / "Manage members + settings + every workspace" /
  "Belongs to the org; access by workspace role"); **"Remove"** / **"Revoke"**;
  **"Pending"**; pager **"Showing {from}–{to} of {total}"**, **"Page {n} of
  {m}"**, **"Prev"** / **"Next"**.
- Role help: **"Owner / Admin administer the organization and are granted admin
  on every workspace under it — above any per-workspace role."**; **"An org Member
  belongs to the org but has no cross-workspace powers — what they can do inside a
  workspace is still governed by their workspace role (the 6.4 MemberRole)."**;
  gating note **"Org membership gates workspace access: someone removed from the
  organization loses access to every workspace under it."**
- States: empty **"It's just you so far"** / **"Invite teammates to the {org}
  organization. They'll get access to the workspaces you add them to."** /
  **"Invite people"**; error **"Couldn't load members"** / **"Something went
  wrong fetching this organization's members. Try again."** / **"Retry"**;
  forbidden **"Organization settings are admin-only"** / **"Only owners and
  admins of {org} can manage members and settings. Ask an organization admin if
  you need a change."** / **"Back to workspace"**.

The full string set is added to the app's locale files (en + zh, the shipped
locale set) by the 6.10.5 code subtask under the new `orgAdmin` namespace.
