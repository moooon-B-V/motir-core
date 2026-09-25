// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';

// The shared Mine / Project switch (Story MOTIR-6179 · design MOTIR-6327) — the
// one control Plans, Approval records and Runs all draw. Part of MOTIR-6336's
// coverage floor over the story's changed surfaces.

const push = vi.fn();
const nav = { pathname: '/approvals', search: 'page=3&x=1' };
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
  usePathname: () => nav.pathname,
  useSearchParams: () => new URLSearchParams(nav.search),
}));

const { RoomViewSwitch } = await import('@/components/rooms/RoomViewSwitch');

afterEach(() => {
  cleanup();
  push.mockClear();
});

describe('RoomViewSwitch', () => {
  it('draws Mine then Project, with the served view pressed', () => {
    renderWithIntl(<RoomViewSwitch value="mine" label="Approval records" />);
    const buttons = screen.getAllByRole('button');
    expect(buttons.map((b) => b.textContent)).toEqual(['Mine', 'Project']);
    expect(buttons[0]!.getAttribute('aria-pressed')).toBe('true');
    expect(buttons[1]!.getAttribute('aria-pressed')).toBe('false');
  });

  it('writes an explicit ?view=, drops the room’s drop params and keeps the rest', () => {
    renderWithIntl(<RoomViewSwitch value="mine" label="Approval records" drop={['page']} />);
    fireEvent.click(screen.getByRole('button', { name: 'Project' }));
    expect(push).toHaveBeenCalledTimes(1);
    const [href, opts] = push.mock.calls[0] as [string, { scroll: boolean }];
    const url = new URL(href, 'https://x.test');
    expect(url.pathname).toBe('/approvals');
    expect(url.searchParams.get('view')).toBe('project');
    expect(url.searchParams.has('page')).toBe(false);
    expect(url.searchParams.get('x')).toBe('1');
    expect(opts).toEqual({ scroll: false });
  });

  it('pressing the view already served navigates nowhere', () => {
    renderWithIntl(<RoomViewSwitch value="project" label="Runs" />);
    fireEvent.click(screen.getByRole('button', { name: 'Project' }));
    expect(push).not.toHaveBeenCalled();
  });

  it('with no drop list keeps every existing parameter', () => {
    renderWithIntl(<RoomViewSwitch value="project" label="Runs" />);
    fireEvent.click(screen.getByRole('button', { name: 'Mine' }));
    const url = new URL(push.mock.calls[0]![0] as string, 'https://x.test');
    expect(url.searchParams.get('view')).toBe('mine');
    expect(url.searchParams.get('page')).toBe('3');
  });
});
