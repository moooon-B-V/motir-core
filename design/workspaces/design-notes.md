# Story 1.2 design notes (Subtask 1.2.1 output)

This file is the canonical reference for Subtask 1.2.6 (implementation) —
which primitives compose each surface, which copy strings to use verbatim,
and what new primitive needs to be added.

All four surfaces are drafted in Pencil (`*.pen`) with PNG exports for
review. Open the `.pen` files via Pencil to inspect layers, variables,
and annotations.

---

## Files

| `.pen` source       | PNG exports                                                                                                 |
| ------------------- | ----------------------------------------------------------------------------------------------------------- |
| `switcher.pen`      | `switcher-closed.png`, `switcher-open.png`                                                                  |
| `settings.pen`      | `settings.png`, `invite-dialog.png`, `invite-dialog-errors.png`, `delete-confirm.png`                       |
| `invite-accept.pen` | `invite-accept.png`, `invite-accept-expired.png`, `invite-accept-used.png`, `invite-accept-wrong-email.png` |
| `invite-email.pen`  | `invite-email-html.png`, `invite-email-text.png`                                                            |

### Surfaces owned ELSEWHERE that render inside workspace settings

| Surface                              | Asset (in another area)                      | Why it lives there                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------ | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Workspace Security — require 2FA** | `design/org-admin/security-policy.mock.html` | Story 8.13 (MOTIR-1215) · 8.13.1 (MOTIR-3642). The org and workspace tiers render the **same card**, and the state that matters most — LOCKED ON because the organization mandates it — is only meaningful with both tiers in one drawing. It also has **two homes**: `/settings/workspace/security` above the workspace-tier reveal threshold, and the `/settings/organization` fold-in below it (`docs/decisions/organization-tier.md` §6d). Drawn once, in the org-admin area, rather than half here and half there. |

⚠️ **So a reader of this area is not looking at an undrawn surface.** The
workspace Security pane composes INTO the page `settings.pen` owns; that asset is
not re-specified there, and this one does not draw the control.

---

## New primitive required for 1.2.6

`components/ui/Popover.tsx` does NOT exist yet. The workspace switcher's
open state requires a Popover (anchored, click-outside-dismissable,
focus-trapped). Implementation pattern: same shape as `components/ui/Modal.tsx`
(Radix-wrapped) — wrap `@radix-ui/react-popover`'s Root / Trigger / Portal /
Content / Anchor. Suggested signature:

```tsx
<Popover open={open} onOpenChange={setOpen}>
  <Popover.Trigger asChild>{children}</Popover.Trigger>
  <Popover.Content align="start" sideOffset={8}>
    {menuItems}
  </Popover.Content>
</Popover>
```

Match `Modal`'s class structure for portal/overlay/border/shadow so the
two primitives feel consistent. No new tokens needed — use existing
`--radius-card`, `--shadow-elevated`, `--color-hairline`.

---

## Primitives composed per surface

### Workspace switcher (`switcher.pen`)

- **Trigger** (closed state): `Button variant="ghost" size="md"` containing
  workspace name (truncated at ~24 chars) + lucide `ChevronDown` icon
  (rightIcon).
- **Menu** (open state): NEW `Popover` primitive, 320px wide. Inside:
  - Section header: `<span>` with mono caps font, `text-(--color-muted-foreground)`.
  - Membership rows: bare `<button>`s with workspace name + role `Pill severity="info"` (or just neutral `Pill` matching style).
  - Active membership uses lucide `Check` icon (`--color-primary` fill) + bold name + `--color-surface` background.
  - Divider: `<div className="h-px bg-(--color-hairline)" />`.
  - "Create workspace" entry: bare button with lucide `Plus` icon + label.
  - **"Workspace settings" entry: bare anchor with lucide `Settings` icon + label**, targeting
    `/settings/workspace` — **added by MOTIR-4845** (Story MOTIR-4843), which RECORDS the row; it is
    DRAWN by `design/settings/workspace-settings.mock.html` **panel 5** (MOTIR-4844), which is its
    design of record, and BUILT by MOTIR-4847.
  - "Invite teammates" entry: bare anchor with lucide `Mail` icon + label, targeting
    `/settings/workspace#members`.

> ### ⚠️ Where the `Workspace settings` row CAME FROM, and why it sits where it does
>
> It comes from the **account menu**, where it had been filed under the user tier — one line under
> `Account settings` and one above `Sign out` — while naming a workspace-tier destination. The
> account menu's own asset (`design/shell/account-menu.mock.html`) loses it in the same amendment,
> and `design/shell/design-notes.md` § _The account menu_ carries the departure.
>
> **It sits in the LAST group, ABOVE `Invite teammates`.** The popover's three groups answer three
> different questions — _which workspace am I in_, _make a new one_, and _act on THIS one_ — and
> both of the last group's rows are about the active workspace. Settings goes first because
> `Invite teammates` already points **into** it (`/settings/workspace#members`): the general door
> above the shortcut through it.
>
> **The glyph is the `Settings` gear**, which is the one the account-menu row carried, so the
> departure and the arrival read as one move rather than as two rows.
>
> **Below the reveal this row does not exist, because the SWITCHER does not.** At one workspace
> there is no switcher in the top bar at all, and **all three** `/settings/workspace/*` routes
> `notFound()` there — so nothing is stranded on the other side of the threshold by the move. Every
> one of those surfaces' capabilities is hosted on `/settings/organization`, gated per SECTION:
> Name / Members / Danger zone / require-2FA in the existing `WorkspaceFoldInSection`, and the
> job-runs dashboard in the `Job runs` fold-in MOTIR-4861 adds
> (`docs/decisions/organization-tier.md` §6d — the capability is RELOCATED, not exempted).

### Settings page (`settings.pen`)

- **Top-nav** (minimal — same instance reused across all `(authed)/*` routes;
  expands further in Story 1.5): workspace switcher on the left, user-menu
  avatar on the right. Lives in `app/(authed)/layout.tsx`.
- **Page header**: serif h1 (`font-serif text-3xl font-semibold`) + sans
  subhead (`text-sm text-muted-foreground`).
- **Name card**: `Card` with `Input` + `Button variant="primary"` Save.
  Helper text via `Input`'s `helperText` prop: `"Visible to everyone in this workspace."`
- **Members card**: `Card` with custom rows; per-row composes avatar +
  name + email + `Pill` (role) + `Button variant="ghost"` Remove (hidden
  for current user's row). Bottom of card: `Button variant="secondary"`
  Invite triggering the Invite `Modal`.
- **Danger zone card**: `Card` with 2px destructive border (`stroke` color =
  `--color-destructive`). Two stacked rows:
  - Leave workspace + `Button variant="danger"` Leave.
  - Delete workspace + `Button variant="danger"` Delete (opens
    delete-confirmation `Modal`).
  - Hairline divider between the two rows.

### Invite Dialog (`settings.pen`, separate frame)

- `Modal` size="md", title `"Invite to {Workspace}"`, description
  `"They'll get an email with a one-time link. Links expire in 7 days."`
- `Input label="Email address"` with placeholder `"teammate@example.com"`.
- `Modal.Footer` with `Button variant="ghost"` Cancel + `Button variant="primary"` Send invite.
- Error states (per `invite-dialog-errors.png`): `Input error` prop displays
  the destructive message inline, input border flips to destructive. Two
  documented error copy strings:
  - `"{email} is already a member of this workspace."` (server 422)
  - `"You've already sent 3 invites to this address in the last hour. Please wait before trying again."` (server 429)

### Delete confirmation Dialog (`settings.pen`)

- `Modal` size="md", **no title prop** — render a custom heading row inside
  with a lucide `TriangleAlert` icon in a rose-tinted circle + `"Delete {Workspace}?"`.
- Body: `"This will permanently delete the workspace and all its data (projects, work items, members). This action cannot be undone."`
- `Input label="Type {workspace name} to confirm"` (use workspace name as
  the placeholder verbatim).
- `Modal.Footer` with `Button variant="ghost"` Cancel + `Button variant="danger"` Delete workspace.
- **Delete button is disabled (opacity 50, pointer-events none) until the
  typed input matches the workspace name EXACTLY** (case-sensitive comparison).

### Invite-acceptance page (`invite-accept.pen`)

Reuses the card-wrapped auth layout from `app/(auth)/layout.tsx` (tinted
page background `--color-surface`, centered `--color-background` card with
`rounded-(--radius-card)` and `shadow-(--shadow-elevated)`). Width pinned
at 448px (28rem); page padding 80/160.

- **Happy path**: serif h1 `"Join {Workspace}"`, sans subhead
  `"{Inviter name} invited you to collaborate."`, single primary
  `Button` "Accept invite".
- **Expired**: serif h1 `"This invite has expired"`, sans subhead
  `"Invites are valid for 7 days. Ask the inviter for a new link if you'd still like to join."`, single secondary `Button` "Back to dashboard".
- **Used**: serif h1 `"This invite has already been used"`, sans subhead
  `"If you joined from another email, sign in with that account."`, single secondary `Button` "Back to sign in".
- **Wrong email**: serif h1 `"Sign in with the invited email"`, sans
  subhead `"This invite is for {invited.email}. You're signed in as {current.email}. Sign in with the invited email to accept, or ask the inviter to re-send to your address."`, two stacked buttons — primary `"Sign in with {invited.email}"` (links to `/sign-in?email={invited.email}`), secondary `"Back to dashboard"`.

### Invite email (`invite-email.pen`)

Two parallel renders the implementation must ship: HTML (rendered in the
recipient's email client) and plain-text (fallback for clients that
strip HTML). Both shipped via `sendEmail({ html, text })` from `lib/email.ts`.

- **Subject** (verbatim, both versions): `"You're invited to join {Workspace} on Motir"`
- **HTML body** (600px-wide table-friendly column for email clients):
  - Plain-text "Motir" header at top (no logo — brand-mark deferral).
  - Greeting `"Hi,"`.
  - Body line `"{Inviter name} invited you to join {Workspace} on Motir."`
  - Primary CTA button (full width inside the 600px column).
  - `"Or copy this link into your browser:"` followed by the URL as monospace text on its own line.
  - Hairline divider.
  - `"This invite expires in 7 days."`
  - `"Don't know {Inviter}? You can safely ignore this email."`
- **Plain-text body** (monospace mockup):
  - URL on its own line, UNREDACTED — must satisfy the regex
    `/https?:\/\/[^\s)]+/` used by `tests/e2e/_helpers/email-capture.ts`'s
    `extractInviteUrl()` (mirrors the `extractResetUrl()` pattern from
    Subtask 1.1.6).

---

## Copy strings catalog (use verbatim in 1.2.6)

A consolidated list for grep convenience. If the implementation diverges
from these strings, update both the implementation AND this list so the
mockup stays the source of truth.

| Surface                                 | String                                                                                                                                                                |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Switcher trigger placeholder            | (no placeholder — always shows current workspace name)                                                                                                                |
| Switcher heading                        | `"WORKSPACES"`                                                                                                                                                        |
| Switcher: Create workspace entry        | `"Create workspace"`                                                                                                                                                  |
| Switcher: Invite teammates entry        | `"Invite teammates"`                                                                                                                                                  |
| Settings page h1                        | `"Workspace settings"`                                                                                                                                                |
| Settings page subhead                   | `"Manage your workspace name, members, and lifecycle."`                                                                                                               |
| Name card heading                       | `"Workspace name"`                                                                                                                                                    |
| Name card helper                        | `"Visible to everyone in this workspace."`                                                                                                                            |
| Name card Save button                   | `"Save"`                                                                                                                                                              |
| Members card heading                    | `"Members"` (count pill: `"{n} members"`)                                                                                                                             |
| Members card Invite button              | `"Invite"`                                                                                                                                                            |
| Members card current-user suffix        | `"(you)"`                                                                                                                                                             |
| Members card row Remove button          | `"Remove"`                                                                                                                                                            |
| Danger zone heading                     | `"Danger zone"`                                                                                                                                                       |
| Leave workspace title                   | `"Leave workspace"`                                                                                                                                                   |
| Leave workspace body                    | `"You'll lose access to all data in this workspace."`                                                                                                                 |
| Leave workspace button                  | `"Leave"`                                                                                                                                                             |
| Delete workspace title                  | `"Delete workspace"`                                                                                                                                                  |
| Delete workspace body                   | `"Permanently delete this workspace and all its data. This cannot be undone."`                                                                                        |
| Delete workspace button                 | `"Delete"`                                                                                                                                                            |
| Invite Dialog title                     | `"Invite to {Workspace}"`                                                                                                                                             |
| Invite Dialog body                      | `"They'll get an email with a one-time link. Links expire in 7 days."`                                                                                                |
| Invite Dialog input label               | `"Email address"`                                                                                                                                                     |
| Invite Dialog input placeholder         | `"teammate@example.com"`                                                                                                                                              |
| Invite Dialog Cancel button             | `"Cancel"`                                                                                                                                                            |
| Invite Dialog Send button               | `"Send invite"`                                                                                                                                                       |
| Invite error: already a member          | `"{email} is already a member of this workspace."`                                                                                                                    |
| Invite error: rate limited              | `"You've already sent 3 invites to this address in the last hour. Please wait before trying again."`                                                                  |
| Delete confirm dialog title             | `"Delete {Workspace}?"`                                                                                                                                               |
| Delete confirm body                     | `"This will permanently delete the workspace and all its data (projects, work items, members). This action cannot be undone."`                                        |
| Delete confirm input label              | `"Type {workspace name} to confirm"`                                                                                                                                  |
| Delete confirm Cancel button            | `"Cancel"`                                                                                                                                                            |
| Delete confirm Delete button            | `"Delete workspace"`                                                                                                                                                  |
| Invite-accept happy h1                  | `"Join {Workspace}"`                                                                                                                                                  |
| Invite-accept happy subhead             | `"{Inviter name} invited you to collaborate."`                                                                                                                        |
| Invite-accept happy CTA                 | `"Accept invite"`                                                                                                                                                     |
| Invite-accept expired h1                | `"This invite has expired"`                                                                                                                                           |
| Invite-accept expired subhead           | `"Invites are valid for 7 days. Ask the inviter for a new link if you'd still like to join."`                                                                         |
| Invite-accept expired CTA               | `"Back to dashboard"`                                                                                                                                                 |
| Invite-accept used h1                   | `"This invite has already been used"`                                                                                                                                 |
| Invite-accept used subhead              | `"If you joined from another email, sign in with that account."`                                                                                                      |
| Invite-accept used CTA                  | `"Back to sign in"`                                                                                                                                                   |
| Invite-accept wrong-email h1            | `"Sign in with the invited email"`                                                                                                                                    |
| Invite-accept wrong-email subhead       | `"This invite is for {invited.email}. You're signed in as {current.email}. Sign in with the invited email to accept, or ask the inviter to re-send to your address."` |
| Invite-accept wrong-email primary CTA   | `"Sign in with {invited.email}"`                                                                                                                                      |
| Invite-accept wrong-email secondary CTA | `"Back to dashboard"`                                                                                                                                                 |
| Invite email subject                    | `"You're invited to join {Workspace} on Motir"`                                                                                                                       |
| Invite email greeting                   | `"Hi,"`                                                                                                                                                               |
| Invite email body                       | `"{Inviter name} invited you to join {Workspace} on Motir."`                                                                                                          |
| Invite email CTA                        | `"Accept invite"`                                                                                                                                                     |
| Invite email copy-link prompt           | `"Or copy this link into your browser:"`                                                                                                                              |
| Invite email expiry                     | `"This invite expires in 7 days."`                                                                                                                                    |
| Invite email ignore footer              | `"Don't know {Inviter}? You can safely ignore this email."`                                                                                                           |

---

## Brand-mark deferral confirmation

Per `MOTIR.md` "Brand-mark deferral principle": no placeholder wordmark
appears on any of these surfaces. Specifically:

- The settings top-nav has NO logo slot — only the workspace switcher
  (left) + user-menu avatar (right).
- The invite-acceptance card has NO header above the card (auth-layout
  parity with `/sign-in`, `/sign-up`, `/reset-password`).
- The invite email's "Motir" header is **plain text** in muted color,
  not a logo slot. If/when a real wordmark lands in a late-Epic-4 Subtask,
  the email will replace this with the logomark; until then, plain text
  avoids the filler-element trap.

---

## Theme parity

Pencil variables are wired for light + dark via `--background`,
`--foreground`, `--surface`, `--muted-foreground`, `--hairline`,
`--primary`, etc. The exported PNGs are all light-mode renders because
that's the default theme. Dark-mode parity should be verified manually
during 1.2.6's smoke test by toggling `data-theme="dark"` on the html
element and visiting each surface.

The `delete-confirm.png` warning icon uses `$--destructive` (`#e03131`)
inside a `$--tint-rose` (`#fde0ec`) circle — both have dark-mode overrides
in `app/globals.css` (tint-rose stays the same hex; destructive stays the
same hex per the design system's "semantic colors don't theme" rule).

---

## Source of truth for the auth-card frame

Subtask 1.2.1's invite-acceptance card composes the layout that ships at
`app/(auth)/layout.tsx` today (tinted `--color-surface` page, centered
`--color-background` card with `rounded-(--radius-card)` +
`shadow-(--shadow-elevated)`, max-width 28rem, no wordmark) — the
post-1.1.10 card-wrapped design. The older `design/auth/*.png` mockups
predate 1.1.10 and don't reflect the shipped layout; they're correct as
a snapshot of the design at the time 1.1.1/1.1.5 shipped, but the code is
the source of truth going forward.

---

## The streaming allocation at ARRIVAL — `/invite/accept` (MOTIR-3442)

Part of [MOTIR-3440](motir:cmt8s085i003li1ph06u469kx)'s sweep of the 24 heavy authed surfaces. The
rule this applies is `design/shell/design-notes.md` § _The navigation-pending grammar_ →
_WHICH SURFACES EARN A FRAME_, and the three-tier method is
`design/work-items/design-notes.md` § _The item page at ARRIVAL_'s. **Neither is restated here.**
Measured against `origin/main` `9455fc3c`.

**Asset ·** `invite-arrival.mock.html` / `invite-arrival.png`. **This is the only one of MOTIR-3442's
ten surfaces whose verdict is _a frame of its own_, and therefore the only one that draws.**

|                            |                                                                                                                                                                                                                   |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **the gate**               | `getTranslations('auth')` → `getSession` (**`redirect('/sign-in')`**) → `searchParams` → `workspaceInvitesService.inspectInvite(token)`, which selects **all four** bodies: accept · expired · used · wrong-email |
| **with the frame**         | — **nothing.** The headline is `t('joinWorkspace', { workspaceName })` and the subhead names the inviter; both come from the read, and three of the four branches replace them outright                           |
| **with the first content** | the whole body — one of the four `AuthShell`s                                                                                                                                                                     |
| **after the page**         | — nothing                                                                                                                                                                                                         |
| **settles**                | **once**                                                                                                                                                                                                          |
| **verdict**                | **A FRAME OF ITS OWN.** This is the case rule 2 is written for: there is genuinely nothing to show until the gate resolves                                                                                        |

> ## ⚠️ AMENDMENT — 2026-08-26, MOTIR-3447. `inspectInvite` IS NOT A GATE, AND THE FRAME DEPENDS ON THAT.
>
> The table above files `workspaceInvitesService.inspectInvite(token)` under **the gate**, on the
> grounds that it _"selects all four bodies"_. It does select all four bodies — and it is **not a
> gate**, because a gate is a read that decides the HTTP STATUS. This route answers **200** whatever
> the token turns out to be: expired, used, wrong-account and valid are four BODIES, not four
> statuses, and the page calls `notFound()` nowhere.
>
> **The distinction is the whole reason a frame is possible here.** Had the read been a gate, a
> boundary placed after it would cover nothing — the body would already be resolved — and this
> surface's verdict would collapse to the same _none_ as the other nine. Because it is a content
> read, it moves BELOW the boundary and the card's chrome paints while the token resolves.
>
> What stays above, in the page, is the **session redirect** — that one does decide the response,
> and an unauthenticated visitor must be bounced rather than framed. The token-less case is answered
> above it too: there is nothing to resolve, so there is nothing to frame.
>
> Everything else in this entry is unchanged and shipped as drawn.

**Why this one and not the other nine.** Every other surface in the sweep can paint a title, a
toolbar, a switcher or a back-link from strings the gate already has. This one cannot paint a single
character of its own copy — and it is the only surface in the story reached by a **hard navigation
from outside the app**, from a link in an email, so `design/shell/design-notes.md` § _WINDOW 1_'s
shell mark cannot speak for it either. There is no mounted shell. Between the click in the mail
client and `inspectInvite` returning, the reader has nothing at all.

**What the frame draws — and what makes it a stand-in rather than a guess.** All four bodies render
the same chrome: `InviteCard` wrapping `AuthShell`, a headline line, a subhead line, and one
full-width control. The frame is that chrome with the two text lines as placeholder bars and the
control as a button-height block. **It cannot mispredict**, because the shape is identical whichever
branch arrives — only the words differ.

| block    | box                                | the region it becomes                                                                                                         |
| -------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| headline | `h-7` · `w-3/4`                    | `AuthShell`'s headline — _Join {workspace}_ / _Invite expired_ / _Invite already used_ / _That invite is for another address_ |
| subhead  | `h-4` · `w-full` + `h-4` · `w-2/3` | the subhead, which wraps to two lines in the accept and wrong-email branches                                                  |
| control  | `h-(--height-btn-md)` · full width | `AcceptInviteButton`, or the Back button the other three render                                                               |

**One correction to the card that commissioned this, on the record.** [MOTIR-3442](motir:cmt8s088r003ni1phat3x1o9q)
describes the reader as _"a person who is not signed in to anything yet"_. The shipped route is
`app/(authed)/invite/accept/page.tsx` and its second line is `if (!session) redirect('/sign-in')` —
so an unauthenticated visitor never reaches this page, and the frame is for a reader who **is**
signed in and has just followed a link from their mail client. The frame is unchanged by the
correction; the sentence that would have justified an unauthenticated variant is not.

**A route boundary is PROHIBITED for the group, and a preference here** — `/invite/accept` does not
itself call `notFound()`, but rule 5 is one mechanism, not two: the frame is an in-page
`<Suspense>` after the gate, like every other page's.

## Workspace roles (MOTIR-6456 · Story MOTIR-6168)

Roles move from the project to the WORKSPACE (`docs/decisions/role-model.md` §2, approved
2026-09-25): each person holds ONE workspace role — **Manager · Member · Viewer**, or a workspace
**custom role** — and it is their role in every project of that workspace. This section draws the
four surfaces that change, as DELTAS over designs that already shipped; it does not redraw them.

### Files

| HTML source (truth)                                  | Panels                                             |
| ---------------------------------------------------- | -------------------------------------------------- |
| `design/workspaces/workspace-roles.mock.html`        | 1a–1h Members · 2a–2h Roles · 4a–4c doors · 5 dark |
| `design/projects/access-members--no-roles.mock.html` | 3a–3b project Members without roles · 3c dark      |

Two files per area, no image export (`CLAUDE.md` § _Design assets_). Both mocks carry a **Theme**
and a **Language · 语言** toggle: every panel is drawn in light and dark and carries its copy in en
and zh; panel 5 / 3c is a nested dark scope so the dark render is also on the page without a click.

### What it amends — rendered first, then drawn

Rendered against `origin/main` @ `7717433af` on a `pnpm db:seed` tenant (a second workspace, _Sales_,
created through the shipped **New workspace** door to reach the revealed tier):

| Panel | Amends (card · `sourcePath`)                                                                                                          | Rendered at                                                                                |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 1     | MOTIR-1164 era Members card, `design/workspaces/settings.pen` + shipped `app/(authed)/settings/workspace/_components/MembersCard.tsx` | `/settings/workspace` (revealed)                                                           |
| 2     | MOTIR-2259 · `design/projects/roles-permissions.mock.html`; MOTIR-2257 (custom roles editor, delete-with-reassign)                    | `/settings/project/roles`, `/settings/project/roles/member`, `/settings/project/roles/new` |
| 3     | `design/projects/access-members.mock.html` + shipped `ProjectMembersSettings.tsx`                                                     | `/settings/project/members`                                                                |
| 4     | MOTIR-4844 · `design/settings/workspace-settings.mock.html` (the rail, the reveal, the fold-in `WorkspaceFoldInSection`)              | `/settings/workspace`, `/settings/organization`                                            |

### Panel 1 — workspace Members: the role column

**Composing primitives:** `Card` (header row: `h2` + neutral count `Pill` + secondary `Button`
_Invite_ with `Mail`), the member row of `MembersCard.tsx` unchanged (avatar `--el-text` /
`--el-text-inverted`, name `--el-text`, email `--el-text-secondary`), and in place of its neutral role
`Pill` the **`Combobox`** trigger exactly as `ProjectMembersSettings.tsx` renders it (`w-[8.5rem]`,
`--el-border`, `--radius-input`, `--height-control`, `ChevronsUpDown` in `--el-text-secondary`).
A new **column header** row (mono caps, `--el-text-secondary`, hairline `--el-border-soft`) labels
_Person_ / _Workspace role_.

- **1a populated (Manager).** Every row has the picker, the Manager's own row included — a Manager may
  step down while another Manager remains. The self row has no _Remove_ (as shipped); its slot is held
  by an invisible copy so the pickers stay in one column.
- **1b picker open.** The shipped grouped option list moved up a tier: **Built-in** (Manager · Member
  · Viewer, each with its one-line description) then **Custom roles** (every workspace custom role,
  secondary line _Custom role_). A custom role's name is its author's text and is never passed
  through `t()`. Selected option: `Check` in `--el-accent-on-surface` on `--el-surface`.
- **1c the only Manager.** A single-member workspace: the picker is **disabled** (in-place control ⇒
  disable, MOTIR-2462's treatment table, `design/projects/design-notes.md` § _Amendment 2026-08-08_)
  and the reason is written under the row with `Lock` — it names the action that unlocks it.
- **1d last-Manager refusal.** The server refuses a change that would leave no Manager (a race, or
  the API); the picker snaps back and an error `Toast` says who stays a Manager.
- **1e pending → error.** Pending: the trigger shows the chosen value, disabled (`--el-surface`
  fill), `LoaderCircle` in place of the chevron. Error: the value reverts to what the server holds
  and an error `Toast` names the person. Success (not drawn — a stock success `Toast`): _“Bo Philips
  is now a Viewer in every project of Sales”_.
- **1f non-Manager.** Every role readable; every picker in its disabled treatment, so the column keeps
  its shape; one `info-note` above the list says why. No migration notice (Managers only). _Invite_ /
  _Remove_ as shipped — who may do those is bug MOTIR-6317's.
- **1g migration notice, present.** A `Card` ABOVE Members (`--el-border-strong` edge), `UserRoundCog`
  glyph, title + count `Pill`, a _Managers only_ neutral `Pill` with `Lock`. One row per report row:
  avatar, name, **before** (the legacy workspace role and every project role, `--el-text-secondary`)
  → `ArrowRight` → the **after** role `Pill`, the reason sentence, and a ghost _Dismiss_ per row.
- **1h after one dismiss / absent.** The row leaves and the count drops, success `Toast` _Dismissed_.
  With no open row the card is **not rendered** — no “nothing changed” chrome.

**Role pill hues** are the shipped member-role tokens, moved up a tier with their meaning:
Manager `--el-role-admin` (lavender), Member `--el-role-member` (sky), Viewer `--el-role-viewer`
(mint), custom `--el-role-custom` (peach). Ink `--el-text-strong`; the kind is carried in words.

**Reason sentences** (one per `RoleMigrationReason`, MOTIR-6457):

| reason                  | en                                                                  | zh                                               |
| ----------------------- | ------------------------------------------------------------------- | ------------------------------------------------ |
| `narrowest_kept`        | Held a narrower role in a project — the narrowest was kept.         | 在某个项目中持有更窄的角色——保留了最窄的角色。   |
| `project_role_dropped`  | A project role wider than the workspace role was dropped.           | 比工作区角色更宽的项目角色已被移除。             |
| `custom_role_recreated` | Their custom project role was re-created at the workspace.          | 其自定义项目角色已在工作区重新创建。             |
| `custom_role_merged`    | Two custom roles merged into one holding only the keys both shared. | 两个自定义角色合并为一个，仅保留两者共有的权限。 |
| `org_admin_granted`     | Became an organization Admin, as every workspace owner does.        | 成为组织管理员（每位工作区所有者均如此）。       |
| `mapped_narrower`       | Their keys in a project are narrower than before.                   | 在某个项目中的权限比以前更窄。                   |

### Panel 2 — workspace Roles: list, detail, editor, delete

Composed from the shipped `RoleList.tsx` / `RoleDetail.tsx` / `RoleEditor.tsx` /
`RoleDeleteControl.tsx`. **Only what changes is new:**

- The room lives at **`/settings/workspace/roles`** — the list, and beneath it the role detail, the
  editor and New role, mirroring the project routes one for one; heading **Roles & permissions**, subtitle names the workspace; crumbs read
  _Workspace settings · Roles & permissions · …_.
- Built-ins are **Manager · Member · Viewer** with tiles `Shield` / `Users` / `Eye` on the role hues
  above; custom roles list under a **Custom roles** sub-head with `KeyRound` on `--el-role-custom`.
- Member counts count **workspace** members.
- **Each role shows its three view-any keys as a _Rooms_ row** — chips _Plans · Approvals · Runs_,
  held = `Check` on `--el-muted` / `--el-border`, not held = `X` on a dashed `--el-border-strong`
  outline (the difference is carried by glyph AND an `sr-only` word, never hue alone). This is how
  a Manager sees which room a custom role closes (2b: _Reviewer_ without Runs).
- **2c** a custom role held by nobody: neutral `Pill` _Held by nobody_.
- **2d** non-Manager: entry point hidden (no _Create role_), an `info-note` says who can change roles;
  rows still open the read-only detail, whose _Edit_ / _Delete_ are absent.
- **2f** _Create a role_: the shipped **Start from** native select, options now **Manager · Member ·
  Viewer**; each base seeds the grid (every base holds all three Rooms keys). The grid in the mock is
  an excerpt; the full catalogue renders as shipped.
- **2g** editing _Reviewer_: an `info-note` states that saving changes the role for everyone holding
  it, in every project.
- **2h** delete while held → the shipped reassign `Modal`, naming **workspace** members; the default
  target is the role's base.

### Panel 3 — project Members without roles

The role `Combobox` and the role `Pill` leave every row; the people list, _Add a member_ and _Remove_
stay. The Members `Card` gains one line: _People added to this project. What each can do comes from
their workspace role — manage roles in workspace settings._ + a `link` _Workspace roles →_. The page
subtitle's _Workspace owners and admins_ becomes _Workspace Managers_. The **access-level card is
unchanged** (drawn as a stub): MOTIR-6169 redesigns it. Empty state (3b): `Users` glyph, _Nobody added
yet_, and a sentence that everyone in the workspace can still open the project with their role.

### Panel 4 — the doors, in BOTH disclosure states

- **4a revealed (2+ workspaces).** The workspace rail gains **Roles & permissions** in its **Access**
  group, under Security, glyph `Shield` — the glyph the project rail gave the same room, so the two
  doors agree. Members stays on the Workspace index page. (The `NEW` marker is review chrome only.)
- **4b below the reveal (one workspace).** `/settings/workspace` 404s and its sections fold into
  `/settings/organization` (`organization-tier.md` §6d). Members folds in as today, with the role
  column. Roles folds in as a **door card** (_Roles & permissions_ · _3 built-in · 2 custom_ ·
  _Open roles →_), not the whole list: a list with a detail, an editor and a delete flow cannot fold
  into one section.
  **⚠️ This asks for ONE reveal carve-out, and it is the decision this design puts to its reviewer:**
  `/settings/workspace/roles` and every route beneath it answer at EVERY workspace count (below the reveal it renders inside
  the organisation rail, crumbs _Organization settings · Roles & permissions_), because the room has
  no other home and §6d forbids stranding it. The registry row is `revealedOnly` like its siblings —
  only the ROUTES are exempt from the 404.
- **4c the old project Roles URL.** Every `/settings/project/roles/**` route redirects to its
  workspace twin with `?from=project`, which draws a one-line `info-note` on `--el-tint-sky` with an
  `--el-info` edge: _Roles now live on the workspace — the same role in every project. You were sent
  here from the project's old Roles page._ The project rail loses its Roles row.

### Copy catalogue (new strings; everything else is shipped copy)

| key (proposed)                                  | en                                                                                                                                                                                      | zh                                                                                                                         |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `workspaceRole.manager` / `.member` / `.viewer` | Manager / Member / Viewer                                                                                                                                                               | 管理者 / 成员 / 查看者                                                                                                     |
| `workspaceRoleDesc.manager`                     | Everything in this workspace — its settings, members and every project.                                                                                                                 | 此工作区的一切——设置、成员及每个项目。                                                                                     |
| `workspaceRoleDesc.member`                      | Does the work in every project — edits items, comments, runs the planner.                                                                                                               | 在每个项目中推进工作——编辑工作项、评论、运行规划器。                                                                       |
| `workspaceRoleDesc.viewer`                      | Reads every project and its reports. Changes nothing.                                                                                                                                   | 查看每个项目及其报表，不做任何更改。                                                                                       |
| `members.roleColumn`                            | Workspace role                                                                                                                                                                          | 工作区角色                                                                                                                 |
| `members.onlyManager`                           | You're the only Manager. Make someone else a Manager before changing your own role.                                                                                                     | 你是唯一的管理者。请先将其他人设为管理者，再更改你自己的角色。                                                             |
| `members.lastManagerTitle` / `…Body`            | Couldn't change the role / A workspace needs at least one Manager. {name} is still a Manager.                                                                                           | 无法更改角色 / 工作区至少需要一名管理者。{name} 仍是管理者。                                                               |
| `members.roleChanged`                           | {name} is now a {role} in every project of {workspace}                                                                                                                                  | {name} 现在在 {workspace} 的每个项目中都是{role}                                                                           |
| `members.rolesManagerOnly`                      | Only a workspace Manager can change roles.                                                                                                                                              | 只有工作区管理者可以更改角色。                                                                                             |
| `migration.title` / `.managersOnly`             | Changed by the move to workspace roles / Managers only                                                                                                                                  | 因迁移到工作区角色而变更 / 仅管理者可见                                                                                    |
| `migration.body`                                | Roles now live on the workspace — one role per person, the same in every project. These people were not moved by the plain mapping. Check each one; change a role above if it is wrong. | 角色现在属于工作区——每人一个角色，在所有项目中相同。以下成员并非按常规映射迁移。请逐一核对；如有错误，请在上方更改其角色。 |
| `roles.rooms` / `roles.heldByNobody`            | Rooms / Held by nobody                                                                                                                                                                  | 空间 / 无人持有                                                                                                            |
| `roles.movedFromProject`                        | Roles now live on the workspace — the same role in every project. You were sent here from the project's old Roles page.                                                                 | 角色现在属于工作区——在所有项目中相同。你是从项目原来的角色页面跳转过来的。                                                 |
| `access.membersFromWorkspaceRole`               | People added to this project. What each can do comes from their workspace role — manage roles in workspace settings.                                                                    | 已添加到此项目的成员。每人能做什么取决于其工作区角色——请在工作区设置中管理角色。                                           |

**zh term:** Manager is **管理者**, deliberately not 管理员 — 管理员 is the org Admin's (and the retired
project admin's), and one user can be an org Admin and a workspace Manager at once.

### Allocation — element → the card that builds it

| Element                                                                                | Builds it  |
| -------------------------------------------------------------------------------------- | ---------- |
| Panel 1 role column, picker, locked / refusal / pending / error states, read-only view | MOTIR-6465 |
| Panel 1g–1h migration notice                                                           | MOTIR-6465 |
| Panel 4b Members fold-in (role column inside `WorkspaceFoldInSection`)                 | MOTIR-6465 |
| Panel 2 list / detail / editor / delete-with-reassign at the workspace                 | MOTIR-6466 |
| Panel 3 project Members without roles                                                  | MOTIR-6466 |
| Panel 4a rail row, 4b Roles door card + route carve-out, 4c redirects + note           | MOTIR-6466 |

### GIVES / TAKES — every `MOTIR-<n>` this asset names

- **MOTIR-6168** (the story) — GIVES the story's user-observable surfaces their design.
- **MOTIR-6465** — TAKES panels 1, 1g–1h and the Members half of 4b.
- **MOTIR-6466** — TAKES panels 2, 3, 4a, the Roles half of 4b, and 4c.
- **MOTIR-6463** — TAKES the refusal and error states of panel 1 as the contract its service must
  answer (last-Manager refusal; a failed change leaves the role unchanged).
- **MOTIR-6460** — TAKES panel 2's create-from-base (Manager · Member · Viewer) and delete-with-reassign.
- **MOTIR-6458** — GIVES panel 1g its rows (`role_migration_report`); panel 1g TAKES its reasons verbatim.
- **MOTIR-6464** — GIVES panel 4c its premise (project Roles routes stop serving); TAKES nothing drawn.
- **MOTIR-6328** — GIVES the three view-any keys panel 2 shows as the Rooms row.
- **MOTIR-2259 / MOTIR-2257 / MOTIR-4844 / MOTIR-2462** — amended or cited; unchanged as records.
- **MOTIR-6169** — the project access card in panel 3 is left exactly as shipped for it.
- **MOTIR-6317** — Invite / Remove are drawn as shipped; their gating is that bug's.

### Scope boundary

- **Out:** project access modes and the Limited scope (MOTIR-6169); who may remove a member
  (MOTIR-6317); inviting with a chosen role — invites keep creating a Member.

### Tokens & a11y

Colour is `--el-*` only; shape through `--radius-card/-input/-control/-badge/-btn/-modal`,
`--height-control/-btn-md`, `--spacing-card-padding/-control-x/-chip-*`, `--shadow-card/-elevated/-modal`.
Secondary ink is `--el-text-secondary` everywhere (never `--el-text-muted`). The role picker is the
shipped WAI-ARIA combobox + `listbox` with `aria-label` _Role for {name}_; disabled pickers carry
`aria-disabled`. Rooms chips carry their state as a word for assistive tech, not only as a glyph.
