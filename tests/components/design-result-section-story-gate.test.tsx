// @vitest-environment happy-dom
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import en from '@/messages/en.json';
import type { ApprovalGateDTO } from '@/lib/dto/approvalGate';
import type { DesignEvidenceDTO } from '@/lib/dto/designEvidence';

// THE STORY'S VITEST GATE — the guards a coverage percentage cannot see (Story
// MOTIR-5215 · Subtask MOTIR-5230).
//
// A percentage measures what RAN. It cannot tell a section that renders every
// state correctly from one that renders the states somebody remembered, and it
// cannot see a verb that survives on the page or a second container that comes
// back. So this suite asserts three properties over the WHOLE state space:
//
//   1. TOTALITY — `ApprovalGateState` is enumerated from `prisma/schema.prisma`,
//      not re-typed here, and every member × `canDecide` has a stated expectation.
//      A new member fails this suite until somebody decides what the item page
//      shows for it.
//   2. NO DECISION ON THE PAGE — for every one of those cases, no approve and no
//      request-changes control exists in the section's tree.
//   3. ONE CONTAINER, ONE LABEL — for every case, the frame draws no card box of
//      its own and no second *Design result* label (the section card's title is
//      the only one; `design/work-items/design-notes.md` § *The item page HANDS
//      THE DECISION OVER*).

vi.mock('next/navigation', () => ({
  usePathname: () => '/items/MOTIR-4321',
  useSearchParams: () => new URLSearchParams(),
}));

import { DesignResultSection } from '@/app/(authed)/items/[key]/_components/DesignResultSection';

afterEach(cleanup);

/** The enum's members, read from the schema — the population, not a copy of it. */
function gateStates(): string[] {
  const schema = fs.readFileSync(path.join(process.cwd(), 'prisma/schema.prisma'), 'utf8');
  const body = /enum ApprovalGateState \{([^}]*)\}/.exec(schema)?.[1];
  if (!body) throw new Error('enum ApprovalGateState not found in prisma/schema.prisma');
  return body
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, '').trim())
    .filter((line) => /^[a-z_]+$/.test(line));
}

const PUBLISHED: DesignEvidenceDTO = {
  id: 'ev-1',
  workItemId: 'wi-1',
  noteMd: '## The approvals room',
  noteTruncated: false,
  assets: [
    {
      id: 'a-note',
      kind: 'note_file',
      url: '/api/attachments/att-note/content',
      mimeType: 'text/markdown',
      sizeBytes: 64,
      sourcePath: 'design/approvals/design-notes.md',
      position: 0,
    },
  ],
  commitSha: 'cafe1234567',
  ciRunUrl: null,
  producedByKey: 'MOTIR-4320',
  createdAt: '2026-09-08T03:00:00.000Z',
  withdrawnAt: null,
  withdrawnById: null,
  withdrawnReason: null,
};

function gate(state: ApprovalGateDTO['state'], id: string): ApprovalGateDTO {
  const decided = state === 'approved' || state === 'changes_requested';
  return {
    id,
    workItemId: 'wi-1',
    kind: 'design_result',
    subjectId: 'ev-1',
    state,
    decidedById: decided ? 'user-2' : null,
    decidedAt: decided ? '2026-09-08T05:00:00.000Z' : null,
    noteMd: null,
    subjectVersion: '9840d00ea1b2',
    decidedByLabel: decided ? 'Ada Lovelace' : null,
    routedToId: 'user-2',
    decidedUnderAuthority: decided ? 'assignee' : null,
    decisionSource: decided ? 'ui' : null,
    outcomeRef: state === 'approved' ? 'done' : null,
    createdAt: '2026-09-08T04:00:00.000Z',
    updatedAt: '2026-09-08T04:00:00.000Z',
  };
}

const REVIEW = en.approvalGate.statusHeld.reviewAndApprove;
const PORT = en.approvalGate.port.label;

/** What the item page shows for each state, for a reader who may decide and one who may not. */
const EXPECTED: Record<string, (canDecide: boolean) => void> = {
  awaiting: (canDecide) => {
    if (canDecide) {
      // The call-to-action band: one door, no port.
      expect(screen.getByRole('link', { name: REVIEW })).toBeTruthy();
      expect(screen.queryByRole('group', { name: PORT })).toBeNull();
    } else {
      // State `B`: the port, who it waits on, no door.
      expect(screen.getByRole('group', { name: PORT })).toBeTruthy();
      expect(screen.getByText('Waiting on Ada Lovelace.', { exact: false })).toBeTruthy();
      expect(screen.queryByRole('link', { name: REVIEW })).toBeNull();
    }
  },
  approved: () => {
    expect(screen.getByText(en.approvalGate.state.approved, { exact: true })).toBeTruthy();
    expect(screen.getByText(en.approvalGate.record.filesKept)).toBeTruthy();
    expect(screen.queryByRole('link', { name: REVIEW })).toBeNull();
  },
  changes_requested: () => {
    expect(screen.getByText(en.approvalGate.record.willRepublish)).toBeTruthy();
    expect(screen.queryByRole('link', { name: REVIEW })).toBeNull();
  },
  superseded: () => {
    expect(screen.getByText(en.approvalGate.withdrawn.port)).toBeTruthy();
    expect(screen.queryByRole('link', { name: REVIEW })).toBeNull();
  },
};

const STATES = gateStates();
const CASES = STATES.flatMap((state) =>
  [true, false].map((canDecide) => [state, canDecide] as const),
);

describe('the Design result section over the WHOLE gate state space (MOTIR-5230)', () => {
  it('reads a non-empty enum, and every member has a stated expectation', () => {
    expect(STATES.length).toBeGreaterThan(0);
    expect(STATES.filter((state) => !(state in EXPECTED))).toEqual([]);
  });

  it.each(CASES)(
    '%s, canDecide=%s — the stated view, no verb, one container and one label',
    (state, canDecide) => {
      const { container } = renderWithIntl(
        <DesignResultSection
          evidence={PUBLISHED}
          isDesignCard
          gate={gate(state as ApprovalGateDTO['state'], `story-gate-${state}-${canDecide}`)}
          canDecide={canDecide}
          subject={
            state === 'approved' || state === 'changes_requested'
              ? { evidence: PUBLISHED, filesKept: state === 'approved' }
              : null
          }
          itemIdentifier="MOTIR-4321"
          routedToLabel="Ada Lovelace"
          routedToViewer={false}
        />,
      );

      EXPECTED[state]!(canDecide);

      expect(screen.queryByRole('button', { name: en.approvalGate.verb.approve })).toBeNull();
      expect(
        screen.queryByRole('button', { name: en.approvalGate.verb.requestChanges }),
      ).toBeNull();

      expect(
        screen.queryAllByText(en.approvalGate.designResult.kindLabel, { exact: true }),
      ).toHaveLength(0);
      const chrome = Array.from(container.querySelectorAll('[class]')).filter((el) =>
        el.className.includes('rounded-(--radius-card)'),
      );
      expect(chrome).toHaveLength(0);
    },
  );
});

describe('a gate that carries no subject version (MOTIR-5230)', () => {
  // `ApprovalGateDTO.subjectVersion` is nullable, and both the band and the kept
  // frame have a written fallback for it — the plain meta line. Reachable, so
  // it is asserted rather than ignored.
  const noVersion = (state: ApprovalGateDTO['state'], id: string): ApprovalGateDTO => ({
    ...gate(state, id),
    subjectVersion: null,
  });

  it.each([
    ['the band', 'awaiting', true],
    ['a kept state', 'awaiting', false],
  ] as const)('%s says "the published design"', (_where, state, canDecide) => {
    const { container } = renderWithIntl(
      <DesignResultSection
        evidence={PUBLISHED}
        isDesignCard
        gate={noVersion(state, `story-gate-noversion-${canDecide}`)}
        canDecide={canDecide}
        subject={null}
        itemIdentifier="MOTIR-4321"
        routedToLabel="Ada Lovelace"
        routedToViewer={false}
      />,
    );
    expect(container.textContent).toContain(en.approvalGate.designResult.meta.plain);
    expect(container.textContent).not.toContain('version ');
  });
});
