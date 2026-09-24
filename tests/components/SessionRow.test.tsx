// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';

const { shallowPush } = vi.hoisted(() => ({ shallowPush: vi.fn() }));
vi.mock('@/lib/navigation/shallowUrl', () => ({ shallowPush }));
vi.mock('next/navigation', () => ({
  usePathname: () => '/plans',
  useSearchParams: () => new URLSearchParams('planState=none'),
}));

import { renderWithIntl } from '../helpers/renderWithIntl';
import { SessionRow } from '@/app/(authed)/plans/_components/SessionRow';
import type { SessionRowView } from '@/app/(authed)/plans/_components/types';

// MOTIR-6025 — one Plans-list row, ONE CONVERSATION (design Part XIX §19.2–§19.3a).

afterEach(() => {
  cleanup();
  shallowPush.mockReset();
});

function view(over: Partial<SessionRowView> = {}): SessionRowView {
  return {
    id: 's_1',
    origin: 'conversation',
    title: 'Split invoicing out of billing',
    targetKeys: ['MOTIR-812'],
    activeLabel: '12 minutes ago',
    startedByName: 'Mara Lind',
    latestPlan: { id: 'p_31', status: 'planned' },
    planCount: 2,
    ...over,
  };
}

const row = () => document.querySelector('.relative.flex')!;

describe('the two destinations (§19.2 change 2–3)', () => {
  it('the TITLE opens the conversation over this page, filter kept, by its id', () => {
    renderWithIntl(<SessionRow view={view()} />);

    const link = screen.getByRole('link', { name: 'Split invoicing out of billing' });
    const href = new URL(link.getAttribute('href')!, 'http://x');
    expect(href.pathname).toBe('/plans');
    expect(href.searchParams.get('planState')).toBe('none');
    expect(href.searchParams.get('planSession')).toBe('s_1');
    expect(href.searchParams.get('planItem')).toBe('MOTIR-812');

    fireEvent.click(link);
    expect(shallowPush).toHaveBeenCalledWith(link.getAttribute('href'));
  });

  it('a project-wide conversation opens the project overlay', () => {
    renderWithIntl(<SessionRow view={view({ targetKeys: [] })} />);
    const href = new URL(screen.getAllByRole('link')[0]!.getAttribute('href')!, 'http://x');
    expect(href.searchParams.get('planFrom')).toBe('project');
    expect(href.searchParams.get('planSession')).toBe('s_1');
    expect(href.searchParams.get('planItem')).toBeNull();
  });

  it('the CHIP is a separate link to the plan, named for its state', () => {
    renderWithIntl(<SessionRow view={view()} />);
    const chip = screen.getByRole('link', { name: 'Open the plan — Waiting for approval' });
    expect(chip.getAttribute('href')).toBe('/plans/p_31');
    expect(chip.className).toContain('z-10');
  });

  it('`No plan yet` is a plain chip — no plan link, no fresh-start control (§19.3a)', () => {
    renderWithIntl(<SessionRow view={view({ latestPlan: null, planCount: 0 })} />);
    expect(screen.getAllByRole('link')).toHaveLength(1);
    expect(screen.getByText('No plan yet')).toBeTruthy();
    expect(screen.queryByText(/Plan with AI/)).toBeNull();
  });
});

describe('the chip map is TOTAL (§19.3)', () => {
  // ⚠️ AMENDED by Story MOTIR-6043 · MOTIR-6045 (design Part XXI §21.5), and the
  // amendment is deliberately NARROW: what this block is FOR is that every plan
  // status gets its own chip LABEL, and that is asserted unchanged below. What
  // moved is whether the chip is also a LINK — it is now, and only, where the
  // row's own door goes somewhere else. So the two decided statuses assert the
  // label and the ABSENCE of the door, and the detector that used to live in
  // this `getByRole('link')` is preserved inverted, here and in
  // `plan-row-destination-agreement.test.tsx`'s own chip-rule block.
  it.each([
    ['generating', 'Writing', true],
    ['planned', 'Waiting for approval', true],
    ['stale', 'Stale', true],
    ['approved', 'Approved', false],
    ['declined', 'Declined', false],
  ] as const)('%s → %s (chip is a door: %s)', (status, label, isDoor) => {
    renderWithIntl(<SessionRow view={view({ latestPlan: { id: 'p', status } })} />);
    expect(screen.getByText(label)).toBeTruthy();
    const door = screen.queryByRole('link', { name: `Open the plan — ${label}` });
    if (isDoor) expect(door).toBeTruthy();
    else expect(door).toBeNull();
  });

  it('only `Waiting for approval` carries the accent border', () => {
    renderWithIntl(<SessionRow view={view({ latestPlan: { id: 'p', status: 'approved' } })} />);
    expect(row().className).toContain('border-(--el-border)');
    cleanup();
    renderWithIntl(<SessionRow view={view()} />);
    expect(row().className).toContain('border-(--el-accent)');
  });

  it('`+N earlier plans` precedes the chip only when there was more than one', () => {
    renderWithIntl(<SessionRow view={view({ planCount: 3 })} />);
    expect(screen.getByText('+2 earlier plans')).toBeTruthy();
    cleanup();
    renderWithIntl(<SessionRow view={view({ planCount: 1 })} />);
    expect(screen.queryByText(/earlier plan/)).toBeNull();
  });
});

describe('the meta line', () => {
  it('names the anchor, the last activity and the starter', () => {
    renderWithIntl(<SessionRow view={view()} />);
    expect(screen.getByText('MOTIR-812')).toBeTruthy();
    expect(screen.getByText('active 12 minutes ago')).toBeTruthy();
    expect(screen.getByTitle('Mara Lind').textContent).toBe('Mara Lind');
  });

  it('collapses many anchors to `first +N`, the full set in its title', () => {
    renderWithIntl(<SessionRow view={view({ targetKeys: ['A-1', 'A-2', 'A-3'] })} />);
    expect(screen.getByTitle('A-1, A-2, A-3').textContent).toBe('A-1 +2');
  });

  it('reads `Whole project` with no anchor', () => {
    renderWithIntl(<SessionRow view={view({ targetKeys: [] })} />);
    expect(screen.getByText('Whole project')).toBeTruthy();
  });

  it('names the ORIGIN for every door but a conversation', () => {
    renderWithIntl(<SessionRow view={view({ origin: 'mcp' })} />);
    expect(screen.getByText('Agent plan')).toBeTruthy();
    cleanup();
    renderWithIntl(<SessionRow view={view()} />);
    expect(screen.queryByText('Agent plan')).toBeNull();
  });

  it('a cadence session has no starter and reads its label alone', () => {
    renderWithIntl(<SessionRow view={view({ origin: 'cadence', startedByName: null })} />);
    const meta = screen.getByText('Auto-planned').parentElement!;
    expect(within(meta).queryByText('·')).toBeNull();
  });

  it('a conversation whose starter left renders no starter entry at all', () => {
    renderWithIntl(<SessionRow view={view({ startedByName: null })} />);
    expect(document.querySelector('b')).toBeNull();
  });

  it('an untitled session still has a name to click', () => {
    renderWithIntl(<SessionRow view={view({ title: '' })} />);
    expect(screen.getByRole('link', { name: 'Untitled conversation' })).toBeTruthy();
  });

  it.each(['generation', 'expand', 'legacy'] as const)('origin %s is labelled', (origin) => {
    renderWithIntl(<SessionRow view={view({ origin })} />);
    const label = { generation: 'Generated plan', expand: 'Expanded plan', legacy: 'Earlier plan' };
    expect(screen.getByText(label[origin])).toBeTruthy();
  });
});
