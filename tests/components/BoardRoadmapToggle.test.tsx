// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import zhMessages from '@/messages/zh.json';
import { BoardRoadmapToggle } from '@/app/(authed)/_components/BoardRoadmapToggle';

// The Board ↔ Roadmap view toggle (Subtask 7.20.5 / MOTIR-1011) — the access path
// between /boards and /roadmap. It must be two real <Link>s (so each view is
// middle/⌘-clickable, mistake #1306), pointing at the canonical routes, with the
// CURRENT view marked `aria-current="page"`. We assert the rendered anchors +
// hrefs + active marker rather than any navigation side effect (there is none —
// it's a link, not an onClick handler).

afterEach(cleanup);

describe('BoardRoadmapToggle', () => {
  it('renders both views as links to the canonical routes', () => {
    renderWithIntl(<BoardRoadmapToggle current="board" />);

    const board = screen.getByRole('link', { name: 'Board' });
    const roadmap = screen.getByRole('link', { name: 'Roadmap' });
    expect(board.getAttribute('href')).toBe('/boards');
    expect(roadmap.getAttribute('href')).toBe('/roadmap');
  });

  it('marks the current view (board) with aria-current="page"', () => {
    renderWithIntl(<BoardRoadmapToggle current="board" />);

    expect(screen.getByRole('link', { name: 'Board' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('link', { name: 'Roadmap' }).getAttribute('aria-current')).toBeNull();
  });

  it('marks the current view (roadmap) with aria-current="page"', () => {
    renderWithIntl(<BoardRoadmapToggle current="roadmap" />);

    expect(screen.getByRole('link', { name: 'Roadmap' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('link', { name: 'Board' }).getAttribute('aria-current')).toBeNull();
  });

  it('exposes the group with an accessible label', () => {
    renderWithIntl(<BoardRoadmapToggle current="board" />);
    expect(screen.getByRole('group', { name: 'Switch between board and roadmap' })).toBeTruthy();
  });

  it('renders the localized labels (zh)', () => {
    renderWithIntl(<BoardRoadmapToggle current="board" />, {
      locale: 'zh',
      messages: zhMessages,
    });
    // zh: Board = 面板, Roadmap = 路线图
    expect(screen.getByRole('link', { name: '面板' }).getAttribute('href')).toBe('/boards');
    expect(screen.getByRole('link', { name: '路线图' }).getAttribute('href')).toBe('/roadmap');
  });
});
