// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import type { PageTrailDto } from '@/lib/dto/pages';
import zhMessages from '@/messages/zh.json';
import { renderWithIntl } from '../helpers/renderWithIntl';
import {
  PageBreadcrumb,
  breadcrumbSegments,
  foldSegments,
} from '@/components/pages/tree/PageBreadcrumb';

// THE PAGE'S BREADCRUMB (Story MOTIR-5753 · MOTIR-7375) —
// `design/pages/page--tree-sidebar.mock.html` panels 1, 2 and 4: root-first
// Pages › folders › ancestor pages › this page; folder segments link to
// `/pages?folder=<id>`, page segments to their page; the page itself is
// `aria-current`, not a link; over five segments the middle folds into "…",
// whose menu lists the hidden segments root-first. "← Pages" is gone.

afterEach(cleanup);

const trail = (folders: string[], pages: string[]): PageTrailDto => ({
  folders: folders.map((name, i) => ({ id: `f${i + 1}`, name })),
  pages: pages.map((title, i) => ({ id: `p${i + 1}`, title })),
});

function mount(t: PageTrailDto | null, title = 'Edge cases', zh = false) {
  return renderWithIntl(
    <PageBreadcrumb trail={t} page={{ id: 'pg', title }} />,
    zh ? { locale: 'zh', messages: zhMessages } : {},
  );
}

const nav = () => screen.getByRole('navigation', { name: 'Where this page is' });
const links = () =>
  within(nav())
    .getAllByRole('link')
    .map((a) => [a.textContent, a.getAttribute('href')]);

describe('PageBreadcrumb', () => {
  it('reads folder › parent page › page, each segment linking to its target', () => {
    mount(trail(['Specs'], ['Auth flow']));
    expect(links()).toEqual([
      ['Pages', '/pages'],
      ['Folder:Specs', '/pages?folder=f1'],
      ['Auth flow', '/pages/p1'],
    ]);
    const current = within(nav()).getByText('Edge cases');
    expect(current.getAttribute('aria-current')).toBe('page');
    expect(current.closest('a')).toBeNull();
    expect(current.getAttribute('title')).toBe('Edge cases');
    // "← Pages" is gone.
    expect(screen.queryByRole('link', { name: 'Back to Pages' })).toBeNull();
  });

  it('a root page keeps its way back — Pages › page; an unreadable trail reads the same', () => {
    mount(trail([], []));
    expect(links()).toEqual([['Pages', '/pages']]);
    cleanup();
    mount(null);
    expect(links()).toEqual([['Pages', '/pages']]);
  });

  it('an untitled page and an untitled ancestor read the untitled copy', () => {
    mount(trail([], ['']), '');
    expect(links()).toEqual([
      ['Pages', '/pages'],
      ['Untitled', '/pages/p1'],
    ]);
    expect(within(nav()).getByText('Untitled', { selector: '[aria-current]' })).toBeTruthy();
  });

  it('five segments are all shown; a sixth folds the middle into "…", which lists them root-first', async () => {
    mount(trail(['Specs', 'API'], ['Auth flow']));
    expect(screen.queryByRole('button', { name: /more levels/ })).toBeNull();
    cleanup();

    mount(trail(['Specs', 'API', 'v2'], ['Auth flow', 'Token refresh']));
    // Pages, the first segment, the parent and the page are kept.
    expect(links()).toEqual([
      ['Pages', '/pages'],
      ['Folder:Specs', '/pages?folder=f1'],
      ['Token refresh', '/pages/p2'],
    ]);
    const more = screen.getByRole('button', { name: 'Show 3 more levels' });
    await act(async () => {
      fireEvent.click(more);
    });
    const menu = await screen.findByRole('menu', { name: 'Show 3 more levels' });
    const items = within(menu).getAllByRole('menuitem');
    expect(items.map((a) => [a.textContent, a.getAttribute('href')])).toEqual([
      ['API', '/pages?folder=f2'],
      ['v2', '/pages?folder=f3'],
      ['Auth flow', '/pages/p1'],
    ]);
    expect(document.activeElement).toBe(items[0]);

    // Arrow keys walk the menu, wrapping; Home / End jump.
    const k = async (key: string) =>
      act(async () => {
        fireEvent.keyDown(menu, { key });
      });
    await k('ArrowDown');
    expect(document.activeElement).toBe(items[1]);
    await k('ArrowUp');
    await k('ArrowUp');
    expect(document.activeElement).toBe(items[2]);
    await k('Home');
    expect(document.activeElement).toBe(items[0]);
    await k('End');
    expect(document.activeElement).toBe(items[2]);
    await k('ArrowDown');
    expect(document.activeElement).toBe(items[0]);
    await k('Tab');
    expect(document.activeElement).toBe(items[0]);

    // Choosing one closes the menu.
    await act(async () => {
      fireEvent.click(items[1]!);
    });
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('reads in Chinese', () => {
    mount(trail(['规格'], []), '边界情况', true);
    expect(screen.getByRole('navigation', { name: '此页面所在位置' })).toBeTruthy();
    expect(screen.getByRole('link', { name: /文件夹：\s*规格/ }).getAttribute('href')).toBe(
      '/pages?folder=f1',
    );
  });
});

describe('the breadcrumb’s pure halves', () => {
  it('builds segments root-first and folds by count, not kind', () => {
    const segments = breadcrumbSegments(trail(['a'], ['b', 'c', 'd']), 'Pages', 'Untitled');
    expect(segments.map((s) => s.kind)).toEqual(['root', 'folder', 'page', 'page', 'page']);
    const folded = foldSegments(segments);
    expect(folded.head.map((s) => s.label)).toEqual(['Pages', 'a']);
    expect(folded.hidden.map((s) => s.label)).toEqual(['b', 'c']);
    expect(folded.tail.map((s) => s.label)).toEqual(['d']);
    expect(foldSegments(segments.slice(0, 4)).hidden).toEqual([]);
  });
});
