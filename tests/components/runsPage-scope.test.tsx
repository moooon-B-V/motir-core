// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';

// `/runs?scope=<KEY>` — the page's HEADER READ and its three answers (Story
// MOTIR-5363 · design MOTIR-5402 panels 4 and 7).
//
// ⚠️ THE FACE THIS FILE HOLDS IS THE ONE THAT MUST NOT BE CONFUSED WITH TWO
// OTHERS. A key that resolves to NOTHING is not an EMPTY narrowing (*has no runs*)
// and not a FAILED read (*we could not load this*) — the route answers 404 so
// that *is not yours* and *has no runs* stay different facts, and the page keeps
// them different too. So: an unresolvable key renders the not-found face and NO
// list; any other header failure does NOT wear that face; and the whole-project
// page never makes the header read at all.
//
// Everything the page imports is mocked at module level (as
// `item-detail-reads.test.tsx` does), so `lib/db` never loads. The page is an
// async Server Component — a function returning JSX — so it is CALLED.

const redirected = vi.fn((_to: string) => {
  throw new Error('NEXT_REDIRECT');
});
const getRunScope = vi.fn();
const listRunsForProject = vi.fn(async () => []);

vi.mock('next/navigation', () => ({ redirect: (to: string) => redirected(to) }));
vi.mock('next-intl/server', () => ({
  // The key IS the rendered text, with a `{key}` value appended where one is
  // passed — enough to tell the three faces apart without a catalog.
  getTranslations: async () =>
    Object.assign(
      (k: string, values?: { key?: string }) => (values?.key ? `${k}:${values.key}` : k),
      { rich: (k: string) => k },
    ),
}));
vi.mock('@/lib/auth', () => ({ getSession: async () => ({ user: { id: 'usr_1' } }) }));
vi.mock('@/lib/projects', () => ({
  getActiveProject: async () => ({
    userId: 'usr_1',
    workspaceId: 'ws_1',
    project: { identifier: 'PROD', name: 'Prodect' },
  }),
}));
vi.mock('@/lib/services/dispatchRunService', () => ({
  dispatchRunService: {
    getRunScope: (...args: unknown[]) => getRunScope(...args),
    listRunsForProject: () => listRunsForProject(),
  },
}));
// The list is the index's own suite; here it only has to be recognisable.
vi.mock('@/app/(authed)/runs/_components/RunsIndex', () => ({
  RunsIndex: () => <div data-testid="runs-index" />,
}));

const { default: RunsPage } = await import('@/app/(authed)/runs/page');

const page = (scope?: string) =>
  RunsPage({ searchParams: Promise.resolve(scope === undefined ? {} : { scope }) });

/**
 * Every string in a returned element tree, without rendering it. A React
 * element is not JSON (its `_owner` / `_store` refs are circular), so the walk
 * follows only `props.children` and keeps a visited set.
 */
function textOf(node: unknown, seen = new WeakSet<object>()): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (node === null || typeof node !== 'object' || seen.has(node)) return '';
  seen.add(node);
  if (Array.isArray(node)) return node.map((n) => textOf(n, seen)).join(' ');
  const props = (node as { props?: { children?: unknown } }).props;
  return props ? textOf(props.children, seen) : '';
}

beforeEach(() => {
  getRunScope.mockReset();
  listRunsForProject.mockClear();
});
afterEach(() => cleanup());

describe('⚠️ a key that resolves to NOTHING is its own face', () => {
  it('renders the not-found notice, the key as PLAIN TEXT, and no list', async () => {
    getRunScope.mockRejectedValue(new WorkItemNotFoundError('PROD-999'));
    render(await page('prod-999'));

    // The key is upper-cased before it is resolved — every link writes it so.
    expect(getRunScope).toHaveBeenCalledWith('PROD', 'PROD-999', expect.anything());
    expect(screen.getByRole('status').textContent).toContain('scopeIndex.notFoundTitle:PROD-999');
    expect(screen.getByText('scopeIndex.notFoundBody')).toBeTruthy();
    // Plain text: there is nothing for the key to open.
    expect(screen.getByText('scopeIndex.subtitleMissing:PROD-999')).toBeTruthy();
    expect(screen.queryByRole('link', { name: /PROD-999/ })).toBeNull();
    // No list, and neither of the other two faces' words.
    expect(screen.queryByTestId('runs-index')).toBeNull();
    expect(listRunsForProject).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain('scopeIndex.emptyTitle');
    expect(document.body.textContent).not.toContain('indexReadFailed');
    // The way back is there.
    expect(screen.getByRole('link', { name: 'scopeIndex.allRuns' }).getAttribute('href')).toBe(
      '/runs',
    );
  });

  it('a header read that FAILS for any other reason does not wear the not-found face', async () => {
    getRunScope.mockRejectedValue(new Error('connection reset'));
    const tree = await page('PROD-7');
    // The list is still attempted behind its boundary — its own reads show
    // their failed face — so the page returns a tree rather than the notice.
    // (Walked, not rendered: the list sits behind an async Server Component.)
    const text = textOf(tree);
    expect(text).not.toContain('scopeIndex.notFoundTitle');
    expect(text).toContain('scopeIndex.subtitleMissing:PROD-7');
  });
});

describe('the whole-project page never makes the header read', () => {
  it('no `?scope=` — no getRunScope call', async () => {
    await page();
    expect(getRunScope).not.toHaveBeenCalled();
  });

  it('a blank `?scope=` narrows nothing either', async () => {
    await page('   ');
    expect(getRunScope).not.toHaveBeenCalled();
  });
});
