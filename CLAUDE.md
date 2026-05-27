# CLAUDE.md

This file provides guidance to Claude Code and any other coding agent working
in this repository. It is auto-loaded as durable context for every Subtask
prompt dispatched against `prodect-core`.

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
- **Out-of-scope findings** go to
  `/Users/yuezhu/projects/prodect/prodect_plan/PRODECT_FINDINGS.md`,
  not into a CLAUDE.md or PRODECT.md update. The planner promotes
  findings into future Subtasks during replan passes.
