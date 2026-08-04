// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { AuditPanel } from '@/app/(authed)/code-health/_components/AuditPanel';
import type { CodeAuditSurfaceDTO } from '@/lib/dto/codeHealth';
import enMessages from '@/messages/en.json';

// The audit tab's PRE-AUDIT states (MOTIR-2081, design Panel 4b / MOTIR-2087).
// `!audit` used to render ONE empty state — the start-fresh "no codebase" copy —
// for every project, including one with five connected, indexed repos. These
// prove the branch: which state renders is decided by the repo set, and the
// start-fresh sentence never reaches a repo-backed project.

const A_TITLE = enMessages.codeHealth.audit.emptyTitle;
const A_DESCRIPTION = enMessages.codeHealth.audit.emptyDescription;
const B_TITLE = enMessages.codeHealth.audit.noAuditTitle;
const B_DESCRIPTION = enMessages.codeHealth.audit.noAuditDescription;

const REPOS = [
  'moooon-B-V/motir-core',
  'moooon-B-V/motir-ai',
  'moooon-B-V/motir-gateway',
  'moooon-B-V/motir-meta',
  'moooon-B-V/nextjs-prisma-vercel-starter',
];

function renderPanel(over: { audit?: CodeAuditSurfaceDTO['audit']; repoRefs?: string[] } = {}) {
  return renderWithIntl(
    <AuditPanel
      audit={over.audit ?? null}
      repoRefs={over.repoRefs ?? []}
      findings={[]}
      total={0}
      hasMore={false}
      loadingMore={false}
      onLoadMore={vi.fn()}
      scanner={null}
      reauditing={false}
      onReaudit={vi.fn()}
      deepenDismissed={false}
      onDeepenDismiss={vi.fn()}
      onDeepenReopen={vi.fn()}
    />,
  );
}

afterEach(cleanup);

describe('AuditPanel — pre-audit empty states', () => {
  describe('State A · start-fresh (no repos connected)', () => {
    it('keeps the shipped start-fresh copy', () => {
      renderPanel({ repoRefs: [] });
      expect(screen.getByText(A_TITLE)).toBeTruthy();
      expect(screen.getByText(A_DESCRIPTION)).toBeTruthy();
    });

    it('does not claim an audit is missing for code that does not exist', () => {
      renderPanel({ repoRefs: [] });
      expect(screen.queryByText(B_TITLE)).toBeNull();
      expect(screen.queryByText(B_DESCRIPTION)).toBeNull();
    });
  });

  describe('State B · repo-backed but never audited', () => {
    it('says the code has not been audited, never that there is no codebase', () => {
      renderPanel({ repoRefs: REPOS });
      expect(screen.getByText(B_TITLE)).toBeTruthy();
      expect(screen.getByText(B_DESCRIPTION, { exact: false })).toBeTruthy();
      expect(screen.queryByText(A_TITLE)).toBeNull();
    });

    // The bug's core falsehood: "established from your chosen stack" is the FRESH
    // propose_convention path. A repo-backed project derives its convention from
    // the code graph, so that sentence must never render here.
    it('never renders the "chosen stack" sentence on a repo-backed project', () => {
      const { container } = renderPanel({ repoRefs: REPOS });
      expect(container.textContent).not.toContain('chosen stack');
      expect(container.textContent).not.toContain('No codebase');
    });

    it('names every connected repo as a code chip', () => {
      renderPanel({ repoRefs: REPOS });
      for (const repoRef of REPOS) {
        const chip = screen.getByText(repoRef);
        expect(chip.tagName).toBe('CODE');
      }
    });

    it('renders State B for a single connected repo too', () => {
      renderPanel({ repoRefs: ['moooon-B-V/motir-core'] });
      expect(screen.getByText(B_TITLE)).toBeTruthy();
      expect(screen.getByText('moooon-B-V/motir-core')).toBeTruthy();
    });

    // The generative "Run the first audit" action is MOTIR-2080's (it owns the
    // trigger); State A's navigational action is deliberately unwired. Neither
    // state offers a button today — assert it so wiring one is a deliberate change.
    it('offers no action button in either pre-audit state', () => {
      const { container } = renderPanel({ repoRefs: REPOS });
      expect(container.querySelector('button')).toBeNull();
      cleanup();
      const fresh = renderPanel({ repoRefs: [] });
      expect(fresh.container.querySelector('button')).toBeNull();
    });
  });

  it('renders the report, not an empty state, once an audit exists', () => {
    renderPanel({
      repoRefs: REPOS,
      audit: {
        id: 'audit-1',
        healthSummary: { grade: 'B', conformancePct: 74, conventionVersion: 2 },
        codeGraphRef: null,
        repoKey: 'moooon-B-V/motir-core',
        createdAt: '2026-08-04T00:00:00.000Z',
      },
    });
    expect(screen.queryByText(A_TITLE)).toBeNull();
    expect(screen.queryByText(B_TITLE)).toBeNull();
    expect(screen.getByText('B')).toBeTruthy();
    expect(screen.getByText(enMessages.codeHealth.audit.measuredAgainst)).toBeTruthy();
  });
});
