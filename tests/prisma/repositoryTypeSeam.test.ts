import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { componentsService } from '@/lib/services/componentsService';
import {
  componentRepository,
  type ComponentUpdateInput,
} from '@/lib/repositories/componentRepository';
import { makeWorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import type { WorkspaceContext } from '@/lib/workspaces';

// THE PRISMA TYPE BOUNDARY, END TO END (Story MOTIR-4292 · MOTIR-4296 ·
// MOTIR-4300) — a write shaped by a REPOSITORY-EXPORTED type, through the
// service that builds it, to the route that returns the DTO, against real
// Postgres.
//
// ── What this asserts that `tests/prisma/typeBoundary.test.ts` cannot ───────
// That guard is a SOURCE SCAN: it proves no file outside `lib/repositories/**`
// names `Prisma.<Model>UpdateInput`. It is a text property, and a text property
// is satisfied just as well by a sweep that broke something — an alias that
// resolves to the wrong model, an accumulator that stopped being applied, a
// field silently dropped from the write — because none of those are visible to
// a regex. A green scan plus a green type-check is a strong pair, and neither of
// them runs the write.
//
// So this file takes the whole path in one motion:
//
//   the route's body  →  `componentsService.updateComponent`, which builds its
//   patch as `ComponentUpdateInput` — the alias `componentRepository` exports —
//   →  `componentRepository.update`, which is the only layer that may name the
//   generated client's generics  →  Postgres  →  the mapper  →  `ComponentDto`
//   →  the route's JSON.
//
// `componentsService` is one of the nine files MOTIR-4296 swept, and its
// accumulator (`const update: ComponentUpdateInput = {}`) is the exact shape the
// sweep changed: it used to read `Prisma.ComponentUncheckedUpdateInput`. If that
// alias were wrong in a way the type checker accepts — a `Partial<>` too wide, a
// model confused for its neighbour — the write would still compile and the field
// would not arrive. This is the assertion that would notice.
//
// Real Postgres, per CLAUDE.md. The ONE thing stubbed is `getWorkspaceContext`,
// the cookie-derived resolver a test environment cannot supply — the same stub
// and the same reason as `tests/integration/sprints/sprint-points.test.ts`.

const wsCtx = { current: null as WorkspaceContext | null };
vi.mock('@/lib/workspaces', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/workspaces')>();
  return { ...actual, getWorkspaceContext: async () => wsCtx.current };
});

// Imported AFTER the mock is registered.
const { PATCH } = await import('@/app/api/components/[id]/route');

const BASE = 'http://localhost:3000';

function patch(id: string, body: unknown): Promise<Response> {
  return PATCH(
    new Request(`${BASE}/api/components/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );
}

beforeEach(async () => {
  await truncateAuthTables();
  wsCtx.current = null;
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('a repository-exported input type carries a write from the route to the row', () => {
  it('PATCHes through the swept service and the field reaches Postgres AND the DTO', async () => {
    const fx = await makeWorkItemFixture();
    wsCtx.current = fx.ctx;
    const created = await componentsService.createComponent(
      { key: fx.projectIdentifier, name: 'Billing', description: 'the old words' },
      fx.ctx,
    );

    const response = await patch(created.id, {
      name: 'Billing & invoicing',
      description: 'the new words',
    });

    expect(response.status).toBe(200);
    const { component } = (await response.json()) as {
      component: { name: string; description: string | null };
    };

    // 1. The DTO the route returned carries the change.
    expect(component.name).toBe('Billing & invoicing');
    expect(component.description).toBe('the new words');

    // 2. …and so does the ROW, read back as the owner. A DTO built from the
    //    service's in-memory patch rather than from the repository's return
    //    would pass the assertion above and fail this one — which is exactly the
    //    failure a type-only sweep could introduce.
    const row = await adminDb.component.findUniqueOrThrow({ where: { id: created.id } });
    expect(row.name).toBe('Billing & invoicing');
    expect(row.description).toBe('the new words');
    // The derived column the service sets beside the name, through the same
    // accumulator. It is the field most likely to be dropped by a bad sweep,
    // because nothing outside the service ever writes it.
    expect(row.nameLower).toBe('billing & invoicing');
  });

  it('a field the caller did not send is NOT written — the accumulator is still sparse', async () => {
    // The mirror assertion, and the one that catches the opposite mistake. An
    // accumulator that stopped being sparse — a sweep that replaced `{}` with a
    // full object, or an alias that made every key required — would null the
    // description on a name-only PATCH and every "the change arrived" assertion
    // would still pass.
    const fx = await makeWorkItemFixture();
    wsCtx.current = fx.ctx;
    const created = await componentsService.createComponent(
      { key: fx.projectIdentifier, name: 'Search', description: 'keep me' },
      fx.ctx,
    );

    const response = await patch(created.id, { name: 'Search & filters' });
    expect(response.status).toBe(200);

    const row = await adminDb.component.findUniqueOrThrow({ where: { id: created.id } });
    expect(row.name).toBe('Search & filters');
    expect(row.description, 'an untouched field must survive a partial patch').toBe('keep me');
  });

  it('the alias the service builds against is the one the REPOSITORY exports', async () => {
    // The boundary itself, as a type-level assertion that a text scan cannot
    // make: `ComponentUpdateInput` is imported here from
    // `@/lib/repositories/componentRepository`, and the value below is handed
    // straight to that repository's own `update`. If the alias moved, was
    // re-declared in the service, or stopped describing the model's write shape,
    // this file stops compiling — which is the failure mode worth having.
    const fx = await makeWorkItemFixture();
    wsCtx.current = fx.ctx;
    const created = await componentsService.createComponent(
      { key: fx.projectIdentifier, name: 'Ops' },
      fx.ctx,
    );

    const update: ComponentUpdateInput = { description: 'written through the exported alias' };
    const row = await adminDb.$transaction((tx) =>
      componentRepository.update(created.id, update, tx),
    );

    expect(row.description).toBe('written through the exported alias');
    expect(row.name).toBe('Ops');
  });
});
