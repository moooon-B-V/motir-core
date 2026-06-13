# CLAUDE.md

This file provides guidance to Claude Code and any other coding agent working
in this repository. It is auto-loaded as durable context for every Subtask
prompt dispatched against `motir-core`.

The architecture rules below are the project's load-bearing structural
contracts. They are not style preferences — every new endpoint, every new
DB-touching function, and every new test belongs in the layer this file
prescribes. When in doubt, find the closest existing example that follows
the rule and mirror it.

---

## ⚠️ 4-Layer Architecture — Route → Service → Repository → Prisma

**EXTREMELY IMPORTANT: Every endpoint that touches the database MUST flow
through four layers, top-to-bottom: Route → Service → Repository → Prisma.
Routes never call Prisma directly. Services never inline raw Prisma
operations. Repositories never contain business logic or transactions.**

### Layer responsibilities

1. **Repository** (`lib/repositories/*.ts`) — Data access. Each method is a
   **single Prisma operation** (find / create / update / delete / count /
   `$queryRaw`). No business logic. No transactions. No DTO mapping.
   - **Repository naming matches the primary entity, NOT the call site.**
     An operation on the `verification` table belongs in
     `verificationRepository`, even if the only caller is the invite-accept
     service. A `workspaceMembership.create` belongs in
     `workspaceMembershipRepository`, not in `workspacesService` and not in
     `workspaceRepository` (different entities).
   - **Write methods (`create`, `update`, `delete`, `deleteMany`, `upsert`)
     REQUIRE `tx: Prisma.TransactionClient` as a non-optional parameter.**
     This makes it a compile-time error to write outside a transaction.
   - **Read methods used only by read-only service paths** may use the `db`
     singleton directly (no `tx` parameter).
   - **Read methods used inside transactions** (i.e., reads that guard a
     subsequent write) take `tx: Prisma.TransactionClient` and use
     `SELECT FOR UPDATE` via `$queryRaw` when concurrent writes could race
     on the same row.

2. **Service** (`lib/services/*.ts`) — Business logic. Orchestrates
   repositories. Owns **all `prisma.$transaction(...)` calls**. Owns
   validation. Owns the JSON shape of what crosses the API boundary
   (DTOs). Throws typed errors (from `lib/<domain>/errors.ts`) that the
   route layer translates to HTTP status codes.
   - **One service method = one transaction.** Every write-flow wraps ALL
     its writes — plus any validation reads that gate those writes — in a
     single `prisma.$transaction(async (tx) => { ... })`.
   - **Returns DTOs, never raw Prisma models.** Mapper functions live in
     `lib/mappers/*.ts`; the service calls them just before returning.
   - **Reads of unrelated reference data** (e.g., looking up the
     workspace's name for an email body when the workspace is not being
     modified) do NOT need `tx`.

3. **Route handler** (`app/api/.../route.ts`) — HTTP layer. The only
   things a route does:
   - Parse the request (params, body, headers).
   - Read the session via `getSession()` from `@/lib/auth`.
   - Call ONE service method.
   - Map typed errors to status codes and return `NextResponse.json(...)`.
   - **No `db.*` calls. No `prisma.$transaction`. No business logic.** If
     you find yourself reaching for the Prisma client in a route file,
     stop — the missing piece is a service method.

4. **Prisma** — The ORM. Only repositories import it.

### Required file layout

```
app/api/<route-tree>/route.ts          ← HTTP only
lib/
  repositories/                        ← single-op DB access
    <entity>Repository.ts
  services/                            ← business logic + transactions
    <domain>Service.ts
  mappers/                             ← Prisma → DTO converters
    <domain>Mappers.ts
  dto/                                 ← DTO type definitions
    <domain>.ts
  <domain>/
    errors.ts                          ← typed error classes
  auth/                                ← Better-Auth wiring (special — see below)
  db.ts                                ← the Prisma singleton — ONLY repositories import this
  email.ts                             ← the email provider — ONLY services import this
```

### Example — adding an invite endpoint

```typescript
// lib/repositories/verificationRepository.ts ─────────── repo (single ops, write requires tx)
import { Prisma, type Verification } from '@prisma/client';
import { db } from '@/lib/db';

export const verificationRepository = {
  async findByIdentifier(identifier: string): Promise<Verification | null> {
    return db.verification.findFirst({ where: { identifier } });
  },
  async create(
    data: Prisma.VerificationCreateInput,
    tx: Prisma.TransactionClient,                       // required
  ): Promise<Verification> {
    return tx.verification.create({ data });
  },
  async deleteByIdentifier(
    identifier: string,
    tx: Prisma.TransactionClient,                       // required
  ): Promise<number> {
    const r = await tx.verification.deleteMany({ where: { identifier } });
    return r.count;
  },
};

// lib/mappers/inviteMappers.ts ─────────────────────── Prisma → DTO conversion
import type { Workspace, User } from '@prisma/client';
import type { ValidateInviteResultDTO } from '@/lib/dto/invites';

export function toValidateInviteResultDTO(
  workspace: Workspace,
  inviter: User | null,
  email: string,
): ValidateInviteResultDTO {
  return {
    workspaceName: workspace.name,
    inviterName: inviter?.name ?? 'A teammate',
    email,
  };
}

// lib/services/workspaceInvitesService.ts ─────────── business logic + transactions
import { db } from '@/lib/db';
import { verificationRepository } from '@/lib/repositories/verificationRepository';
import { workspaceMembershipRepository } from '@/lib/repositories/workspaceMembershipRepository';
// ...
export const workspaceInvitesService = {
  async accept(token: string, sessionUser: { id: string; email: string }) {
    const invite = await this.readInvite(token);
    if (!invite) throw new InviteExpiredOrMissingError();
    if (sessionUser.email.toLowerCase() !== invite.email) throw new InviteEmailMismatchError();
    return db.$transaction(async (tx) => {
      try {
        await workspaceMembershipRepository.create(
          { user: { connect: { id: sessionUser.id } }, ... },
          tx,                                            // tx threaded through
        );
      } catch (err) {
        if (!(err instanceof AlreadyMemberError)) throw err;
        // idempotent
      }
      await verificationRepository.deleteByIdentifier(INVITE_PREFIX + token, tx);
      return { workspaceId: invite.workspaceId };
    });
  },
};

// app/api/invites/[token]/accept/route.ts ───────────── HTTP only
import { getSession } from '@/lib/auth';
import { workspaceInvitesService } from '@/lib/services/workspaceInvitesService';

export async function POST(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });
  const { token } = await params;
  try {
    const result = await workspaceInvitesService.accept(token, session.user);
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof InviteExpiredOrMissingError) return NextResponse.json({ code: err.code }, { status: 404 });
    if (err instanceof InviteEmailMismatchError)    return NextResponse.json({ code: err.code }, { status: 403 });
    throw err;
  }
}
```

### Do / Don't

- ✅ Routes call exactly one service method per happy-path branch
- ✅ Repositories are objects with named methods (`export const fooRepository = { ... }`); each method is one Prisma call
- ✅ Services own `prisma.$transaction` and pass `tx` into every repo write
- ✅ Services map Prisma rows to DTOs via `lib/mappers/*` before returning
- ✅ Write repo methods require `tx`; reads called inside transactions require `tx`; pure read methods can use the `db` singleton
- ❌ `db.workspace.findUnique` in a route file — wrong layer
- ❌ `prisma.$transaction` in a route file — wrong layer
- ❌ A repository function that calls another repository function — repos are leaves; composition belongs in services
- ❌ A repository method with `tx?: Prisma.TransactionClient` (optional) on a write — must be required so TypeScript catches missing-tx bugs
- ❌ Service returning `Prisma.Workspace` / `Prisma.User` — must return a DTO
- ❌ Putting `workspaceMembership.create` in `workspaceRepository` because "the workspace is the parent" — entity name wins, it's `workspaceMembershipRepository`
- ❌ Inlining `db.verification.findFirst` in a service method — extract into the repo (single-op rule)

### Exceptions

- **`lib/auth/index.ts`** is Better-Auth's adapter wiring. Better-Auth
  expects a Prisma client directly via `prismaAdapter(db, ...)`. That's
  the framework boundary; do not refactor it into a service.
- **`lib/email.ts`** is the email-provider abstraction. Services import
  `sendEmail` directly (it's a leaf primitive, like the Prisma client is
  for repos).
- **Tests** may import repositories directly to assert DB state (e.g.,
  "the Verification row was deleted"). That's the only legitimate
  cross-layer reach.

---

## ⚠️ Email templates live in `lib/emailTemplates/`, NOT in service code

**EXTREMELY IMPORTANT: No service file, no route handler, and no
auth-wiring file may contain hand-written subject lines, HTML strings,
or plain-text bodies for outgoing emails. Every transactional email is
a typed render function in `lib/emailTemplates/`. Services compose the
inputs and dispatch; templates render.**

### Layer

```
lib/emailTemplates/
  _components/                   shared React Email building blocks
    EmailLayout.tsx              outer chrome (header, footer, sign-off)
    PrimaryButton.tsx            CTA button
  types.ts                       RenderedEmail = { subject, text, html }
  workspaceInvite.tsx            export async function workspaceInviteEmail(props): Promise<RenderedEmail>
  passwordReset.tsx              export async function passwordResetEmail(props): Promise<RenderedEmail>
  <other templates>.tsx          one .tsx per template
```

### Template contract

- Each template file exports an **async function** of the form
  `async function fooEmail(props: FooEmailProps): Promise<RenderedEmail>`.
- The function returns `{ subject, text, html }`. The service then
  spreads it into `sendEmail({ to, ...rendered })`.
- HTML is rendered from a React component via `@react-email/render`'s
  `render(<Email />)`.
- **Plain text is hand-written per template, not auto-derived.** This
  preserves the dev-console provider's "link unredacted in plain text"
  contract from Subtask 1.1.6 — auto-derivation strips the URL into
  inline-text form (`label (url)`), which makes greppable assertions
  more brittle.
- Templates are PURE: no `sendEmail` import, no `db` import, no
  `process.env` lookups, no token generation. All inputs come in as
  typed props. This makes them snapshot-testable in isolation and
  preview-renderable via `react-email dev` when we wire that up.
- Shared chrome (the "Motir" header, the "— Motir" sign-off, the
  CTA button) belongs in `_components/` so layout changes happen once.
- The template file ALSO has a default export of the underlying React
  component. That's required for the `react-email dev` preview server
  (when we add it later) — it discovers templates by default export.

### Example

```tsx
// lib/emailTemplates/workspaceInvite.tsx ─────── template (pure, no I/O)
import { render } from '@react-email/render';
import { EmailLayout } from './_components/EmailLayout';
import { PrimaryButton } from './_components/PrimaryButton';
import type { RenderedEmail } from './types';

export interface WorkspaceInviteEmailProps {
  inviterName: string;
  workspaceName: string;
  acceptUrl: string;
}

function WorkspaceInviteEmail(p: WorkspaceInviteEmailProps) {
  return (
    <EmailLayout preview={`${p.inviterName} invited you to join ${p.workspaceName}`}>
      <Text>Hi,</Text>
      <Text>{p.inviterName} invited you to join {p.workspaceName} on Motir.</Text>
      <PrimaryButton href={p.acceptUrl} label="Accept invite" />
    </EmailLayout>
  );
}

export async function workspaceInviteEmail(
  props: WorkspaceInviteEmailProps,
): Promise<RenderedEmail> {
  const html = await render(<WorkspaceInviteEmail {...props} />);
  return {
    subject: `You're invited to join ${props.workspaceName} on Motir`,
    text: buildPlainText(props),
    html,
  };
}

function buildPlainText(p: WorkspaceInviteEmailProps): string {
  return [...].join('\n'); // hand-written, link unredacted
}

export default WorkspaceInviteEmail;

// lib/services/workspaceInvitesService.ts ──────── service: compose + dispatch
import { workspaceInviteEmail } from '@/lib/emailTemplates/workspaceInvite';
import { sendEmail } from '@/lib/email';

async function dispatch(args: { inviterName: string; workspaceName: string; acceptUrl: string; to: string }) {
  const rendered = await workspaceInviteEmail({
    inviterName: args.inviterName,
    workspaceName: args.workspaceName,
    acceptUrl: args.acceptUrl,
  });
  await sendEmail({ to: args.to, ...rendered });
}
```

### Do / Don't

- ✅ Adding a new transactional email → new `lib/emailTemplates/<name>.tsx`
  exporting both the React component (default) and the `<name>Email()`
  render function (named)
- ✅ Reusing chrome → import `EmailLayout` / `PrimaryButton` from
  `_components/`
- ✅ Hand-writing the plain-text body in the template — keeps the
  `[EMAIL]`-line-grep contract intact for the dev-console provider
- ❌ A new email body composed via template literals inside a service
  or route file — extract to a template first
- ❌ Calling `sendEmail` from inside a template — templates are pure,
  the service dispatches
- ❌ Reading `process.env` or DB inside a template — pass everything in
  as props (e.g., the service builds `acceptUrl` from
  `BETTER_AUTH_URL` + token and hands the finished URL to the template)
- ❌ Putting auto-derived plain text (`{ plainText: true }`) into
  production — the dev-console contract requires the URL to appear
  verbatim, not as `label (url)`

### Why

Email bodies are content, not logic. They change for design reasons
(brand refresh, copy tweaks, locale support) while the dispatch flow
stays the same. Separating them means:

- Designers can edit templates without touching service code
- Snapshot tests catch unintended copy / markup drift
- Templates become previewable via `react-email dev` (planned for a
  future Subtask)
- The dispatch policy (rate limit, recipient resolution, BCC) stays
  centralized in services instead of sprinkling across N templates

### Why this matters

The 4-layer split exists for three reasons:

1. **Transactional correctness.** Required-`tx` on write methods means
   TypeScript prevents a route handler from accidentally writing two
   related rows without a transaction. Race conditions surface as type
   errors, not as data corruption a year later.
2. **Test surface area.** Services are pure-logic functions of (input,
   repo). They can be tested without spinning up routes. Routes become
   trivial transports that need only smoke tests.
3. **Refactoring safety.** Moving from Prisma to another ORM, swapping
   in a read replica, adding caching, or introducing RLS at the DB
   layer all become repository-only changes. Service contracts stay
   stable.

This rule was adopted at PR #25 (Subtask 1.2.5) after the same pattern
proved itself in the doooo codebase (`/Users/yuezhu/projects/doooo/CLAUDE.md`).

---

## ⚠️ Colour flows through `--el-*` element tokens, NEVER `--color-*` directly

**EXTREMELY IMPORTANT: A component references the Tier-3 `--el-*` element
tokens for every colour it renders. It MUST NOT reach for a Tier-0
`--color-*` token — neither the arbitrary form `text-(--color-slate)` nor
the Tailwind utilities auto-generated from `--color-*` (`text-foreground`,
`bg-surface`, `text-muted-foreground`, `border-border`, `bg-primary`, …),
all of which resolve straight to Tier 0 and bypass the swap layer.**

`app/globals.css` is layered (see its header comment):

- **Tier 0 — `--color-*`** raw palette values (`--color-foreground`,
  `--color-slate`, `--color-accent`, `--color-tint-*`, …). Light defaults
  in `@theme`; `[data-theme="dark"]` flips them.
- **Tier 3 — `--el-*`** the _semantic element tokens_ components consume.
  This is the single layer a future `data-palette="…"` overrides to
  re-skin the whole app without touching one component.

So in JSX, use arbitrary-value utilities pointing at `--el-*`:

```tsx
// ✅ right — routed through the swap layer
<p className="text-(--el-text-muted)">caption</p>
<div className="bg-(--el-surface) border-(--el-border)">…</div>
<Icon className="text-(--el-type-task)" />            // issue-type hue

// ❌ wrong — Tier-0 utilities / arbitrary --color-* bypass --el-*
<p className="text-muted-foreground">caption</p>
<div className="bg-surface border-border">…</div>
<span className="text-(--color-slate)">…</span>
```

### The token map (what to reach for)

| Need                                        | `--el-*` token                                                                     |
| ------------------------------------------- | ---------------------------------------------------------------------------------- |
| primary text / ink                          | `--el-text`                                                                        |
| emphasis, AA text on a tint                 | `--el-text-strong`                                                                 |
| secondary copy                              | `--el-text-secondary`                                                              |
| muted / caption                             | `--el-text-muted`                                                                  |
| tertiary / footer · faint label             | `--el-text-tertiary` · `--el-text-faint`                                           |
| text on an ink/accent fill                  | `--el-text-inverted`                                                               |
| CTA accent · its text · pressed             | `--el-accent` · `--el-accent-text` · `--el-accent-pressed`                         |
| brand-pink decorative highlight             | `--el-highlight`                                                                   |
| section surface · quieter · faint fill      | `--el-surface` · `--el-surface-soft` · `--el-muted`                                |
| border · soft · strong                      | `--el-border` · `--el-border-soft` · `--el-border-strong`                          |
| link · pressed                              | `--el-link` · `--el-link-pressed`                                                  |
| danger/success/warning/info (+ danger text) | `--el-danger` / `--el-success` / `--el-warning` / `--el-info` (`--el-danger-text`) |
| pastel tints                                | `--el-tint-{peach,rose,mint,lavender,sky,yellow}`                                  |
| **issue-type hue (by kind)**                | `--el-type-{epic,story,task,bug,subtask}`                                          |

### Rules

- ✅ **Reference `--el-*`.** Need a colour not exposed yet? ADD the `--el-*`
  token to globals.css Tier 3 (mapping it to the right `--color-*`) and
  consume that — the per-component growth pattern (notes.html mistake #20).
- ✅ **Use the palette's colour, not just grey + primary (finding #54).**
  Issue-type icons take their type's hue via `--el-type-*` (prefer the
  `IssueTypeIcon` component, which applies it); status/priority go through
  `Pill`'s tones; feature surfaces use the pastel tints. A screen that is
  _only_ grey + primary purple is the finding-#54 tell.
- ✅ **AA contrast holds** — colored chips put the hue in the tint
  BACKGROUND with `--el-text-strong` text (finding #35); never tint a
  page-level surface.
- ❌ `text-foreground` / `bg-surface` / `text-muted-foreground` /
  `border-border` / `bg-primary` and friends — Tier-0 utilities, forbidden
  in component code.
- ❌ `text-(--color-*)` / `bg-(--color-*)` arbitrary values — Tier-0,
  forbidden. (`--focus-ring-color` is a semantic `@theme` token, not a
  `--color-*`, so `ring-(--focus-ring-color)` is fine.)
- ❌ Only `globals.css` (the Tier-0→Tier-3 wiring) and the `/tokens`
  specimen route name `--color-*` directly.

This rule was adopted after finding #54 (the UI had collapsed to grey +
primary because almost every component referenced Tier 0 directly).

---

## ⚠️ Shape (radius + spacing + sizing) flows through element-semantic shape tokens

**EXTREMELY IMPORTANT: SHAPE is the second swappable axis (alongside COLOR).
A future `data-display-style="…"` — and ultimately a whole different getdesign.md
design system — must be able to re-shape the WHOLE UI the same way
`data-palette="…"` re-skins it. "Shape" is NOT just radius: it is radius +
component padding + control sizing + shadow. So every shaped surface a component
renders MUST reference an element-semantic shape token — the ones the
`[data-display-style]` block in `globals.css` overrides — NEVER the generic
Tier-0 scale (`--radius-xs/sm/md/lg/xl`, `--spacing-xs/sm/md/…`) and NEVER a
fixed raw utility (`rounded-md`, `p-1`, `px-2.5`, `h-9`, `shadow-md`). All of
those bypass the swap layer: flipping the display style leaves them unshaped.**

This is the exact analogue of the colour rule above. The generic Tier-0 scales
are inert (like Tier-0 `--color-*`); the element-semantic tokens are the swap
layer (like `--el-*`). Only `[data-display-style]` tokens flip.

### Radius — by surface

| Surface                                                                                    | token              |
| ------------------------------------------------------------------------------------------ | ------------------ |
| button                                                                                     | `--radius-btn`     |
| card · popover/dropdown container · callout box                                            | `--radius-card`    |
| input · textarea · combobox trigger · editor surface                                       | `--radius-input`   |
| modal / dialog panel                                                                       | `--radius-modal`   |
| badge / pill / status chip                                                                 | `--radius-badge`   |
| **small affordance** — menu/list row, icon & close button, tooltip, sidebar row, code chip | `--radius-control` |
| keyboard-hint chip (`<kbd>`)                                                               | `--radius-kbd`     |

### Padding · sizing · elevation — by surface

| Surface                                               | padding / size token(s)                                 |
| ----------------------------------------------------- | ------------------------------------------------------- |
| button                                                | `--spacing-btn-x/y` (`-sm`) · `--height-btn-{sm,md,lg}` |
| input · textarea                                      | `--spacing-input-x/y` · `--height-input`                |
| card                                                  | `--spacing-card-padding`                                |
| menu/list row · combobox trigger/search · sidebar row | `--spacing-control-x/y` · `--height-control`            |
| square icon / close button                            | `--spacing-icon-btn`                                    |
| badge / pill chip                                     | `--spacing-chip-x/y`                                    |
| `<kbd>` chip                                          | `--spacing-kbd-x/y`                                     |
| tooltip · inline code block                           | `--spacing-tooltip-x/y`                                 |
| shadow / elevation                                    | `--shadow-{subtle,card,elevated,modal}`                 |

### Rules

- ✅ **Reference an element-semantic shape token** for a surface's radius,
  its own padding, and its height/size. Need a role not exposed yet? ADD the
  token to `globals.css` `@theme` AND to the `[data-display-style='soft']`
  block (so it actually flips), then consume it — the same per-component growth
  pattern the colour rule uses.
- ✅ `rounded-full` is fine ONLY for genuinely circular things (spinner, avatar,
  colour swatch, status dot) — not display-style-dependent.
- ✅ Layout-only spacing — gaps between siblings (`gap-2`), one-off margins
  (`mb-1`), page gutters — may stay raw; it is not a surface's shape. Only a
  control's OWN box padding / radius / size is shape.
- ❌ `rounded-md` / `rounded-lg` / `rounded-xl`, or `rounded-(--radius-sm|xs)`
  and the rest of the generic radius scale (Tier-0, inert). A pill chip is
  `--radius-badge`, not `--radius-pill`.
- ❌ A fixed `p-1` / `px-2.5` / `h-9` for a control's own padding or height —
  use `--spacing-*` / `--height-*` so density flips too. A `shadow-md` on a
  surface — use `--shadow-*`.

This rule was adopted alongside the shape-swap work: components had collapsed
the SHAPE axis by reaching for the generic radius scale (`--radius-sm` ×11) +
raw `rounded-md` and fixed `p-1`/`px-2.5`/`h-9`, so `data-display-style` only
reshaped buttons/cards/inputs/modals and left menus, dialog-close buttons,
tooltips, badges, kbd, and sidebar rows fixed. The same token set + migration
lands in the upstream `nextjs-prisma-vercel-starter-with-design`, so a getdesign
swap can redefine the full shape language, not just colour.

---

## ⚠️ Design assets — THREE files per surface (notes + source + `.png`)

**EXTREMELY IMPORTANT: a design surface under `design/<area>/` is only complete
when ALL THREE files exist together — none is optional.** When you produce or
update a design asset (a `type: design` subtask, or any change to a mock), you
MUST land all three, with a shared basename:

1. **`design-notes.md`** — the spec: every primitive used, the exact copy, and
   the `--el-*` colour + `[data-display-style]` shape-token role for every
   element. (One per area; it indexes that area's surfaces.)
2. **The asset SOURCE** — a self-contained **`<surface>.mock.html`** built from
   the real design system (the `components/ui/*` primitives' markup + the
   `globals.css` `--el-*` / shape tokens — NEVER Tier-0 `--color-*` or raw
   `rounded-*`/`p-*`/`h-*`; the colour + shape token rules above apply to mocks
   exactly as to components). The HTML is the source of truth. (A legacy Pencil
   `.pen` source is also accepted, but new assets should be HTML mocks — no
   Pencil→code gap.)
3. **A `.png` EXPORT** — `<surface>.png`, beside the source (e.g.
   `triage.mock.html` → `triage.png`; a multi-panel mock exports ONE full-page
   PNG). **This is REQUIRED, not "if useful":** it is the board/tenant-visible
   face of the asset and what a reviewer skims on the PR without opening the
   HTML. Render it with Playwright chromium — full-page, light theme,
   `deviceScaleFactor: 2`, viewport width ~1200 — matching the existing
   `design/ready/ready.png` / `design/reports/charts.png` convention.

A design surface shipped with only notes + HTML (no `.png`), or HTML + PNG (no
notes), is **incomplete** — do not open the design PR / mark the subtask done
until all three are committed. (The `motir-meta` `MOTIR.md` design-reference rule
carries the same definition-of-done for the planner side.)

---

## Project conventions (non-architecture)

- **Manual merge mode.** Subtask PRs open as drafts targeting `main`; the
  planner reviews and merges. Do not auto-merge.
- **Tests use a real Postgres**, never mocks. `tests/helpers/db.ts`
  truncates between tests; the dev DB at `localhost:5433` is reset on
  each `beforeEach`. The single `vi.mock` allowed is for
  `getSession()` from `@/lib/auth`, since the test environment has no
  cookies — every other DB / external call goes through the real path.
- **Conventional Commits** for commit messages. Type prefixes used so far:
  `feat`, `fix`, `chore`. Scope is the affected area (e.g.
  `feat(workspaces): ...`).
- **Migrations — every foreign key MUST be modelled as a Prisma `@relation`,
  never hand-managed in raw migration SQL alone.** A column whose FK is created
  in raw SQL (e.g. `ADD CONSTRAINT ... FOREIGN KEY`) but left as a plain scalar
  in `schema.prisma` (no `@relation`) puts the schema graph and the
  migration-built DB in permanent drift: **every `prisma migrate dev` then
  re-proposes `DROP CONSTRAINT` for that FK** at the top of the next migration,
  and committing it verbatim silently drops a real FK. So if you want the
  referential guarantee, model the relation on BOTH sides (forward field +
  back-relation) with the same `onDelete`/`onUpdate` actions the SQL used; if
  you don't want it, drop the FK from the DB too — never split the two. (Fixed
  by `bug-attachment-fk-migration-drift`: the `attachment.uploader_user_id` FK
  from 2.3.7 was raw-SQL-only; it is now modelled as `Attachment.uploader` ↔
  `User.uploadedAttachments`, so `migrate dev` reports "No difference detected"
  with no spurious drop.)
- **Out-of-scope findings** go to
  `/Users/yuezhu/projects/prodect/prodect_plan/PRODECT_FINDINGS.md`,
  not into a CLAUDE.md or MOTIR.md update. The planner promotes
  findings into future Subtasks during replan passes.
- **A failed test (or a surfaced bug) is DEBUGGED before it is re-run — never
  rerun-first on the assumption it is flaky.** Read the actual failure (the
  assertion / locator / stack, not just the summary) and find the root cause
  FIRST. A real failure that gets masked by a green re-run is worse than a red
  one. Then split on cause:
  - **Caused by the change you're making this session** → it is a real
    regression: FIX it in the same PR (it's part of completing the change). A
    contract change (e.g. an API/route/UI-interaction that every caller must
    now adopt) means EVERY consumer — app code AND every test that drives it —
    must be updated; grep the whole repo for the surface and fix them all, don't
    stop at the first failing file. (Example: 6.9.2 made the link picker
    query-driven; `issue-detail-flow` was updated but `activity.spec` was not,
    so its option-click timed out at 120s — a real bug the first pass missed.)
  - **A pre-existing bug in already-shipped code** (the failure reproduces on
    `main` without your change) → do NOT absorb it into the current PR and do
    NOT just rerun past it: log it as a **bug work item** in the plan seed (the
    bug-logging `seed/*` PR with the `[reseed]` marker) so it's tracked, and
    surface it in the PR body — the same protocol as an out-of-scope finding.
  - **Genuinely flaky** (non-deterministic, root cause understood and unrelated
    to your change) → only THEN is a re-run appropriate; say so explicitly with
    the evidence, don't let "probably flaky" be the default.
