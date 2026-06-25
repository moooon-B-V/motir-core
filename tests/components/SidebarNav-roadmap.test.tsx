// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import type { ProjectDTO } from '@/lib/dto/projects';
import zhMessages from '@/messages/zh.json';
import { renderWithIntl } from '../helpers/renderWithIntl';

// The Roadmap nav entry (Subtask 7.20.5 / MOTIR-1011) — the access path to the
// roadmap view is its OWN primary left-nav entry (ai-planning design §5), NOT a
// Board↔Roadmap toggle. We assert SidebarNav renders a "Roadmap" link to /roadmap
// that is `aria-current="page"` on the roadmap route and inactive elsewhere.

let pathname = '/roadmap';
vi.mock('next/navigation', () => ({
  usePathname: () => pathname,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));

import { SidebarNav } from '@/app/(authed)/_components/SidebarNav';

const PROJECT = {
  id: 'p1',
  key: 'PROD',
  identifier: 'PROD',
  name: 'Prodect',
  avatarIcon: null,
  avatarColor: null,
  archivedAt: null,
} as unknown as ProjectDTO;

const USER = { name: 'Yue', email: 'yue@example.com' };

afterEach(() => {
  cleanup();
  pathname = '/roadmap';
});

describe('SidebarNav — Roadmap entry', () => {
  it('renders a Roadmap nav link to /roadmap', () => {
    renderWithIntl(<SidebarNav activeProject={PROJECT} projects={[PROJECT]} user={USER} />);
    expect(screen.getByRole('link', { name: 'Roadmap' }).getAttribute('href')).toBe('/roadmap');
  });

  it('marks Roadmap active on /roadmap', () => {
    pathname = '/roadmap';
    renderWithIntl(<SidebarNav activeProject={PROJECT} projects={[PROJECT]} user={USER} />);
    expect(screen.getByRole('link', { name: 'Roadmap' }).getAttribute('aria-current')).toBe('page');
  });

  it('does not mark Roadmap active on /boards (and Boards is the active one there)', () => {
    pathname = '/boards';
    renderWithIntl(<SidebarNav activeProject={PROJECT} projects={[PROJECT]} user={USER} />);
    expect(screen.getByRole('link', { name: 'Roadmap' }).getAttribute('aria-current')).toBeNull();
    expect(screen.getByRole('link', { name: 'Boards' }).getAttribute('aria-current')).toBe('page');
  });

  it('renders the localized label (zh)', () => {
    renderWithIntl(<SidebarNav activeProject={PROJECT} projects={[PROJECT]} user={USER} />, {
      locale: 'zh',
      messages: zhMessages,
    });
    // zh: Roadmap = 路线图
    expect(screen.getByRole('link', { name: '路线图' }).getAttribute('href')).toBe('/roadmap');
  });
});
