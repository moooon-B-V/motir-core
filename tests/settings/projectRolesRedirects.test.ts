import { describe, expect, it, vi } from 'vitest';

// The retired project Roles URLs (Story MOTIR-6168 · MOTIR-6466; design panel
// 4c): each PERMANENTLY redirects to its workspace twin with `?from=project`.
// `admin` moves with its meaning to `manager`; a project custom role's id names
// nothing on the workspace, so it lands on the list.

const permanentRedirect = vi.fn((url: string) => {
  throw new Error(`PERMANENT_REDIRECT:${url}`);
});
vi.mock('next/navigation', () => ({ permanentRedirect: (u: string) => permanentRedirect(u) }));

const list = await import('@/app/(authed)/settings/project/roles/page');
const detail = await import('@/app/(authed)/settings/project/roles/[roleKey]/page');
const edit = await import('@/app/(authed)/settings/project/roles/[roleKey]/edit/page');
const create = await import('@/app/(authed)/settings/project/roles/new/page');

async function target(run: () => unknown): Promise<string> {
  try {
    await run();
  } catch (err) {
    const m = /^PERMANENT_REDIRECT:(.*)$/.exec((err as Error).message);
    if (m) return m[1]!;
    throw err;
  }
  throw new Error('no redirect');
}

const params = (roleKey: string) => ({ params: Promise.resolve({ roleKey }) });

describe('every old /settings/project/roles/** URL answers a permanent redirect', () => {
  it('the list → the workspace list', async () => {
    expect(await target(() => list.default())).toBe('/settings/workspace/roles?from=project');
  });

  it('new → the workspace editor', async () => {
    expect(await target(() => create.default())).toBe('/settings/workspace/roles/new?from=project');
  });

  it.each([
    ['admin', 'manager'],
    ['member', 'member'],
    ['viewer', 'viewer'],
  ])('the %s detail → the workspace %s detail, and its editor likewise', async (from, to) => {
    expect(await target(() => detail.default(params(from)))).toBe(
      `/settings/workspace/roles/${to}?from=project`,
    );
    expect(await target(() => edit.default(params(from)))).toBe(
      `/settings/workspace/roles/${to}/edit?from=project`,
    );
  });

  it('a project custom role id lands on the list — the workspace re-created it under a new id', async () => {
    expect(await target(() => detail.default(params('cmroleid123')))).toBe(
      '/settings/workspace/roles?from=project',
    );
    expect(await target(() => edit.default(params('cmroleid123')))).toBe(
      '/settings/workspace/roles?from=project',
    );
  });
});
