// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import en from '@/messages/en.json';
import zh from '@/messages/zh.json';
import type { MonitorIssueLinkDto } from '@/lib/dto/monitorIssueLink';
import { MONITOR_RESOLVE_STATES } from '@/lib/monitors/syncStates';

// THE ERRORS SECTION'S ROWS (Story MOTIR-4932 · Subtask MOTIR-5732), one test per
// state `design/monitoring/design-notes.md` §14 draws — panels 1–4, 8, 9 and 10.
// The linking doors are MOTIR-5744's and are not here.

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh, push: vi.fn() }) }));

const {
  ErrorRow,
  MonitorErrorsList,
  MonitorErrorsLoadFailed,
  canWriteErrors,
  errorMetaLine,
  errorsSectionState,
  levelPillProps,
} = await import('@/app/(authed)/items/[key]/_components/MonitorErrorsSection');

afterEach(() => {
  cleanup();
  refresh.mockReset();
});

const NOW = new Date('2026-09-19T12:00:00.000Z');
const m = en.monitorErrors;

function link(overrides: Partial<MonitorIssueLinkDto> = {}): MonitorIssueLinkDto {
  return {
    id: 'mi-1',
    title: 'Payment provider returned 502 Bad Gateway',
    level: 'error',
    culprit: 'lib/pay.ts',
    permalink: 'https://acme.sentry.io/issues/1/',
    eventCount: 40_112,
    firstSeenAt: '2026-09-01T00:00:00.000Z',
    lastSeenAt: '2026-09-19T11:57:00.000Z',
    environment: 'production',
    release: '2026.09.18-1',
    connection: { id: 'c1', orgSlug: 'acme', projectSlug: 'checkout-api' },
    resolve: { state: null, attemptedAt: null, resolvedAt: null, error: null },
    assigneeNote: null,
    ...overrides,
  };
}

function renderRow(l: MonitorIssueLinkDto) {
  return render(
    <ul>
      <ErrorRow link={l} />
    </ul>,
    { now: NOW },
  );
}

describe('panel 1 — one link', () => {
  it('renders title → permalink, meta line, level pill, grouped count, relative last seen and the out-link', () => {
    renderRow(link());
    const row = screen.getByTestId('error-row');
    const title = within(row).getByRole('link', {
      name: 'Payment provider returned 502 Bad Gateway',
    });
    expect(title.getAttribute('href')).toBe('https://acme.sentry.io/issues/1/');
    expect(title.getAttribute('target')).toBe('_blank');
    expect(title.getAttribute('rel')).toBe('noopener noreferrer');
    expect(row.textContent).toContain('acme / checkout-api · production · 2026.09.18-1');
    expect(within(row).getByTestId('error-level').textContent).toBe('error');
    // Decision 2: full precision, grouped, never compacted to "40k".
    expect(within(row).getByTestId('error-count').textContent).toBe('40,112');
    expect(row.textContent).toContain('Seen 40,112 times');
    expect(row.textContent).toContain('last seen 3 minutes ago');
    expect(within(row).getByRole('link', { name: m.openInSentry })).toBeTruthy();
  });

  it('says "time" for a count of one', () => {
    renderRow(link({ eventCount: 1 }));
    expect(screen.getByTestId('error-row').textContent).toContain('Seen 1 time');
  });

  it('shows the absolute last-seen time on hover', () => {
    renderRow(link());
    const lastSeen = screen.getByText('last seen 3 minutes ago');
    expect(lastSeen.getAttribute('title')).toMatch(/Sep 19, 2026/);
  });
});

describe('the identifier line omits what is absent — never "unknown"', () => {
  it.each([
    [{ environment: null, release: null }, 'acme / checkout-api'],
    [{ environment: 'staging', release: null }, 'acme / checkout-api · staging'],
    [{ environment: null, release: '1.4.2' }, 'acme / checkout-api · 1.4.2'],
    [
      { connection: { id: 'c1', orgSlug: null, projectSlug: 'checkout-api' } },
      'checkout-api · production · 2026.09.18-1',
    ],
  ] as const)('%o → %s', (overrides, expected) => {
    expect(errorMetaLine(link(overrides as Partial<MonitorIssueLinkDto>))).toBe(expected);
  });

  it('renders the absent case with no placeholder word', () => {
    renderRow(link({ environment: null, release: null }));
    const row = screen.getByTestId('error-row');
    expect(row.textContent).not.toMatch(/unknown/i);
    expect(row.textContent).toContain('acme / checkout-api');
  });
});

describe('Decision 3 — the level pill', () => {
  it.each([
    ['fatal', { severity: 'danger' }],
    ['error', { severity: 'danger' }],
    ['warning', { severity: 'warning' }],
    ['info', { severity: 'info' }],
    ['debug', { tone: 'neutral' }],
    ['fatalish', { tone: 'neutral' }],
    [null, null],
  ] as const)('%s → %o', (level, props) => {
    expect(levelPillProps(level)).toEqual(props);
  });

  it('an unrecognised level renders VERBATIM in a neutral pill, and a null level renders no pill', () => {
    renderRow(link({ level: 'fatalish' }));
    expect(screen.getByTestId('error-level').textContent).toBe('fatalish');
    cleanup();
    renderRow(link({ level: null }));
    expect(screen.queryByTestId('error-level')).toBeNull();
  });
});

describe('panel 3 — one resolve line per resolve.state value', () => {
  it('covers every member of the closed union plus null', () => {
    // A new member added to the vocabulary must be given a line here too.
    expect([...MONITOR_RESOLVE_STATES].sort()).toEqual(['failed', 'gone', 'pending', 'resolved']);
  });

  it('null draws nothing', () => {
    renderRow(link());
    expect(screen.getByTestId('error-row').querySelector('[data-note^="resolve"]')).toBeNull();
  });

  it('pending: "Resolving in Sentry…"', () => {
    renderRow(
      link({
        resolve: {
          state: 'pending',
          attemptedAt: NOW.toISOString(),
          resolvedAt: null,
          error: null,
        },
      }),
    );
    expect(document.querySelector('[data-note="resolve-pending"]')?.textContent).toBe(
      m.resolve.pending,
    );
  });

  it('resolved: names Motir and WHEN, relative with the absolute on hover', () => {
    renderRow(
      link({
        resolve: {
          state: 'resolved',
          attemptedAt: '2026-09-19T11:55:00.000Z',
          resolvedAt: '2026-09-19T11:56:00.000Z',
          error: null,
        },
      }),
    );
    const note = document.querySelector('[data-note="resolve-resolved"]')!;
    expect(note.textContent).toBe('Resolved in Sentry by Motir 4 minutes ago');
    expect(
      within(note as HTMLElement)
        .getByText('4 minutes ago')
        .getAttribute('title'),
    ).toMatch(/2026/);
  });

  it('failed: the provider reason VERBATIM and "Tried <when>" from attemptedAt, on the warning surface', () => {
    renderRow(
      link({
        resolve: {
          state: 'failed',
          attemptedAt: '2026-09-19T11:51:00.000Z',
          resolvedAt: null,
          error: '403 You do not have permission to perform this action.',
        },
      }),
    );
    const note = document.querySelector('[data-note="resolve-failed"]')!;
    expect(note.textContent).toBe(
      "Couldn't resolve this in Sentry: 403 You do not have permission to perform this action. Tried 9 minutes ago — Motir tries again at the next check.",
    );
    expect(note.className).toContain('bg-(--el-warning-surface)');
  });

  it('gone: stays listed, muted, NOT a link, no out-link, and says so', () => {
    renderRow(
      link({ resolve: { state: 'gone', attemptedAt: null, resolvedAt: null, error: null } }),
    );
    const row = screen.getByTestId('error-row');
    expect(row.className).toContain('bg-(--el-surface-soft)');
    expect(within(row).queryByRole('link')).toBeNull();
    expect(within(row).getByText('Payment provider returned 502 Bad Gateway').className).toContain(
      'text-(--el-text-secondary)',
    );
    expect(document.querySelector('[data-note="resolve-gone"]')?.textContent).toBe(
      'Sentry no longer has this error. Its facts are as they were last seen.',
    );
  });
});

describe('panel 4 — the assignee note', () => {
  it.each([
    ['team_assignee', m.assignee.teamAssignee],
    ['no_matching_member', m.assignee.noMatch],
  ] as const)('%s renders its quiet line', (note, copy) => {
    renderRow(link({ assigneeNote: note }));
    expect(document.querySelector(`[data-note="assignee-${note}"]`)?.textContent).toBe(copy);
  });

  it('with both, the resolve line comes first and the note second', () => {
    renderRow(
      link({
        assigneeNote: 'team_assignee',
        resolve: {
          state: 'pending',
          attemptedAt: NOW.toISOString(),
          resolvedAt: null,
          error: null,
        },
      }),
    );
    const notes = [...document.querySelectorAll('[data-note]')].map((n) =>
      n.getAttribute('data-note'),
    );
    expect(notes).toEqual(['resolve-pending', 'assignee-team_assignee']);
  });
});

describe('Decision 5 — who sees the write controls', () => {
  it.each([
    [true, true, true],
    [true, false, false],
    [false, true, false],
    [false, false, false],
  ])('canEdit=%s, hasConnection=%s → %s', (canEdit, hasConnection, expected) => {
    expect(canWriteErrors(canEdit, hasConnection)).toBe(expected);
  });

  it.each([true, false])(
    'the × follows canWrite=%s, and the rows render either way',
    (canWrite) => {
      render(
        <MonitorErrorsList
          links={[link()]}
          canWrite={canWrite}
          unlinkAction={vi.fn()}
          workItemId="wi"
          identifier="ACME-1"
        />,
        { now: NOW },
      );
      expect(screen.getAllByTestId('error-row')).toHaveLength(1);
      const x = screen.queryByRole('button', {
        name: m.unlink.aria.replace('{title}', 'Payment provider returned 502 Bad Gateway'),
      });
      expect(x !== null).toBe(canWrite);
    },
  );
});

describe('the section’s own state — panels 5a and 10', () => {
  it.each([
    [null, true, 'failed'],
    [null, false, 'hidden'],
    [[], true, 'hidden'],
    [[], false, 'hidden'],
  ] as const)('links=%o, hasConnection=%s → %s', (links, hasConnection, expected) => {
    expect(errorsSectionState(links as MonitorIssueLinkDto[] | null, hasConnection)).toBe(expected);
  });

  it('any link → rows', () => {
    expect(errorsSectionState([link()], false)).toBe('rows');
  });

  it('a failed read names itself, with a retry that refreshes the page', () => {
    render(<MonitorErrorsLoadFailed />);
    expect(screen.getByText(m.loadFailedTitle)).toBeTruthy();
    expect(screen.getByText(m.loadFailedBody)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: en.common.retry }));
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});

describe('panel 8 — unlink', () => {
  const aria = m.unlink.aria.replace('{title}', 'Payment provider returned 502 Bad Gateway');

  type UnlinkAction = Parameters<typeof MonitorErrorsList>[0]['unlinkAction'];
  function renderList(unlinkAction: UnlinkAction) {
    render(
      <MonitorErrorsList
        links={[link()]}
        canWrite
        unlinkAction={unlinkAction}
        workItemId="wi-1"
        identifier="ACME-1"
      />,
      { now: NOW },
    );
    fireEvent.click(screen.getByRole('button', { name: aria }));
  }

  it('the confirm states the CONSEQUENCE, and confirming unlinks and refreshes', async () => {
    const unlinkAction = vi.fn(async () => ({ ok: true as const, removed: true }));
    renderList(unlinkAction);
    expect(document.body.textContent).toContain(
      'Remove the link to Payment provider returned 502 Bad Gateway? If this error happens again, a new bug will be filed for it.',
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: m.unlink.action }));
    });
    expect(unlinkAction).toHaveBeenCalledWith({
      workItemId: 'wi-1',
      identifier: 'ACME-1',
      monitorIssueId: 'mi-1',
    });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('removed: false is NOT a silent success — it says there was nothing to unlink', async () => {
    renderList(vi.fn(async () => ({ ok: true as const, removed: false })));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: m.unlink.action }));
    });
    expect(screen.getByRole('alert').textContent).toBe(m.unlink.nothing);
    expect(refresh).not.toHaveBeenCalled();
  });

  it.each([
    [{ ok: false, code: 'forbidden' }, m.error.forbidden],
    [{ ok: false, code: 'not_found' }, m.error.notFound],
    [{ ok: false, code: 'provider_failed', reason: 'boom' }, 'The link could not be removed: boom'],
  ] as const)('a refusal %o shows its line', async (result, copy) => {
    renderList(vi.fn(async () => result) as UnlinkAction);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: m.unlink.action }));
    });
    expect(screen.getByRole('alert').textContent).toBe(copy);
  });
});

describe('locales', () => {
  function keys(obj: unknown, prefix = ''): string[] {
    if (typeof obj !== 'object' || obj === null) return [prefix];
    return Object.entries(obj).flatMap(([k, v]) => keys(v, prefix ? `${prefix}.${k}` : k));
  }

  it('every monitorErrors key this section uses exists in both en and zh', () => {
    expect(keys(zh.monitorErrors).sort()).toEqual(keys(en.monitorErrors).sort());
  });

  it('renders in zh', () => {
    render(
      <ul>
        <ErrorRow link={link()} />
      </ul>,
      { now: NOW, locale: 'zh', messages: zh },
    );
    expect(screen.getByTestId('error-row').textContent).toContain('出现 40,112 次');
  });
});

describe('the remaining row arms', () => {
  it('a live issue with no permalink: the title is plain text and the out-link is a spacer', () => {
    renderRow(link({ permalink: null }));
    const row = screen.getByTestId('error-row');
    expect(within(row).queryByRole('link')).toBeNull();
    expect(within(row).getByText('Payment provider returned 502 Bad Gateway').className).toContain(
      'text-(--el-text)',
    );
  });

  it('resolve lines written without their timestamps (none is) still read as sentences', () => {
    renderRow(
      link({ resolve: { state: 'resolved', attemptedAt: null, resolvedAt: null, error: null } }),
    );
    expect(document.querySelector('[data-note="resolve-resolved"]')?.textContent).toBe(
      'Resolved in Sentry by Motir ',
    );
    cleanup();
    renderRow(
      link({ resolve: { state: 'failed', attemptedAt: null, resolvedAt: null, error: null } }),
    );
    expect(document.querySelector('[data-note="resolve-failed"]')?.textContent).toBe(
      "Couldn't resolve this in Sentry:  Tried  — Motir tries again at the next check.",
    );
  });

  it('unlink: Cancel and Escape both close the confirm without unlinking', async () => {
    const unlinkAction = vi.fn();
    render(
      <MonitorErrorsList
        links={[link()]}
        canWrite
        unlinkAction={unlinkAction}
        workItemId="wi-1"
        identifier="ACME-1"
      />,
      { now: NOW },
    );
    const aria = m.unlink.aria.replace('{title}', 'Payment provider returned 502 Bad Gateway');
    fireEvent.click(screen.getByRole('button', { name: aria }));
    fireEvent.click(await screen.findByRole('button', { name: en.common.cancel }));
    await vi.waitFor(() =>
      expect(screen.queryByRole('button', { name: m.unlink.action })).toBeNull(),
    );
    fireEvent.click(screen.getByRole('button', { name: aria }));
    fireEvent.keyDown(await screen.findByRole('button', { name: m.unlink.action }), {
      key: 'Escape',
    });
    await vi.waitFor(() =>
      expect(screen.queryByRole('button', { name: m.unlink.action })).toBeNull(),
    );
    expect(unlinkAction).not.toHaveBeenCalled();
  });
});
