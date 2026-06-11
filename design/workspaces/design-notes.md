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
  - "Invite teammates" entry: bare button with lucide `Mail` icon + label.

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
