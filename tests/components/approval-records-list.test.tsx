// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import type {
  ApprovalQueueRowDto,
  ApprovalRecordDecidedRowDto,
  ApprovalRecordsPageDto,
} from '@/lib/dto/approvalGate';
import { canOfferNavDestination, PROJECT_NAV_ACCESS } from '@/lib/settings/projectNavAccess';

// THE APPROVAL RECORDS ROOM's LIST (Story MOTIR-5299 · MOTIR-5302), built to
// `design/approvals/design-notes.md`.
//
// What this file holds in place:
//
//   · the two sections, pending ABOVE decided, each with its heading and its total;
//   · the PERSON cell exists only when the read says `fullView` — the list never
//     re-checks a permission, so this is the only input that can add it;
//   · a decided row names WHICH version was decided, and its state pill;
//   · the three empty states, none of them permission-shaped;
//   · every row is the ONE approvals row, and opens the same overlay the tab does;
//   · the door: `/approvals` is `browse-only` in the one nav map.

const { push, shallowPush } = vi.hoisted(() => ({ push: vi.fn(), shallowPush: vi.fn() }));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push }),
  usePathname: () => '/approvals',
  useSearchParams: () => new URLSearchParams(''),
}));
vi.mock('@/lib/navigation/shallowUrl', () => ({ shallowPush, shallowReplace: vi.fn() }));

const { ApprovalRecordsList, approvalRecordsHref } =
  await import('../../app/(authed)/approvals/_components/ApprovalRecordsList');

const SUBJECT = {
  kind: 'design_result' as const,
  designEvidenceId: 'ev-1',
  producedByKey: 'MOTIR-5300',
  commitSha: 'aaaaaaaa1111',
  assetCount: 2,
  noteExcerpt: 'The room.',
};

function awaitingRow(over: Partial<ApprovalQueueRowDto> = {}): ApprovalQueueRowDto {
  return {
    gateId: 'gate-a',
    kind: 'design_result',
    state: 'awaiting',
    canDecide: true,
    routedToName: 'Mara Member',
    waitingSince: new Date(Date.now() - 3 * 86_400_000).toISOString(),
    workItem: {
      id: 'wi-a',
      key: 1,
      identifier: 'MOTIR-1',
      title: 'Pending thing',
      kind: 'subtask',
      type: 'design',
    },
    subject: SUBJECT,
    ...over,
  };
}

function decidedRow(over: Partial<ApprovalRecordDecidedRowDto> = {}): ApprovalRecordDecidedRowDto {
  return {
    gateId: 'gate-d',
    kind: 'design_result',
    state: 'changes_requested',
    decidedAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
    decidedByLabel: 'Otto Other <otto@ex.com>',
    subjectVersion: 'b33c4e45d0f9e8',
    waitingSince: new Date(Date.now() - 5 * 86_400_000).toISOString(),
    workItem: {
      id: 'wi-d',
      key: 2,
      identifier: 'MOTIR-2',
      title: 'Decided thing',
      kind: 'subtask',
      type: 'design',
    },
    subject: SUBJECT,
    ...over,
  };
}

function page(over: Partial<ApprovalRecordsPageDto> = {}): ApprovalRecordsPageDto {
  return {
    fullView: false,
    sections: {
      awaiting: { items: [awaitingRow()], total: 1 },
      decided: { items: [decidedRow()], total: 1 },
    },
    total: 2,
    page: 1,
    pageSize: 25,
    ...over,
  };
}

beforeEach(() => {
  push.mockReset();
  shallowPush.mockReset();
});
afterEach(cleanup);

describe('the two sections', () => {
  it('draws Awaiting a decision ABOVE Decided, each with its section total', () => {
    renderWithIntl(<ApprovalRecordsList records={page()} />);
    const headers = screen.getAllByRole('columnheader').map((h) => h.textContent);
    const awaitingAt = headers.findIndex((h) => h?.startsWith('Awaiting a decision'));
    const decidedAt = headers.findIndex((h) => h?.startsWith('Decided'));
    expect(awaitingAt).toBeGreaterThanOrEqual(0);
    expect(decidedAt).toBeGreaterThan(awaitingAt);
    expect(headers[awaitingAt]).toBe('Awaiting a decision1');

    const awaiting = screen.getByTestId('approval-records-awaiting');
    const decided = screen.getByTestId('approval-records-decided');
    expect(within(awaiting).getByText('Pending thing')).toBeTruthy();
    expect(within(decided).getByText('Decided thing')).toBeTruthy();
  });

  it('a decided row names the version it was decided on, and its state — never "Approved" for changes', () => {
    renderWithIntl(<ApprovalRecordsList records={page()} />);
    const decided = screen.getByTestId('approval-records-decided');
    expect(within(decided).getByText('b33c4e45')).toBeTruthy();
    expect(within(decided).getByText('b33c4e45').closest('[title]')?.getAttribute('title')).toBe(
      'b33c4e45d0f9e8',
    );
    expect(within(decided).getByText('Changes requested')).toBeTruthy();
    expect(within(decided).queryByRole('button', { name: 'Review' })).toBeNull();
  });

  it('a decided row with no recorded version says so rather than rendering blank', () => {
    const records = page({
      sections: {
        awaiting: { items: [], total: 0 },
        decided: { items: [decidedRow({ subjectVersion: null, state: 'approved' })], total: 1 },
      },
      total: 1,
    });
    renderWithIntl(<ApprovalRecordsList records={records} />);
    expect(screen.getByText('no version')).toBeTruthy();
    expect(screen.getByText('Approved')).toBeTruthy();
  });

  it('renders an empty section as a heading with 0 and its line — both headings stay', () => {
    const records = page({
      sections: {
        awaiting: { items: [], total: 0 },
        decided: { items: [decidedRow()], total: 1 },
      },
      total: 1,
    });
    renderWithIntl(<ApprovalRecordsList records={records} />);
    expect(screen.getByText('Nothing is waiting on you.')).toBeTruthy();
    expect(screen.getByText('Decided thing')).toBeTruthy();
  });

  it('a page starting inside the decided half draws only the Decided heading', () => {
    const records = page({
      sections: {
        awaiting: { items: [], total: 2 },
        decided: { items: [decidedRow()], total: 3 },
      },
      total: 5,
      page: 2,
      pageSize: 2,
    });
    renderWithIntl(<ApprovalRecordsList records={records} />);
    expect(screen.queryByTestId('approval-records-awaiting')).toBeNull();
    expect(screen.getByTestId('approval-records-decided')).toBeTruthy();
  });
});

describe('the PERSON cell follows the read’s `fullView`, and nothing else', () => {
  it('is absent for a reader whose read was not the full view', () => {
    renderWithIntl(<ApprovalRecordsList records={page({ fullView: false })} />);
    expect(screen.queryByText('Otto Other <otto@ex.com>')).toBeNull();
    expect(screen.queryByText('Decided by')).toBeNull();
  });

  it('names who was asked and who decided in the full view, with No one for nobody', () => {
    const records = page({
      fullView: true,
      sections: {
        awaiting: { items: [awaitingRow({ routedToName: null })], total: 1 },
        decided: { items: [decidedRow()], total: 1 },
      },
    });
    renderWithIntl(<ApprovalRecordsList records={records} />);
    expect(screen.getByText('Otto Other <otto@ex.com>')).toBeTruthy();
    expect(screen.getByText('No one')).toBeTruthy();
    expect(screen.getAllByText('Decided by').length).toBeGreaterThan(0);
  });

  it('uses the full-view grid only in the full view', () => {
    const { unmount } = renderWithIntl(<ApprovalRecordsList records={page({ fullView: true })} />);
    expect(screen.getByTestId('approval-row-gate-d').getAttribute('style')).toContain('228px');
    unmount();
    renderWithIntl(<ApprovalRecordsList records={page({ fullView: false })} />);
    expect(screen.getByTestId('approval-row-gate-d').getAttribute('style')).toContain('268px');
  });
});

describe('every row is the ONE approvals row, and its door is the overlay', () => {
  it('a pending row opens the overlay over this page, as the tab’s row does', () => {
    renderWithIntl(<ApprovalRecordsList records={page()} />);
    fireEvent.click(screen.getByRole('link', { name: /^Review MOTIR-1 / }), { button: 0 });
    expect(shallowPush).toHaveBeenCalledWith(
      '/approvals?approval=MOTIR-1&approvalKind=design_result',
    );
  });

  it('a decided row opens it too — nothing in the room decides', () => {
    renderWithIntl(<ApprovalRecordsList records={page()} />);
    fireEvent.click(screen.getByRole('link', { name: /^Review MOTIR-2 / }), { button: 0 });
    expect(shallowPush).toHaveBeenCalledWith(
      '/approvals?approval=MOTIR-2&approvalKind=design_result',
    );
  });

  it('the pager writes only the page', () => {
    renderWithIntl(<ApprovalRecordsList records={page({ total: 60, page: 1, pageSize: 25 })} />);
    expect(approvalRecordsHref(1)).toBe('/approvals');
    expect(approvalRecordsHref(3)).toBe('/approvals?page=3');
  });

  it('`git grep` finds ONE approvals row component in the repo', () => {
    const ROOT = process.cwd();
    const hits = execFileSync(
      'git',
      ['grep', '--untracked', '-l', 'role="row"', '--', 'app', 'components'],
      {
        cwd: ROOT,
        encoding: 'utf8',
      },
    )
      .split('\n')
      .filter((f) => f && readFileSync(join(ROOT, f), 'utf8').includes('approval-row-'));
    expect(hits).toEqual(['components/approvals/ApprovalRow.tsx']);
  });
});

describe('the room decides nothing about access, and its door is browse-only', () => {
  const ROOT = process.cwd();

  it('the room’s files name no role and never re-check the key', () => {
    const out = (() => {
      try {
        return execFileSync(
          'git',
          [
            'grep',
            '--untracked',
            '-n',
            '-e',
            'isWorkspaceManager',
            '-e',
            'workspaceRole',
            '-e',
            'role ===',
            '-e',
            'approval:view_any',
            '--',
            'app/(authed)/approvals',
          ],
          { cwd: ROOT, encoding: 'utf8' },
        );
      } catch {
        return '';
      }
    })();
    expect(out).toBe('');
  });

  it('the page hands the read nothing but the page number — no parameter reaches the scope', () => {
    const src = readFileSync(join(ROOT, 'app/(authed)/approvals/page.tsx'), 'utf8');
    const readParams = [...src.matchAll(/params\['([^']+)'\]/g)].map((m) => m[1]);
    expect(readParams).toEqual(['page']);
    expect(src).toMatch(/listRecords\(ctx, \{ page: parsePage\(params\['page'\]\) \}\)/);
  });

  it('`/approvals` is in the one nav map as browse-only, naming the widening key in its evidence', () => {
    const entry = PROJECT_NAV_ACCESS.find((e) => e.href === '/approvals');
    expect(entry?.requires).toBe('browse-only');
    expect(entry?.evidence).toContain('approval:view_any');
    expect(canOfferNavDestination('/approvals', new Set(['project:browse']))).toBe(true);
  });
});
