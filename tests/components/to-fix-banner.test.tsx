// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { ToFixBanner } from '@/app/(authed)/items/[key]/_components/ToFixBanner';
import { LATE_FALLBACK_ATTR } from '@/app/(authed)/items/[key]/_components/decisionAnchor';
import type { FixDetailDto, WorkItemFixReasonDto } from '@/lib/dto/fixReason';
import zhMessages from '@/messages/zh.json';

// THE TO FIX BANNER (Story MOTIR-6589 · MOTIR-6611; design MOTIR-6608 panels 5
// and 6). One sentence per reason from the stored detail — with the fallbacks the
// detail allows — the copyable repair command from `fixDetail.repair`, and a link
// down to the Development block that waits for the late stack like the header
// marker does. A null reason or a done card draws nothing.

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

const BASE: FixDetailDto = {
  repair: 'fix',
  check: null,
  queueReason: null,
  base: null,
  reviewerName: null,
  notePreview: null,
  gate: null,
  affected: 1,
  total: 1,
};

function renderBanner(
  fixReason: WorkItemFixReasonDto | null,
  over: Partial<FixDetailDto> = {},
  opts: { statusCategory?: 'in_progress' | 'done'; locale?: 'zh' } = {},
) {
  return render(
    <ToFixBanner
      identifier="PROD-42"
      fixReason={fixReason}
      fixDetail={fixReason ? { ...BASE, ...over } : null}
      statusCategory={opts.statusCategory ?? 'in_progress'}
    />,
    opts.locale === 'zh' ? { locale: 'zh', messages: zhMessages } : {},
  );
}

function banner() {
  return screen.getByTestId('to-fix-banner');
}

describe('the sentence — one per reason, with the fallbacks the detail allows', () => {
  it.each([
    [
      'queue_failed',
      { check: 'e2e (board)' },
      'This needs a fix: it failed in the merge queue (check e2e (board)).',
    ],
    [
      'queue_failed',
      { queueReason: 'CI_TIMEOUT' },
      'This needs a fix: it failed in the merge queue (checks timed out).',
    ],
    [
      'queue_failed',
      { queueReason: 'SOMETHING_NEW' },
      'This needs a fix: it failed in the merge queue.',
    ],
    ['conflicted', { base: 'main' }, 'This needs a fix: it conflicts with main.'],
    ['conflicted', {}, 'This needs a fix: it conflicts with its base branch.'],
    ['ci_failed', { check: 'typecheck' }, 'This needs a fix: CI failed (check typecheck).'],
    ['ci_failed', {}, 'This needs a fix: CI failed.'],
    [
      'changes_requested',
      { repair: 'run', reviewerName: 'Ana Ruiz', notePreview: 'Double-counts a moved card.' },
      'This needs a fix: Ana Ruiz requested changes — “Double-counts a moved card.”',
    ],
    [
      'changes_requested',
      { repair: 'run', reviewerName: 'Ana Ruiz' },
      'This needs a fix: Ana Ruiz requested changes.',
    ],
    ['changes_requested', { repair: 'run' }, 'This needs a fix: changes were requested.'],
  ] as const)('%s %j', (reason, over, sentence) => {
    renderBanner(reason, over);
    expect(banner().querySelector('p')?.textContent).toBe(sentence);
    expect(banner().getAttribute('data-to-fix')).toBe(reason);
  });

  it('sets a check name and a base branch as inline code', () => {
    renderBanner('conflicted', { base: 'release/2.0' });
    expect(banner().querySelector('p code')?.textContent).toBe('release/2.0');
  });
});

describe('the command — from `fixDetail.repair`, never from the reason', () => {
  it('is `motir fix <KEY>` for a pull-request reason', () => {
    renderBanner('ci_failed', { check: 'lint' });
    expect(banner().querySelector('pre')?.textContent).toBe('motir fix PROD-42');
    expect(banner().textContent).toContain('Repair it with this command:');
  });

  it('is `motir run <KEY>` for an approve-to-merge Request changes', () => {
    renderBanner('changes_requested', { repair: 'run', reviewerName: 'Ana Ruiz' });
    expect(banner().querySelector('pre')?.textContent).toBe('motir run PROD-42');
    expect(banner().textContent).toContain('Re-run the work item.');
  });

  it('is `motir fix <KEY>` for an acceptance video sent back — and says where it came from', () => {
    renderBanner('changes_requested', {
      repair: 'fix',
      gate: 'acceptance_result',
      reviewerName: 'Ana Ruiz',
      affected: 2,
      total: 2,
    });
    expect(banner().querySelector('pre')?.textContent).toBe('motir fix PROD-42');
    expect(banner().textContent).toContain(
      'Sent back from the acceptance video. · 2 of 2 pull requests affected',
    );
  });

  it('names how many pull requests are affected only when there is more than one', () => {
    renderBanner('conflicted', { base: 'main', affected: 1, total: 2 });
    expect(banner().textContent).toContain('1 of 2 pull requests affected');
    cleanup();
    renderBanner('conflicted', { base: 'main' });
    expect(banner().textContent).not.toContain('pull requests affected');
  });
});

describe('when it draws nothing', () => {
  it('draws nothing for no reason', () => {
    renderBanner(null);
    expect(screen.queryByTestId('to-fix-banner')).toBeNull();
  });

  it('draws nothing on a done card, even with a stale reason', () => {
    renderBanner('ci_failed', { check: 'lint' }, { statusCategory: 'done' });
    expect(screen.queryByTestId('to-fix-banner')).toBeNull();
  });
});

describe('zh', () => {
  it('reads in Chinese; the command and the check stay as they are', () => {
    renderBanner('ci_failed', { check: 'typecheck' }, { locale: 'zh' });
    expect(banner().querySelector('p')?.textContent).toBe(
      '需要修复：CI 未通过（检查 typecheck）。',
    );
    expect(banner().querySelector('pre')?.textContent).toBe('motir fix PROD-42');
    expect(screen.getByRole('link', { name: '查看它的拉取请求' })).toBeTruthy();
  });
});

describe('See its pull requests — the link to the Development block', () => {
  it('is a real #development anchor', () => {
    renderBanner('conflicted', { base: 'main' });
    expect(screen.getByRole('link', { name: 'See its pull requests' }).getAttribute('href')).toBe(
      '#development',
    );
  });

  it('lands on the Development section when it is on the page, and focuses it', () => {
    const section = document.createElement('section');
    section.id = 'development';
    section.tabIndex = -1;
    const scroll = vi.fn();
    section.scrollIntoView = scroll;
    document.body.appendChild(section);
    renderBanner('conflicted', { base: 'main' });
    fireEvent.click(screen.getByRole('link', { name: 'See its pull requests' }));
    expect(scroll).toHaveBeenCalledWith(expect.objectContaining({ block: 'start' }));
    expect(document.activeElement).toBe(section);
  });

  it('waits for the late stack when the section has not streamed in yet', async () => {
    const fallback = document.createElement('div');
    fallback.setAttribute(LATE_FALLBACK_ATTR, '');
    fallback.scrollIntoView = vi.fn();
    document.body.appendChild(fallback);
    renderBanner('conflicted', { base: 'main' });
    const link = screen.getByRole('link', { name: 'See its pull requests' });
    fireEvent.click(link);
    expect(link.getAttribute('aria-busy')).toBe('true');
    expect(fallback.scrollIntoView).toHaveBeenCalled();

    const section = document.createElement('section');
    section.id = 'development';
    section.tabIndex = -1;
    section.scrollIntoView = vi.fn();
    await act(async () => {
      fallback.remove();
      document.body.appendChild(section);
      await Promise.resolve();
    });
    expect(section.scrollIntoView).toHaveBeenCalled();
    expect(link.getAttribute('aria-busy')).toBeNull();
  });
});

describe('its place on the page', () => {
  it('sits after the archived banner and before the pending-plan notice', () => {
    const view = readFileSync('app/(authed)/items/[key]/_view.tsx', 'utf8');
    const archived = view.indexOf('<ArchivedBanner');
    const toFix = view.indexOf('<ToFixBanner');
    const pending = view.indexOf('<PendingPlanNotice');
    expect(archived).toBeGreaterThan(-1);
    expect(toFix).toBeGreaterThan(archived);
    expect(pending).toBeGreaterThan(toFix);
  });

  it('the Development section carries the id the link lands on', () => {
    const late = readFileSync('app/(authed)/items/[key]/_components/LateSections.tsx', 'utf8');
    expect(late).toContain('id={DEVELOPMENT_SECTION_ID}');
  });
});
