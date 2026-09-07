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
   - **⚠️ A read that ACCEPTS an optional `tx` falls back to `dbRead`, never to
     `db`** — `const client = tx ?? dbRead;`. Both names are the same object,
     exported from `@/lib/db`; `dbRead` is it under `Prisma.TransactionClient`.
     Writing `tx ?? db` makes the local a UNION of two whole Prisma clients, and
     every later `client.<model>.findMany({ … })` then resolves against both
     constituents of a 105-model generated client. **Measured with
     `--generateTrace` (MOTIR-4295): one such method cost 9.6 s of check time
     against 36 ms for the same method reading `tx` alone.** Across the app
     project the sweep took `Instantiations` from **9,210,038 to 2,129,376**
     (−77%) and the type-check's peak memory from 2.72 GB to 2.24 GB.
     Annotating the local (`const client: Prisma.TransactionClient = tx ?? db`)
     does NOT help — it measured 10.6 s; the union has to go, not be re-labelled.
     **⚠️ And the cost MOVES rather than repeating**: it lands on whichever file
     the checker reaches first, so a profile's top entry is a symptom of ORDER,
     not of that file being pathological — fixing one file just promotes the
     next. `db` stays correct for a read that takes no `tx` at all, and is
     REQUIRED for anything opening a transaction (`dbRead` carries no
     `$transaction`, which is what makes the rule enforceable by the type
     checker). `tests/rls/`'s scanners read both names, and their fixtures pin
     that in both directions.

   - **⚠️ The generated client's PROJECTION types are named ONLY in this layer**
     (`Prisma.<Model>CreateInput` / `UpdateInput` / `GetPayload` / `Select` /
     `Include` / `WhereInput` / `…Args`). A repository that takes one in a
     signature EXPORTS it under its own name — `WorkItemUpdateInput`,
     `PlanItemCreateInput` — and callers above build their payload against
     THAT. The layering rule already says a service does not QUERY; this is the
     same boundary for the TYPES, and it is what lets a repository narrow its
     input later (to a `Pick`, to a real DTO) without touching a caller.
     **Model types and enums are free** (`import type { WorkItem, WorkItemKind }`
     — 333 files use them), and so is `Prisma.TransactionClient`; both are
     pinned as innocent by the guard. Enforced at zero over `lib/`, `app/` and
     `components/` by `tests/prisma/typeBoundary.test.ts` (MOTIR-4296), which
     names the file, the line and the tell.

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
  as props (e.g., the service builds `acceptUrl` from the app-origin accessor
  `resolveBaseUrlTrimmed()` (`lib/baseUrl.ts`, backed by `MOTIR_BASE_URL`) plus
  the token, and hands the finished URL to the template)
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

| Need                                    | `--el-*` token                                                |
| --------------------------------------- | ------------------------------------------------------------- |
| primary text / ink                      | `--el-text`                                                   |
| emphasis, AA text on a tint             | `--el-text-strong`                                            |
| secondary copy                          | `--el-text-secondary`                                         |
| muted / caption                         | `--el-text-muted`                                             |
| tertiary / footer · faint label         | `--el-text-tertiary` · `--el-text-faint` (⚠️ see below)       |
| text on an ink/accent fill              | `--el-text-inverted`                                          |
| CTA accent FILL · its text · pressed    | `--el-accent` · `--el-accent-text` · `--el-accent-pressed`    |
| accent AS text / icon on a page surface | `--el-accent-on-surface`                                      |
| brand-pink decorative highlight         | `--el-highlight`                                              |
| section surface · quieter · faint fill  | `--el-surface` · `--el-surface-soft` · `--el-muted`           |
| border · soft · strong                  | `--el-border` · `--el-border-soft` · `--el-border-strong`     |
| link · pressed                          | `--el-link` · `--el-link-pressed`                             |
| danger/success/warning/info FILL        | `--el-danger` / `--el-success` / `--el-warning` / `--el-info` |
| ink ON a danger fill ⚠️ nothing else    | `--el-danger-text` (see the danger rule below)                |
| danger AS text / icon on a page surface | `--el-danger-on-surface`                                      |
| pastel tints                            | `--el-tint-{peach,rose,mint,lavender,sky,yellow}`             |
| **issue-type hue (by kind)**            | `--el-type-{epic,story,task,bug,subtask}`                     |

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
- ⚠️ **CONTRAST IS A PROPERTY OF THE PAIR, NOT OF THE INK — and two grey
  tokens are traps (MOTIR-2455).** Measured with axe on a real route, light
  theme (the binding one; every ink clears AA on every dark surface):

  | ink                   | page / card `#ffffff` | `--el-surface` | `--el-muted` | `--el-surface-soft` |
  | --------------------- | --------------------- | -------------- | ------------ | ------------------- |
  | `--el-text-faint`     | 2.61 ✗                | 2.39 ✗         | 2.37 ✗       | 2.50 ✗              |
  | `--el-text-muted`     | **4.54 ✓**            | 4.17 ✗         | 4.12 ✗       | 4.34 ✗              |
  | `--el-text-secondary` | 6.80 ✓                | 6.24 ✓         | 6.18 ✓       | 6.51 ✓              |

  So: **`--el-text-faint` NEVER carries text WCAG measures** — it is for
  decorative glyphs (`aria-hidden`, or a `role="img"` whose label carries the
  meaning) and for **disabled / inactive** text, which 1.4.3 exempts. And
  **`--el-text-muted` is safe only on the white page/card**, with 0.04 of
  headroom — put a muted caption on `--el-surface` / `--el-muted` /
  `--el-surface-soft` and it fails. When in doubt reach for
  `--el-text-secondary`, which clears AA everywhere in both themes. A design
  mock is NOT authority here: the roles asset specified faint on surface and
  had to be corrected.

- ⚠️ **`--el-danger-text` IS NOT A DANGER TEXT TOKEN. It is the ink FOR a
  danger FILL, and it is legal ONLY on an element that also carries
  `bg-(--el-danger)` (MOTIR-3663).** It resolves to
  `--color-destructive-foreground`, which every palette defines as whatever
  contrasts with its red fill — white, or in a dark-first palette a near-black.
  Painted on a page instead, measured across all ten palettes:

  | theme | what it does                                                                                                                                                                                                         |
  | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | light | **1.00–1.04:1 in ALL TEN palettes** — the ink and the page are the same white                                                                                                                                        |
  | dark  | **1.00:1 in six** (amber · candy · citrine · evergreen · garnet · sienna)                                                                                                                                            |
  | dark  | 18.59–19.44:1 in the other four (base · cobalt · graphite · spectrum) — legible, and still the bug: it renders near-white, indistinguishable from `--el-text`, so the **danger SIGNAL is lost rather than the text** |

  On the `--el-danger-surface` tint it is 1.14–1.29:1 in all twenty. Its one
  correct use in the whole tree is `Button`'s danger variant,
  `bg-(--el-danger) text-(--el-danger-text)`.

- ✅ **Danger text on a surface takes `--el-danger-on-surface`** —
  `color-mix(in srgb, var(--el-danger) 70%, var(--el-text))`, the palette's own
  danger hue pulled toward that theme's body ink until it is readable. It is
  **≥ 4.77:1 on the page, `--el-surface`, `--el-surface-soft`, `--el-muted`,
  `--el-tint-rose` and `--el-danger-surface`, in all 20 palette × theme
  combinations**, so it is right whichever surface the element lands on — the
  same property that makes `--el-text-secondary` the answer on the grey inks.
  **Raw `--el-danger` is NOT that token**: it is 4.25 / 4.11 / 4.24:1 on the
  DARK page in the base, cobalt and graphite palettes, and under AA on most
  tints. For a big label or a glyph beside one, putting the hue in the
  **border + glyph** and keeping the label on `--el-text` is still the better
  composition (graphics need only 3:1) — `DeviceApproval` is the worked example.

  Both rules are enforced, at zero, over `components/**`, `app/**`, `lib/**`,
  the design system's `src/**` (`tests/theme/inkContrastLint.test.ts`'s danger
  arm) **and over `design/**`** (`tests/design-ink-contrast.test.ts`). The
design-side arm matters most: MOTIR-1553's root cause was a MOCK that
specified `--el-danger-text`for a row-menu Delete, which was then copied into
two components and shipped invisible. **Unlike the two grey arms, the danger
arm grants no`aria-hidden` / disabled exemption\*\* — 1.4.3 not measuring a
  hidden glyph does not make a white-on-white one visible.

- ❌ `text-foreground` / `bg-surface` / `text-muted-foreground` /
  `border-border` / `bg-primary` and friends — Tier-0 utilities, forbidden
  in component code.
- ❌ `text-(--color-*)` / `bg-(--color-*)` arbitrary values — Tier-0,
  forbidden. (`--focus-ring-color` is a semantic `@theme` token, not a
  `--color-*`, so `ring-(--focus-ring-color)` is fine.)
- ❌ Only `globals.css` (the Tier-0→Tier-3 wiring) and the `/tokens`
  specimen route name `--color-*` directly.
- ❌ **NEVER INVENT A COLOUR.** Do not write a raw hex hue (`#3b82c4`,
  `bg-[#dcecfa]`), an `rgb()/hsl()` literal, a named CSS colour, or a
  `color-mix()` over a **raw hue** for any element's colour — in component
  code **OR in a design mock**. Every colour MUST come from an existing
  palette token (`--el-*`, including the `--el-tint-*` set; or a `color-mix`
  whose inputs are ALL `--el-*`/`--color-*` tokens). If the palette has no
  colour that fits, ADD an `--el-*` token to `globals.css` Tier 3 (mapped to
  a `--color-*`) and consume THAT — never hardcode the hue inline. **Why it
  matters:** a palette token flips with `data-palette` and is kept mutually
  distinct from its siblings by the palette author; an invented hue does
  neither — it won't swap, and it can collide with a token under another
  palette. (When you need a card/state colour "clearly different" from
  another, reach for a _different tint slot_ — e.g. `--el-tint-sky` vs
  `--el-tint-mint` — not a new hex.) The ONLY raw values allowed in a mock
  are NON-semantic decoration that never carries meaning (the canvas
  grid-dot texture, the body backdrop) — never a card/pill/state fill,
  border, or text colour. (Yue, 2026-06-27: a done-card mock used invented
  `#3b82c4`/`#d98a3d` border hues — wrong; the fill must be a `--el-tint-*`.)

This rule was adopted after finding #54 (the UI had collapsed to grey +
primary because almost every component referenced Tier 0 directly).

---

## ⚠️ Shape (radius + spacing + sizing) flows through element-semantic shape tokens

**EXTREMELY IMPORTANT: SHAPE/FEEL is the second swappable axis (alongside COLOR).
The `data-style="…"` named-style axis (registry in `lib/theme/styles.ts`) — and
ultimately a whole different getdesign.md design system — must be able to
re-shape the WHOLE UI the same way `data-palette="…"` re-skins it. "Shape" is NOT
just radius: it is radius + component padding + control sizing + shadow. So every
shaped surface a component renders MUST reference an element-semantic shape token
— the ones a `[data-style]` block in `globals.css` overrides — NEVER the generic
Tier-0 scale (`--radius-xs/sm/md/lg/xl`, `--spacing-xs/sm/md/…`) and NEVER a
fixed raw utility (`rounded-md`, `p-1`, `px-2.5`, `h-9`, `shadow-md`). All of
those bypass the swap layer: flipping the style leaves them unshaped.**

This is the exact analogue of the colour rule above. The generic Tier-0 scales
are inert (like Tier-0 `--color-*`); the element-semantic tokens are the swap
layer (like `--el-*`). Only `[data-style]` tokens flip. A `[data-style]` TOKEN
block overrides ONLY shape/feel tokens, never a colour token — colour is the
independent `data-palette` axis.

**Surface-MATERIAL styles — the one sanctioned exception (glassmorphism, 7.3.35;
later cybercore / aurora / neumorphism).** Some styles own the SURFACE itself —
translucency, a gradient canvas, frosted backdrop-blur, light borders — which
the shape-only token block cannot express. They add a **palette-DERIVED material
layer**: style-scoped component rules
`[data-style='id'] [data-surface='…'] { … }` (NOT the bare token block) whose
colour comes ONLY from `color-mix()` / `var(--color-*|--el-*)` over the ACTIVE
palette — **never a raw hex hue**. That keeps the axes disjoint (a palette swap
re-tints the material; a style swap leaves hues untouched). Surfaces opt in via a
`data-surface` attribute on the shared primitive (`Card`/`Modal`/`Popover`/
`Sidebar`/`Input` emit it). Two invariants hold and are enforced by
`tests/theme/styleRegistry.test.ts`: (1) the bare `[data-style] { … }` token
block still carries NO `--color-*`/`--el-*`; (2) a material rule must be
palette-derived (a `var(--color|--el-…)` reference, no hex literal). Do NOT
"fix" a `data-surface` material rule by deleting its `color-mix` — it is the
blessed mechanism, not a colour-rule violation. See `docs/styles/glassmorphism.md`.

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
  token to `globals.css` `@theme` AND to the `[data-style='soft-playful']`
  block (so it actually flips), then consume it — the same per-component growth
  pattern the colour rule uses.
- ✅ `rounded-full` is fine ONLY for genuinely circular things (spinner, avatar,
  colour swatch, status dot) — not style-dependent.
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
raw `rounded-md` and fixed `p-1`/`px-2.5`/`h-9`, so the style swap only
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
   the `--el-*` colour + `[data-style]` shape-token role for every
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
until all three are committed. (The `motir-meta` `MOTIR.md` design-reference
rule carries the same definition-of-done for the planner side.)

**How the `.png` reaches the board — YOU publish it.** The "tenant-visible face"
above is not a wish and it is not automatic: once the three files are committed,
**call the `publish_design_result` MCP tool** with the card's key, the
`*.mock.html` as `mock`, the `.png` as `image`, the note file as `note_file`, and
`noteMd` carrying the `##` SECTIONS this work wrote — never a whole area note.
The item page then renders them in its **Design result** panel. Two things
follow, and the second is the one that bites:

- **You still commit all three files.** The published result is the card's VIEW
  of the asset; the repository stays the source of truth.
- **⚠️ NOTHING ELSE MAKES THAT CALL, AND A MISSING PUBLISH LOOKS EXACTLY LIKE A
  SUCCESSFUL RUN.** There is no CI step, no check and no background job behind
  it. A design card that writes its files, lands its commit, pushes and opens a
  green pull request — and never calls the tool — is indistinguishable from one
  that finished, except for an empty panel on a surface the run never opens. So
  **confirm the result arrived** before calling a design card done: the
  confirmation is the **evidence `id` the call returns**, and putting it on the
  card is what makes it checkable by somebody else. No call ⇒ nothing was
  published, whatever the pull request says.

> ⚠️ **This warning is OLDER than the tool, and it is kept because the hazard
> outlived the mechanism.** It was written when CI did the publishing: the
> publish step shared a job with the guards and ran after them, so a failing
> guard skipped it silently, and the script also exited 0 on a fork (no
> credential) or a branch whose name yielded no work-item key. That publisher is
> retired in every repository (MOTIR-3797) and none of those causes exists any
> more. The SHAPE is identical and now has one cause instead of three — a call
> nobody made — which is a fair trade only because a forgotten call costs one
> card its result, while an absent publisher cost every card in a repository
> every result, silently, for as long as nobody looked
> (`docs/decisions/design-result.md` AMENDMENT 2 Q2).

**Which card it publishes to is the key you PASS.** Nothing is inferred from a
branch, a title or a diff. The server refuses the two mistakes it can see: a
CONTAINER target (a design result belongs to the leaf that produced it), and a
key that is not a child of a declared `withinParentKey`.

**A design asset does NOT go through the general attachment door.** `attach_file`
and `POST /api/v1/work-items/{key}/attachments` exist for a deliverable that has
no lifecycle of its own — a research findings document, a review's notes. A
design result has its own publisher (`publish_design_result`) and its own panel,
and `text/html` is refused by the general door anyway, so routing one through it
would split the three-file set across two surfaces
(`docs/decisions/attachment-api-door.md` §3). If you are publishing from
something that is not an MCP client, the `design-evidence` HTTP routes are still
the supported door (`docs/decisions/design-result.md` AMENDMENT 2 Q1).

**Re-export the `.png` with `node scripts/render-design-mock.mjs <mock.html>`,
AFTER `prettier --write` on the mock.** It recovers the viewport width from the
committed export, renders the asset as it stands at `HEAD` first, and tells you
whether what changed in the PNG is your diff or the render environment
(`EXACT` / `DIMS` / `DRIFT`, the last carrying its `Δbaseline=`). A new asset
with no committed export takes `--width` (~1200 is the tree's convention).

**⚠️ A fourth verdict, `REFLOW`, is a REFUSAL — nothing is written (MOTIR-4374).**
The viewport is SEARCHED, and a width match does not identify one: at
`deviceScaleFactor: 2` the search probes half the committed width and the scale
factor doubles the output back to it, so a 1×-exported asset has a second,
document-REFLOWING candidate that passes the width test. It used to keep the
first match it found and prefer 2×, which re-exported
`design/ai-chat/target-picker.png` (1200×2932) at **1200×8206** under an ordinary
`DRIFT` — a plausible image, three times too tall, of a design nobody drew. It
now takes the HEIGHT-NEAREST candidate, and reports `REFLOW` instead of writing
when even that one is more than 25% from the committed height. If the delta is
genuinely real, re-run with `--width <the viewport it was exported at>`.

**⚠️ The ink rules apply to a mock's OWN `<style>` block and its board chrome,
not only to its utility classes.** `--el-text-muted` fails AA on `--el-surface` /
`--el-surface-soft` / `--el-muted` (4.12–4.34:1), and that is true of a
`.panelNote { color: var(--el-text-muted) }` rule and a panel caption exactly as
it is of `text-(--el-text-muted)` on a row — a design board's annotations owe AA
too (`docs/decisions/design-board-chrome-aa.md`). Reach for
`--el-text-secondary`, which is 6.18–6.80:1 on all four surfaces in both themes
and so is right whichever surface the element lands on. **The same holds for
`--el-text-faint`, which is 2.37–2.61:1 and clears AA on NO surface** — it is for
decorative glyphs and disabled text only, and saying so on the element
(`aria-hidden`, a labelled `role="img"`, `disabled`) is what makes it legitimate.
`tests/design-ink-contrast.test.ts` enforces BOTH inks at zero over the whole
tree, over both layers a mock paints in, and it resolves descendant / child /
compound selectors as well as bare ones (MOTIR-3122) — a rule nested two levels
deep is as visible to it as a top-level class.

**⚠️ That arm rules on the RESTING state ONLY, and its green is not a claim about
a hovered row (MOTIR-4255).** Its scanner abstains, deliberately and correctly,
on every selector carrying a pseudo-class: a static walk cannot know whether a
state obtains, so it may neither clear an ink on one nor claim a tint from one.
The consequence is that `.lt-row:hover { background: var(--el-surface) }` with a
`--el-text-muted` key inside it was invisible to a guard enforced at ZERO — 216
such elements across 22 assets. **`tests/design-state-ink-contrast.test.ts` is
the arm that measures them**: it renders each mock in happy-dom and resolves the
state surface from the TREE rather than from the selector text. So when you
write a `:hover` / `:focus` / `:active` tint into a mock, the ink inside it is
ruled on — reach for `--el-text-secondary`, or `--el-text-identifier` for a
monospace item key, and note that most mocks must DECLARE the latter in their own
token block (it is newer than they are).

---

## ⚠️ E2E tests wait on the AUTHORITATIVE signal — never race optimistic / async UI

**EXTREMELY IMPORTANT: a Playwright assertion against an OPTIMISTIC or
eventually-consistent surface MUST wait on a deterministic completion signal
before the next step — the network response (its status AND body), an
authoritative committed-state read, or a real component state. NEVER assert,
`reload()`, or act on the optimistic UI alone and lean on Playwright's implicit
assertion auto-retry to "catch up." Auto-retry masks the race locally and on a
fast runner; it fails under CI load — exactly where it is least debuggable.**

A flaky spec is not a private cost: PR CI checks out the branch **merged with
`main`**, so one flaky spec on `main` red-lights _every_ open PR's CI
intermittently. Treat a flaky test as a release blocker, never merge one that's
"green most of the time," and when a PR's only red is a spec it didn't touch,
suspect an inherited `main` flake before blaming the diff (reproduce in
isolation first). This rule was adopted after five specs flaked from the same
shape (`bug-e2e-suite-flaky-specs`; the lesson is `notes.html` mistake #37).

**⚠️ BEFORE YOU DECIDE A `click → expect` PAIR IS RACING, LOOK IT UP —
`docs/e2e/mutation-assert-sweep.md` (MOTIR-4399).** The whole suite has been
swept for this shape and every site dispositioned, so a red check's _"is this my
diff, or is it this?"_ is a table lookup rather than a re-derivation. It also
carries the finding a sweep needs before it starts arming waits: **most
`click → expect` pairs in this suite are NOT racing**, because the asserted node
is rendered from the write's own response — a toast, a returned DTO applied in
place, a `revalidatePath` payload — so the assertion IS the wait and arming one
in front of it buys nothing. The helpers are
`tests/e2e/_helpers/authoritative-signal.ts`.

**And when the surface repaints only on a whole-page `router.refresh()`, ask
which remedy before writing either one:** if the asserted value could have been
computed in the browser from the write's own result, the SURFACE owes an
in-place update (the page-state contract's case 3 below) and amending the spec
retires the only detector that defect has — MOTIR-4496. If the value is
server-derived, the SPEC owes a wait on the refresh — MOTIR-3694.

### The discipline, by operation

- **After a mutation** (a `POST`/`PATCH` write), `await page.waitForResponse(…)`
  for that endpoint's **200** before `reload()` or before asserting the
  persisted value. The optimistic UI flips instantly; the reload reads the
  server, so without the wait the reload races the in-flight write and reads the
  PRE-write state. (Arm the `waitForResponse` BEFORE the action so it can't be
  missed.)
- **After a lazy-load** ("Show more" / pagination / a windowed fetch), `await`
  the fetch response before asserting the new count/rows — never `toHaveCount`
  straight after the click.
- **For a drag (dnd-kit)**, assert the **committed** action — the move
  response's body (right column/slot) or an authoritative reload — and RETRY the
  gesture until it commits; never trust the drop's apparent target.
  `closestCorners` can resolve `over` to a stale element at release, so the move
  POSTs the wrong target → a rejected (422) move. A rejected move changes
  nothing server-side, so re-dragging is safe.
- **Fixed `waitForTimeout` is a smell** — it's a guess, not a signal. Wait on
  the response, a DOM/role state, or `expect.poll` of an authoritative read.
- **One altitude down, in a Vitest + RTL COMPONENT test, the act environment
  now enforces this for you.** `tests/helpers/actEnvironment.ts` (a setupFile,
  self-scoped to the happy-dom files) sets `IS_REACT_ACT_ENVIRONMENT = true`, so
  React flushes passive effects SYNCHRONOUSLY at the end of every act scope —
  and RTL wraps `render` and each `fireEvent` / `userEvent` in one. An assertion
  after an awaited interaction therefore sees the effects that interaction
  queued; the "the render landed, the effect did not" race cannot form.
  (MOTIR-1736 / MOTIR-1737 were three instances of it; MOTIR-1738 removed the
  class.) What the flag asks of you in return: **a state update that lands
  outside an act scope now logs a "not wrapped in act(...)" warning, and that
  warning is a REAL finding** — the test asserted against a render the component
  had not finished. The three shapes that produce one, and their fixes:
  - **An async action / fetch resolving after the last assertion** → `await act(async () => {})`
    to flush it, or await the authoritative signal it produces (`findBy*`).
  - **A raw `dispatchEvent`, or `vi.advanceTimersByTime`** — neither is
    act-wrapped the way `fireEvent` is → wrap the call in `act(() => { … })`.
  - **A bare `await Promise.resolve()` / `await new Promise(r => setTimeout(r, 0))`
    used to yield** → replace it with `await act(async () => { … })`, which
    yields AND wraps the resulting updates.

  Never "fix" one by sleeping. An **event-handler** callback is invoked
  synchronously inside the dispatched handler, so it needs no wait.

### The app side (so tests CAN be deterministic)

- **Optimistic mutations must sequence-guard their reconciles.** Rapid or
  overlapping actions (a shortcut pressed repeatedly, a composite click firing
  while a prior action is in flight) resolve out of order; an older response's
  state update must not clobber the newest optimistic state. Stamp each action
  with an incrementing `seq` ref and apply a reconcile only when it's still the
  latest (the `WatchControl` toggle mirrors the `fetchSeq` guard the same
  component already used for stale list reads).
- **Concurrency paths translate raw DB races to typed errors.** A `$transaction`
  that can lose a unique-constraint race must catch the `P2002` and rethrow a
  typed domain error (e.g. `changeKey` → `IdentifierTakenError`) so a raw DB
  error never escapes the service — and a concurrency TEST must accept every
  legitimate race outcome, not a single one.

### Do / Don't

- ✅ `const w = page.waitForResponse(r => /…\/rank$/.test(r.url()) && r.request().method()==='POST'); await drag(); expect((await w).status()).toBe(200); await page.reload();`
- ✅ Verify a dnd move via its response body / a post-reload authoritative read; retry until committed.
- ✅ Guard optimistic reconciles with a `seq` ref; translate `P2002` to a typed error.
- ❌ `await action(); await page.reload(); expect(persisted).to…` with no response wait.
- ❌ `await showMore.click(); await expect(list).toHaveCount(100);` (races the fetch).
- ❌ `await page.waitForTimeout(500)` as a synchronisation mechanism.
- ❌ Merging a spec that passes only intermittently — it taxes every open PR via merge-with-main CI.

### The act environment is ON for component tests (MOTIR-1738)

The component-test half of this rule is **structurally prevented**, not merely
detected. `tests/helpers/actEnvironment.ts` — a `setupFiles` entry in
`vitest.config.ts`, self-scoped to the happy-dom files via a `window` guard —
sets `IS_REACT_ACT_ENVIRONMENT = true`, so React flushes passive effects
synchronously at the end of every act scope, and RTL opens one around `render`
and each `fireEvent` / `userEvent`. The "assertion resolved before the effect
landed" race has no window left to form in.

- **Nothing extra to run.** It is wired into the default `vitest.config.ts`, so
  the ordinary `pnpm test` (and PR CI) carries it. There is no separate lane and
  no nightly job. (It REPLACED the `pnpm test:late-effects` audit lane, which
  detected this class rather than removing it — that lane, its config, its shim,
  and its nightly workflow were retired with this change.)
- **A "not wrapped in act(...)" warning is a REAL finding**, never noise and
  never a reason to sleep: the test asserted against a render the component had
  not finished. The three shapes that produce one — and their fixes — are listed
  in the component bullet above.
- **Cost of the migration, for calibration:** turning the flag on failed ZERO of
  the 174 happy-dom files and produced 81 warnings across 15 of them, each fixed
  by awaiting the right signal. It is far cheaper than the class it retires.

### An `acceptance-*.spec.ts` is a RECEIPT, and it has a lifecycle (MOTIR-2765)

**A spec in `tests/e2e/acceptance*.spec.ts` is not a regression test, and the two
must not be reasoned about the same way.** It exists to record ONE watchable run
of a story working, which a human then approves. The full rule is
`docs/decisions/acceptance-receipt-lifecycle.md`; what you need at the keyboard:

- **The spec is a TEST; the video is a TEST EXECUTION.** Their lifetimes are
  independent. Deleting the spec does not touch the receipt it produced.
- **Once the story's receipt is `approved` it is FROZEN** — a republish is
  refused, not superseded — and **the spec must LEAVE the acceptance lane**, by
  exactly one of two routes: **PROMOTE** it into a lane that runs on every PR
  (keep every assertion; strip `chapter()` / `beat()` / `acceptanceStory()` and
  the pacing holds), or **RETIRE** it, naming where the flow stays covered. There
  is no third route.
- **⚠️ When an acceptance spec goes red on a PR that did not change its story,
  do NOT update the assertion to match today.** That is the one reflex this rule
  exists to stop: it is right for a regression test and backwards for a receipt,
  because it edits history to agree with the present (motir-core#2051 is the
  instance — a spec for a story accepted months earlier went red because a later
  story legitimately moved the sign-in landing). The right move is a disposition.
- **⚠️ The destination is NOT automatically the main lane.** The acceptance lane's
  server is CLOUD-ON with the motir-ai, code-health and GitHub-provisioning mocks;
  `playwright.config.ts`'s is none of those. Promote a gated spec into the main
  lane and it does not go red — it goes GREEN, because the entitlement path
  short-circuits off-cloud to the same inert value it returns for an exempt org
  (the MOTIR-2601 trap). Check `docs/acceptance-lane-triage.md` for the
  per-spec destination before renaming anything.
- **Writing a NEW acceptance spec:** declare its story with `acceptanceStory('MOTIR-<n>')`
  — without it the clip cannot be published to that story at all — and keep it
  watchable (the ≤ ~60s scope, the chaptering, the pacing). A clip under the 15s
  floor is reported as _unpublishable_, which is a different verdict from a
  failure.
- **⚠️ YOU PUBLISH THE RECEIPT, and until MOTIR-4704 this section did not say so
  — which is the whole of why that bug exists.** No CI lane uploads the
  recording; MOTIR-4096 retired the one that did, because a publisher that must
  be PRESENT in a repository is one no customer repository can meet. Two calls,
  because a video is far larger than a tool argument can carry:
  **`create_acceptance_upload`** with the card's key mints a short-lived
  presigned PUT; **PUT the clip's bytes to that URL** with
  `Content-Type: video/webm`; then **`publish_acceptance_result`** with the
  `pathname` it returned, the chapters from `chapters.json`, the `commitSha` and
  the card's key as `producedByKey`. Pass the E2E card's own key to both — a
  receipt belongs to the STORY, and the server resolves up to it.
- **⚠️ NOTHING ELSE MAKES THAT CALL, AND A MISSING PUBLISH LOOKS EXACTLY LIKE A
  SUCCESSFUL RUN.** This is the design-result warning above, transposed, and it
  is if anything sharper here: the acceptance GATE rests entirely on the receipt
  existing, so a spec that goes green, a check that passes and a pull request
  that merges leave behind a story nobody can watch working — and nothing
  anywhere goes red. **The confirmation is the receipt `id` the call returns**,
  and its `status` is `pending`: publishing is not accepting, a person still
  watches it. A RED run publishes nothing, and that is correct — the receipt
  records a green run or it records nothing.

---

## ⚠️ A `loading.tsx` may NOT sit above a route that decides existence

**EXTREMELY IMPORTANT: a `loading.tsx` fallback can render as soon as its
ancestor layouts resolve — which is BEFORE the page function runs. That flushes
the response head, so the HTTP status is fixed at 200. A `notFound()` reached
later in that page then renders the not-found BODY under a 200, and the 404 is
gone. So a boundary must never sit above a segment whose status is load-bearing.**

This is the inverse of the rule that stood here between MOTIR-3433 and
MOTIR-3492, which said "every route group carries a `loading.tsx`". That rule was
written on the assumption that a boundary is free. It is not, and the assumption
was falsified by experiment rather than argument:

- `tests/e2e/billing-selfhost.spec.ts` asserts `/settings/organization/billing`
  404s on a self-host build. With an `app/(authed)/loading.tsx` it received
  **200**; with that one file removed and nothing else changed, **404**.
- The same A/B held for `issue-detail-flow.spec.ts`'s cross-workspace assertion,
  whose 404 is a documented **no-existence-leak** contract — the page's own
  comment says a browse denial "must be indistinguishable from a missing issue
  (404, no existence leak)".
- **11 of the 58 `app/(authed)` pages call `notFound()`.** A group-level
  boundary covers all 58, so it breaks all 11 at once.

**⚠️ MOVING THE GATE DOES NOT HELP — this was built and measured, not assumed.**
The obvious repair is to hoist the `notFound()` into a `layout.tsx` above the
page so it runs "before" the stream. A layout is an ANCESTOR of the boundary, so
resolving it is precisely what RELEASES the fallback: the billing route with a
gate layout still returned 200. There is no gate placement that recovers the
status. The only fix is not to put a boundary there.

### What to use instead

- ✅ **An in-page `<Suspense>`, placed AFTER the page's own gate.** It renders
  once the status is already settled, so it streams without touching the status.
  This is the right instrument for a page that must both 404 and stream, and
  `app/(authed)/items/[key]/page.tsx` (MOTIR-3436) is the worked example: its
  late stack — Development, Acceptance, Design result, Attachments, Activity —
  sits behind two boundaries sharing one promise, and `issue-detail-flow.spec.ts`
  passes 16/16 with it.
- ✅ **Parallelise the reads.** The measured win on the item page came from
  collapsing twenty-nine SEQUENTIAL awaits into one `Promise.all` plus the late
  stack, not from drawing a frame. A page that paints after one round trip does
  not need a pending frame to feel immediate.
- ✅ **A `loading.tsx` is still fine above a subtree where NO page calls
  `notFound()`** — but see the second cost below before reaching for one.
- ✅ **A ROUTE GROUP scopes a boundary away from a deciding sibling.** When the
  frame is worth keeping for the safe routes, put those routes and the
  `loading.tsx` inside a group: it adds no URL segment but does own its own
  boundary, so the deciding sibling stops being beneath it. `/explore` keeps its
  skeleton from `app/(public)/explore/(square)/loading.tsx` while
  `explore/topic/[slug]` — one directory up and outside the group — keeps its
  404 (MOTIR-3491). Deleting the boundary is not the only remedy.
- ❌ **Never a `loading.tsx` at a route-group root** that contains any
  existence-deciding route. `app/(authed)` is such a group — and so was
  `explore/` before the `(square)` group was carved out of it.

### The second cost — a boundary makes every unscoped locator a race

A boundary also changes navigation: React keeps the PREVIOUS subtree mounted
(hidden) while the new one streams, so both are in the DOM at once. Playwright
resolves locators before filtering on visibility, so an unscoped `getByText` /
`getByTestId` / `getByLabel` matches BOTH and fails strict mode. Adding one
group boundary turned **30 assertions across 17 spec files** red at once.

`getByRole` is immune — the accessibility tree excludes the hidden copy. Of those
30 failures, exactly zero used `getByRole`. So when a spec must assert on a
bounded route, reach for `getByRole`, or scope to the live subtree; and treat a
new boundary as a change with a suite-wide blast radius, not a local courtesy.

### Known debt — none

`KNOWN_STATUS_DEBT` in `tests/navigation/loading-boundary-guard.test.ts` is
**empty**. It held one entry: `app/(public)/explore/loading.tsx` sat above
`app/(public)/explore/topic/[slug]/page.tsx`, so a missing topic answered **200**.
MOTIR-3491 fixed it with the route-group remedy above — the square's page and its
`loading.tsx` moved into `app/(public)/explore/(square)/`, which keeps the frame
on `/explore` and takes it off `topic/[slug]`. Measured on a production build:
`/explore/topic/definitely-not-a-real-topic-xyz` was 200, and is 404.

The list is asserted tight in both directions, so it only shrinks: an entry that
stops describing the tree fails the suite. Adding one means parking a defect —
it needs a filed bug and a reproduction, not a judgement that a boundary is worth
the status. MOTIR-3492 still carries what the pending frame owes on the authed
side, and blocks MOTIR-3440 until its "the group's frame" premise is restated.

### URL state the CLIENT reads is written with `shallowPush`

**A URL that only the client reads is written with `shallowPush`
(`lib/navigation/shallowUrl.ts`). `router.push` is for a URL change the SERVER
must answer.**

`router.push` re-runs the whole Server-Component page. That is right when the
destination body needs data the browser does not have — a different query, a
different page of results, a server-computed series. It is pure cost when the
body is already in the browser and the URL is only there so a deep link, a
reload and Back/forward agree. Three view toggles were paying it (MOTIR-3434):
the plan detail's Canvas/List re-ran seven awaits, and the item page's Children
List/Graph re-ran twenty-nine, to render something already on screen.

- ✅ **`shallowPush(href)`** for a view toggle, a peek, a panel mode — anything
  whose target body is already rendered or fetches itself client-side. Next
  syncs `usePathname` / `useSearchParams` with `history.pushState`, so every
  `searchParams.get(...)` derivation keeps working untouched.
- ✅ **Keep the history entry.** `shallowPush`, not `shallowReplace`, unless the
  URL genuinely should not be somewhere Back returns to. MOTIR-1549 was filed
  because the roadmap toggle used a replace and Back stopped restoring the scope.
- ✅ **`router.push` stays** where the server must answer: `/items`' tree ↔ list,
  the plans list's status tabs, the item page's activity tabs, every report
  control, and any change of ROUTE.
- ❌ **No pending affordance on a shallow switch** — no spinner, no disabled
  segment, no skeleton, no dim. There is nothing to wait for, and drawing a wait
  manufactures one. The visual half of this rule is
  `design/shell/design-notes.md` § _THE SWITCH RULE_, which draws the three
  toggles at rest; the two homes cite each other.

**The discriminator is not the control** — the same `Segmented` primitive serves
both kinds — **it is whether the target body needs data the browser does not
have.**

**The gate is unaffected by a group boundary and structurally cannot be:** a
group's `layout.tsx` awaits its session and redirects before it renders
`children`, and a `loading.tsx` is a fallback for the children — so an
unauthenticated visitor is bounced, never shown a frame.

`design/shell/navigation-pending.mock.html` + `design/shell/design-notes.md`
§ _The navigation-pending grammar_ is the design of record, in its SECOND
revision (MOTIR-3492): the wait's three windows and which instrument covers
each, the frame block by block, the argument for 120ms, the no-shift mapping,
the rule for which surfaces earn a frame, and the decision to scope the
BOUNDARIES rather than the 30 assertions above. Its short form: **the frame is
an in-page `<Suspense>` placed after the page's own gate, every page's frame is
its own, and no `loading.tsx` is added under `app/(authed)`.**

**The ROUTE-GROUP instrument above is the one that asset weighs and declines,
for this group only** — it is a route-level boundary, so it still carries the
30-assertion locator cost, and scoping it around eleven deciders scattered
across `settings/`, `items/`, `plans/`, `sprints/`, `dashboard/` and
`direction/` is a tree-wide restructuring where an in-page `<Suspense>` is one
line in one page. **That is a judgement about this group, not about the
instrument**: `/explore` was the opposite case — two routes, one boundary worth
keeping, no spec asserting unscoped against it — and there the group is
correct.

---

## ⚠️ Page state after a mutation — server refresh vs. client-island refetch

**EXTREMELY IMPORTANT: a mutation made on a page MUST update EVERY surface it
affects. Before shipping any create/update/delete, enumerate the surfaces it
changes and route each to the correct update mechanism by HOW that surface
renders. The recurring bug is assuming one mechanism (usually `router.refresh()`)
covers all of them — it does not.**

There are three surface kinds, and they update differently:

1. **The edited field's OWN cell (inline edit).** The success response IS the
   confirmation. Do **NOT** `router.refresh()` / `revalidatePath()` the cell's
   own value — keep the optimistic value. The refresh fan-out re-reads stale data
   and CAUSES a visible revert (`inline-edit-no-tree-refresh`; PR #619's
   defend-the-cell approach was rejected — remove the refresh instead).

2. **A SERVER-rendered surface elsewhere on the page** — a Server-Component
   count, header, badge, or list rendered directly from a server read.
   `router.refresh()` re-runs the server read and updates it. This is the ONLY
   thing `router.refresh()` reaches.

3. **A CLIENT island that owns its own state** — a `'use client'` component
   seeded from server props via `useState(initialProps)` (a board, the triage
   inbox queue, any optimistic list). **`router.refresh()` CANNOT reach it:** the
   `useState` initializer runs ONCE at mount, so re-rendered server props are
   silently ignored. Such an island MUST be given an explicit refetch trigger:
   - **A provider TICK** — a monotonic counter bumped by the mutation, which the
     island watches in a `useEffect` and refetches on. The canonical instance is
     `CreateIssueProvider.issuesChangedAt` (the board watches it);
     `ReportProvider.submissionsChangedAt` (the triage inbox watches it) is the
     same shape. Skip the mount run; refetch silently on each bump.
   - **OR an optimistic local insert/remove** when the mutation fires from
     INSIDE that same island (e.g. the triage terminal actions remove the row
     locally, seq-guarded).

A mutation that touches BOTH a server surface AND a client island does BOTH:
`router.refresh()` for the server bits **and** bump the tick for the island.
Never assume the refresh alone updated the island. (Worked example — 6.11.7: the
report widget created a triage item and called `router.refresh()`, but the inbox
queue is a client island seeding `useState(initialItems)`, so the new row never
appeared until the widget also bumped a tick the inbox refetches on.)

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
- **Commit authorship — Yue's GitHub account ONLY; never a `Co-Authored-By`
  trailer.** Every commit MUST be authored as **`Zhu Yue <zhuyue11@gmail.com>`**
  (the GitHub account), and the commit message MUST NOT contain a
  `Co-Authored-By: …` line — in particular never an
  `…@anthropic.com` / Claude co-author. This repo runs a **`license/cla`** check
  (cla-assistant) that **fails the PR if any commit author OR co-author is not a
  CLA signatory**; the Claude co-author and any non-Yue author identity
  (`zhuyue@motir.co`, `Motir Planner`, `info@moooon.net`) are not signatories, so
  they block the PR (hit on PR #978). Commit with
  `git -c user.name="Zhu Yue" -c user.email="zhuyue11@gmail.com" commit --author="Zhu Yue <zhuyue11@gmail.com>" -m "…"`.
  If a CLA check is already red on a pushed branch, `reset --soft origin/main`,
  re-commit with the correct author and no trailer, and `push --force-with-lease`.
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
- **Migrations — a hand-written PARTIAL index must not reuse the column list of
  an `@@index` on the same model.** Prisma's differ pairs a database index to a
  datamodel index BY COLUMN LIST, and it ignores a database index it cannot
  express (a `WHERE` clause is inexpressible) only for as long as no `@@index`
  claims those columns. When one does, the two get paired, the sole remaining
  difference is the NAME, and `migrate diff` reports a permanent spurious
  **RENAME** — which the next `migrate dev` writes into a migration, renaming one
  index over the other and destroying it. Renaming the index does NOT fix this
  (the differ re-reports against the new name); giving it a column list of its
  own does. Pick that extra column from what the index's own query filters or
  orders on, so it earns its place — `project_repository_ci_actions_pending_idx`
  is `(workspace_id, state)`, not `(workspace_id)`, because the sweep filters on
  both. (Fixed by MOTIR-1960; the same shape as the FK rule above — a
  schema-invisible DB object put the datamodel and the migration-built DB in
  permanent disagreement. **The `build` job now gates this**: it runs
  `prisma migrate diff --from-schema … --to-config-datasource --exit-code`
  against its from-empty replay, so drift of ANY kind fails CI rather than
  ambushing the next `migrate dev`.)
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
    NOT just rerun past it: **file it as a `bug` work item against the live
    tenant**, and surface it in the PR body — the same protocol as an
    out-of-scope finding.
    - **Reproduce it FIRST.** A bug filed from reading the code is a claim, not
      an observation, and it costs whoever picks it up the same investigation a
      second time.
    - **Parent it under the in-flight card's own parent**, and link it
      `relates_to` the card it was found on. The parent says where the bug
      LIVES; the link says where it was FOUND. It blocks nothing, joins no
      sprint and claims no scope — filing is purely additive, which is what
      makes it safe to do mid-run at all.
    - Its description carries the **reproduction**, the **evidence** (the
      command you ran and its output verbatim, or the file and line you read),
      and the **card and branch it was seen on** — a number measured on an
      unmerged branch is not a number about `main`.
    - ⚠️ **This clause used to say "log it in the plan seed (the bug-logging
      `seed/*` PR with the `[reseed]` marker)". That channel is RETIRED** —
      every mutation goes through the live tenant now — so for a long stretch
      the one instruction that told an agent to file a bug pointed at a
      mechanism that no longer existed, while the dispatch prompt forbade the
      one that did. An agent following both faithfully did nothing. Fixed by
      MOTIR-3026; the protocol above is the same one the dispatch prompt's
      FOUND A DEFECT branch states, so the two cannot disagree
      (`docs/decisions/run-findings-protocol.md` Q3).
    - A run launched with `--disable-log-bug` is told to COMMENT the finding
      instead. Honour whichever the prompt you were handed actually says: the
      prompt is the contract, and this file is the standing default.
  - **Genuinely flaky** (non-deterministic, root cause understood and unrelated
    to your change) → only THEN is a re-run appropriate; say so explicitly with
    the evidence, don't let "probably flaky" be the default.
