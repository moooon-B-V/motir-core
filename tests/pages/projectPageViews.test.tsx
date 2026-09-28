import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { db } from '@/lib/db';
import { projectAccessService } from '@/lib/services/projectAccessService';
import type { ProjectPageContext } from '@/lib/pages/projectPageContext';
import type { PermissionKey } from '@/lib/permissions/catalog';
import { createTestWorkItem, makeWorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// The read pages' BODIES take their project from a context (Story MOTIR-6170 ·
// MOTIR-6643). Each view is CALLED here the way its `(authed)` page calls it,
// with a HAND-BUILT `ProjectPageContext` — no session, no active project, nothing
// from `next/headers` — against the real datastore. That is what the Visitor
// route tree will do, so it is the property to pin: a view renders from what it
// is handed, and its capability booleans come from the permission set in it.

vi.mock('next-intl/server', () => ({
  getTranslations: async () => (key: string) => key,
  getLocale: async () => 'en',
}));
// A view must never reach for the session: if one does, this fails loudly.
vi.mock('@/lib/auth', () => ({
  getSession: () => {
    throw new Error('a view read the session');
  },
}));
vi.mock('@/lib/projects', () => ({
  getActiveProject: () => {
    throw new Error('a view read the active project');
  },
}));

beforeEach(async () => {
  await truncateAuthTables();
});
afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** Every element in a returned tree, depth-first. */
function elements(node: ReactNode, out: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) {
    for (const child of node) elements(child, out);
  } else if (isValidElement(node)) {
    out.push(node);
    elements((node.props as { children?: ReactNode }).children, out);
  }
  return out;
}

const named = (tree: ReactNode, name: string) =>
  elements(tree).filter((e) => {
    const type = e.type as { name?: string; displayName?: string } | string;
    return typeof type !== 'string' && (type.displayName ?? type.name) === name;
  });

/** A context built by hand, the permission set supplied rather than resolved. */
async function contextFor(held?: Iterable<PermissionKey>): Promise<{
  page: ProjectPageContext;
  fx: Awaited<ReturnType<typeof makeWorkItemFixture>>;
}> {
  const fx = await makeWorkItemFixture({ name: 'Views', identifier: 'VIEW' });
  const reader = {
    userId: fx.ownerId,
    workspaceId: fx.workspaceId,
    projectId: fx.projectId,
    project: fx.project,
  };
  const set = held
    ? new Set(held)
    : await projectAccessService.getPermissions(fx.projectId, {
        userId: fx.ownerId,
        workspaceId: fx.workspaceId,
      });
  return {
    fx,
    page: {
      project: fx.project,
      permissions: async () => set,
      actorUserId: fx.ownerId,
      actorName: 'Owner',
      reader,
    },
  };
}

describe('BoardView', () => {
  it('renders the board from a hand-built context, canEdit read off its permission set', async () => {
    const { default: BoardView } = await import('@/app/(authed)/boards/_view');
    const { page, fx } = await contextFor(['project:browse']);
    const tree = await BoardView({ ctx: page, searchParams: Promise.resolve({}) });

    const [board] = named(tree, 'BoardContainer');
    expect(board, 'the board renders').toBeDefined();
    expect(board!.props).toMatchObject({ activeProjectId: fx.projectId, canEdit: false });
    expect(named(tree, 'NoAccessState')).toHaveLength(0);
  });

  it('grants the drag-edit mode when the set holds work_item:edit', async () => {
    const { default: BoardView } = await import('@/app/(authed)/boards/_view');
    const { page } = await contextFor(['project:browse', 'work_item:edit']);
    const tree = await BoardView({ ctx: page, searchParams: Promise.resolve({}) });
    expect(named(tree, 'BoardContainer')[0]!.props).toMatchObject({ canEdit: true });
  });

  it('renders the no-access state for a set without project:browse', async () => {
    const { default: BoardView } = await import('@/app/(authed)/boards/_view');
    const { page } = await contextFor([]);
    const tree = await BoardView({ ctx: page, searchParams: Promise.resolve({}) });
    expect(named(tree, 'NoAccessState')).toHaveLength(1);
    expect(named(tree, 'BoardContainer')).toHaveLength(0);
  });
});

describe('ItemView', () => {
  it('renders a work item from a hand-built context, with no session anywhere', async () => {
    const { default: ItemView } = await import('@/app/(authed)/items/[key]/_view');
    const { page, fx } = await contextFor();
    const item = await createTestWorkItem(fx, { kind: 'task', title: 'Rendered by a context' });
    const identifier = `${fx.projectIdentifier}-${item.key}`;

    const tree = await ItemView({
      ctx: page,
      params: Promise.resolve({ key: identifier }),
      searchParams: Promise.resolve({}),
    });

    expect(isValidElement(tree)).toBe(true);
    const titles = named(tree, 'WorkItemTitle');
    expect(titles.length, 'the item title renders').toBeGreaterThan(0);
    expect(JSON.stringify(titles[0]!.props)).toContain('Rendered by a context');

    // The late stack streams behind its own boundary from a promise the view
    // started; settle it so its reads do not outlive the case.
    const late = named(tree, 'LateUpperSections')[0]!.props as { reads: Promise<unknown> };
    await Promise.allSettled([late.reads]);
  });
});
