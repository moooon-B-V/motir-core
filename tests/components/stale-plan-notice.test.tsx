// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';

vi.mock('next/navigation', () => ({
  usePathname: () => '/items/ACME-40',
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('@/lib/navigation/shallowUrl', () => ({ shallowPush: vi.fn(), shallowReplace: vi.fn() }));

import { renderWithIntl } from '../helpers/renderWithIntl';
import zhMessages from '@/messages/zh.json';
import { StalePlanNotice, type StalePlanNoticeProps } from '@/components/planning/StalePlanNotice';
import type { StalePlanFinishedCard } from '@/lib/planning/planSessionClientErrors';

// THE STALE-PLAN ANSWER (Story MOTIR-7928 · MOTIR-7932), drawn to MOTIR-7929's
// `planning-workspace--waiting-plan-carry.mock.html` state 10 and variants A–G.

function card(n: number): StalePlanFinishedCard {
  return { id: `w${n}`, key: `ACME-${n}`, title: `Card ${n}`, status: 'done', statusLabel: 'Done' };
}

const onPlanAgain = vi.fn();

function renderNotice(props: Partial<StalePlanNoticeProps> = {}, locale?: 'zh') {
  return renderWithIntl(
    <StalePlanNotice
      finishedCards={[card(41)]}
      onPlanAgain={onPlanAgain}
      pending={false}
      accepted={false}
      refused={false}
      {...props}
    />,
    locale ? { locale, messages: zhMessages } : {},
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('StalePlanNotice', () => {
  it('ONE finished item: the sentence names it as a chip, on the warning role', () => {
    renderNotice();
    const notice = screen.getByTestId('planning-stale-plan');
    expect(notice.getAttribute('role')).toBe('status');
    expect(notice.className).toContain('--el-tint-yellow');
    expect(notice.className).not.toContain('danger');
    expect(notice.textContent).toContain('This plan is out of date: ACME-41');
    expect(notice.textContent).toContain('was finished after the plan was made');
    const chip = screen.getByRole('link', { name: /ACME-41/ });
    expect(chip.getAttribute('href')).toContain('ACME-41');
    expect(chip.textContent).toContain('Card 41');
    expect(chip.textContent).toContain('Done');
  });

  it('TWO finished items are joined the way the locale lists things (variant A)', () => {
    renderNotice({ finishedCards: [card(41), card(43)] });
    const text = screen.getByTestId('planning-stale-plan').textContent ?? '';
    expect(text).toMatch(/ACME-41.*and.*ACME-43/);
    expect(text).toContain('were finished');
  });

  it('MORE than two: two are named and the rest counted (variant B)', () => {
    renderNotice({ finishedCards: [card(41), card(43), card(44), card(45)] });
    const text = screen.getByTestId('planning-stale-plan').textContent ?? '';
    expect(text).toContain('ACME-41');
    expect(text).toContain('ACME-43');
    expect(text).not.toContain('ACME-44');
    expect(text).toContain('2 more');
  });

  it('NO nameable item: the generic sentence (variant C)', () => {
    renderNotice({ finishedCards: [] });
    expect(screen.getByTestId('planning-stale-plan').textContent).toContain(
      'work it changes was finished',
    );
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('Plan it again is ONE primary action with its gloss', () => {
    renderNotice();
    expect(screen.getByTestId('planning-stale-plan').textContent).toContain(
      'Starts one new plan here from this conversation.',
    );
    fireEvent.click(screen.getByTestId('planning-plan-again'));
    expect(onPlanAgain).toHaveBeenCalledTimes(1);
  });

  it('PRESSED: disabled and busy, so a second press does nothing (variant D)', () => {
    renderNotice({ pending: true });
    const button = screen.getByTestId('planning-plan-again') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(button.textContent).toContain('Planning again…');
    fireEvent.click(button);
    expect(onPlanAgain).not.toHaveBeenCalled();
  });

  it('ACCEPTED: the sentence stays as history, the action becomes the writing line (variant E)', () => {
    renderNotice({ accepted: true, writing: true });
    expect(screen.queryByTestId('planning-plan-again')).toBeNull();
    expect(screen.getByTestId('planning-stale-plan').textContent).toContain('out of date');
    expect(screen.getByTestId('planning-stale-writing').textContent).toContain(
      'A new plan is being written',
    );
  });

  it('REFUSED as decided: the decide door’s stale-read words, no action', () => {
    renderNotice({ refused: true });
    expect(screen.queryByTestId('planning-plan-again')).toBeNull();
    expect(screen.getByTestId('planning-stale-refused').textContent).toContain(
      'Someone decided this a moment ago.',
    );
  });

  it('RESTORED before the press: says the plan is current again and nothing started (variant G)', () => {
    renderNotice({ restored: true });
    expect(screen.queryByTestId('planning-plan-again')).toBeNull();
    expect(screen.getByTestId('planning-stale-restored').textContent).toContain(
      'ACME-41 is open again, so this plan is current again. Nothing new was started.',
    );
  });

  it('zh: the same sentence in Chinese, and the action reads 重新规划', () => {
    renderNotice({}, 'zh');
    expect(screen.getByTestId('planning-stale-plan').textContent).toContain('此计划已过期：');
    expect(screen.getByTestId('planning-plan-again').textContent).toContain('重新规划');
  });
});
