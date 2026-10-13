// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import enMessages from '@/messages/en.json';
import zhMessages from '@/messages/zh.json';
import {
  MARKER_WORD,
  PlanProgressLineView,
  type MarkerState,
  type PlanProgressDensity,
} from '@/components/planning/PlanProgressLine';
import { PlanActRecord } from '@/components/planning/PlanActRecord';
import { readPlanProgress, type PlanProgressSnapshot } from '@/lib/plans/planProgress';
import type { PlanProgressClockReading } from '@/lib/hooks/usePlanProgressReading';

// Story MOTIR-8301 · MOTIR-8309 — the RESUMING state of the progress line, and the rail's one
// row (design `design/ai-planning/design-notes.md` Part XXVII §27.2–27.4, §27.7, §27.9). The
// view is driven by a READING built through the one derivation, so nothing here compares a clock.

const T = Date.parse('2026-10-12T14:00:00.000Z');
const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

type Locale = 'en' | 'zh';
const MESSAGES = { en: enMessages, zh: zhMessages } as const;

function resumingReading(count = 1, nowMs = T + MIN): PlanProgressClockReading {
  const snapshot: PlanProgressSnapshot = {
    startedAt: iso(T - 20 * MIN),
    lastActivityAt: iso(T),
    observedAt: iso(T),
    authored: 2,
    proposed: 5,
    steps: [],
    autoResume: { at: iso(T), count },
  };
  const reading = { ...readPlanProgress(snapshot, nowMs), serverNowMs: nowMs };
  expect(reading.state).toBe('resuming');
  return reading;
}

function mount(
  reading: PlanProgressClockReading,
  opts: { density?: PlanProgressDensity; locale?: Locale; failing?: boolean } = {},
) {
  const locale = opts.locale ?? 'en';
  return renderWithIntl(
    <PlanProgressLineView
      reading={reading}
      density={opts.density ?? 'pane'}
      failing={opts.failing ?? false}
    />,
    { locale, messages: MESSAGES[locale] },
  );
}

const WORD = { en: 'Resuming', zh: '正在继续' } as const;
const REASON = { en: 'picking up where it stopped', zh: '从中断处接着写' } as const;

afterEach(() => cleanup());

describe.each(['en', 'zh'] as const)('the resuming line — %s', (locale) => {
  it('pane: the marker word inside the one status region, the reason, no step words', () => {
    mount(resumingReading(), { locale });
    const statuses = screen.getAllByRole('status');
    expect(statuses).toHaveLength(1);
    expect(statuses[0]!.textContent).toBe(WORD[locale]);
    expect(screen.getByTestId('plan-live-state').getAttribute('data-state')).toBe('resuming');
    expect(screen.getByTestId('plan-progress-reason').textContent).toBe(REASON[locale]);
    expect(screen.queryByTestId('plan-progress-steps')).toBeNull();
  });

  it('compact: the state word leads, then the reason; nothing is live', () => {
    mount(resumingReading(), { locale, density: 'compact' });
    const row = screen.getByTestId('plan-progress-compact');
    expect(row.getAttribute('data-state')).toBe('resuming');
    expect(row.textContent).toContain(WORD[locale]);
    expect(row.textContent).toContain(REASON[locale]);
    expect(screen.queryAllByRole('status')).toHaveLength(0);
    expect(screen.queryByTestId('plan-progress-steps')).toBeNull();
  });
});

describe('the resuming line — the second attempt and the popover', () => {
  it('the second-attempt segment appears only for the second automatic resume', () => {
    const first = mount(resumingReading(1));
    expect(screen.getByTestId('plan-progress').textContent).not.toContain('second attempt');
    first.unmount();
    mount(resumingReading(2));
    expect(screen.getByTestId('plan-progress').textContent).toContain('second attempt');
  });

  it('the popover says what happened and when it was resumed', async () => {
    mount(resumingReading(1));
    await act(async () => {
      fireEvent.click(screen.getByTestId('plan-progress'));
    });
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('Picking up where it stopped');
    expect(screen.getByTestId('plan-progress-resuming').textContent).toContain(
      'The machine writing this plan was lost.',
    );
    const resumedAt = screen.getByTestId('plan-progress-resumed-at').textContent ?? '';
    expect(resumedAt).toMatch(/^Resumed automatically at \d{2}:\d{2}:\d{2}$/);
    expect(dialog.textContent).not.toContain('Working on now');
  });

  it('the popover names the second attempt only on the second resume', async () => {
    mount(resumingReading(2));
    await act(async () => {
      fireEvent.click(screen.getByTestId('plan-progress'));
    });
    await screen.findByRole('dialog');
    expect(screen.getByTestId('plan-progress-resumed-at').textContent).toMatch(
      / · second attempt$/,
    );
  });

  it('a dropped read still reads Reconnecting over resuming', () => {
    mount(resumingReading(), { failing: true });
    expect(screen.getByTestId('plan-live-state').getAttribute('data-state')).toBe('reconnecting');
    expect(screen.getByRole('status').textContent).toBe('Reconnecting — showing the last update');
  });

  it('every marker state has a word, in both locales', () => {
    const states: MarkerState[] = ['starting', 'writing', 'resuming', 'stalled', 'reconnecting'];
    expect(Object.keys(MARKER_WORD).sort()).toEqual([...states].sort());
    for (const messages of [enMessages, zhMessages]) {
      const planReview = messages.planReview as Record<string, unknown>;
      for (const state of states) expect(planReview[MARKER_WORD[state]]).toBeTruthy();
    }
  });
});

describe('the rail’s resume row (§27.7)', () => {
  it('opens the act record with the resume line, from the session’s record', () => {
    renderWithIntl(<PlanActRecord acts={[]} streaming={false} autoResume={{ count: 1 }} />, {
      locale: 'en',
      messages: enMessages,
    });
    expect(screen.getByTestId('plan-change-act-resumed').textContent).toContain(
      'Lost its machine — Motir started it again and it picks up where it stopped',
    );
  });

  it('says the second automatic attempt in words, and nothing without a resume', () => {
    const second = renderWithIntl(
      <PlanActRecord acts={[]} streaming={false} autoResume={{ count: 2 }} />,
      { locale: 'zh', messages: zhMessages },
    );
    expect(screen.getByTestId('plan-change-act-resumed').textContent).toContain(
      '机器再次丢失 — 第二次自动尝试，从中断处继续',
    );
    second.unmount();
    renderWithIntl(<PlanActRecord acts={[]} streaming={false} />, {
      locale: 'en',
      messages: enMessages,
    });
    expect(screen.queryByTestId('plan-change-act-resumed')).toBeNull();
  });
});
