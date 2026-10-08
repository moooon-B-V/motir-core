// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import zh from '@/messages/zh.json';
import type { ApprovalQueueRowDto } from '@/lib/dto/approvalGate';

// Story MOTIR-7730 · MOTIR-7771 — the surfaces that used to hard-code `en-US`,
// `en-GB`, `en` or the runtime default format dates and numbers in the reader's
// language. Raw `ja` / `de` tags work before those locales are turned on: the
// helpers pass the app's code straight to `Intl`.

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/workbench',
  useSearchParams: () => new URLSearchParams('tab=approvals'),
}));
vi.mock('@/lib/navigation/shallowUrl', () => ({ shallowPush: vi.fn(), shallowReplace: vi.fn() }));

const { bucketLabel: reportBucket } =
  await import('@/app/(authed)/reports/_components/ResolutionTimeReport');
const { bucketLabel: dashboardBucket } =
  await import('@/app/(authed)/dashboard/_components/CreatedVsResolvedBody');
const { formatAt } = await import('@/components/planning/PlanReviewRail');
const { fmt: billingNumber } =
  await import('@/app/(authed)/settings/organization/billing/_components/BillingClient');
const { formatRunInstant } = await import('@/lib/runs/runClock');
const { ApprovalRow } = await import('@/components/approvals/ApprovalRow');

afterEach(cleanup);

describe('dates and numbers follow the active locale (MOTIR-7771)', () => {
  it('the reports date helper writes Japanese and German day labels, not US ones', () => {
    expect(reportBucket('2026-10-07', 'day', 'ja')).toBe('10月7日');
    expect(reportBucket('2026-10-07', 'day', 'de')).toBe('7. Okt.');
    expect(reportBucket('2026-10-07', 'day', 'en')).toBe('Oct 7');
    expect(dashboardBucket('2026-10-07', 'day', 'de')).toBe('7. Okt.');
  });

  it('the plan-review rail date is in the reader’s language', () => {
    const iso = '2026-10-07T14:05:00Z';
    expect(formatAt(iso, 'de')).toMatch(/07\.10\.2026/);
    expect(formatAt(iso, 'ja')).toMatch(/2026\/10\/07/);
    expect(formatAt(iso, 'en')).toMatch(/Oct 7, 2026/);
  });

  it('a billing number groups thousands the German way', () => {
    expect(billingNumber(1234, 'de')).toBe('1.234');
    expect(billingNumber(1234, 'en')).toBe('1,234');
  });

  it('a run timestamp keeps its 24-hour clock in every language', () => {
    const iso = '2026-10-07T14:02:00Z';
    expect(formatRunInstant(iso, 'en')).toBe('Oct 7, 14:02 UTC');
    expect(formatRunInstant(iso, 'de')).toMatch(/^7\. Okt\., 14:02 UTC$/);
    expect(formatRunInstant(iso, 'ja')).toMatch(/10月7日 14:02 UTC$/);
  });

  it('an approvals row under zh carries its absolute timestamp in Chinese, not US', () => {
    const row = {
      gateId: 'gate-1',
      kind: 'decision_choice',
      state: 'awaiting',
      canDecide: true,
      routedToName: 'Yue',
      waitingSince: '2026-10-07T14:05:00Z',
      workItem: {
        id: 'wi-1',
        key: 61,
        identifier: 'ACME-61',
        title: '账单导出',
        kind: 'story',
        type: null,
      },
      subject: { kind: 'decision_choice', optionCount: 3, question: 'Which format?' },
    } as unknown as ApprovalQueueRowDto;
    const { container } = renderWithIntl(<ApprovalRow record={{ section: 'awaiting', row }} />, {
      locale: 'zh',
      messages: zh,
    });
    const titled = [...container.querySelectorAll('[title]')].map(
      (e) => e.getAttribute('title') ?? '',
    );
    const stamp = titled.find((t) => t.includes('2026'));
    expect(stamp).toBeDefined();
    expect(stamp).toMatch(/2026\/10\/7/);
    expect(stamp).not.toMatch(/10\/7\/2026/);
  });
});
