// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { AuditPanel } from '@/app/(authed)/code-health/_components/AuditPanel';
import type { CodeAuditSurfaceDTO } from '@/lib/dto/codeHealth';
import enMessages from '@/messages/en.json';

// The audit tab's PRE-AUDIT states (design Panel 4b / MOTIR-2087).
// `!audit` used to render ONE empty state — the start-fresh "no codebase" copy —
// for every project, including one with five connected, indexed repos. MOTIR-2081
// split the branch on the repo set; MOTIR-2080 adds what the repo-backed state was
// missing — the action that DERIVES the first audit, and the two states that
// follow it (deriving, and the page giving up while the job keeps running).
// Together these prove a project can now get from "no audit" to an audit at all.

const A_TITLE = enMessages.codeHealth.audit.emptyTitle;
const A_DESCRIPTION = enMessages.codeHealth.audit.emptyDescription;
const B_TITLE = enMessages.codeHealth.audit.noAuditTitle;
const B_DESCRIPTION = enMessages.codeHealth.audit.noAuditDescription;
const B_ACTION = enMessages.codeHealth.audit.runFirstAudit;
const C_TITLE = enMessages.codeHealth.audit.derivingTitle;
const C_DURATION = enMessages.codeHealth.audit.derivingDuration;
const D_TITLE = enMessages.codeHealth.audit.stillRunningTitle;
const D_ACTION = enMessages.codeHealth.audit.checkAgain;

const REPOS = [
  'moooon-B-V/motir-core',
  'moooon-B-V/motir-ai',
  'moooon-B-V/motir-gateway',
  'moooon-B-V/motir-meta',
  'moooon-B-V/nextjs-prisma-vercel-starter',
];

function renderPanel(
  over: {
    audit?: CodeAuditSurfaceDTO['audit'];
    repoRefs?: string[];
    reauditing?: boolean;
    pollExhausted?: boolean;
    onReaudit?: () => void;
    onCheckAgain?: () => void;
  } = {},
) {
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
      reauditing={over.reauditing ?? false}
      onReaudit={over.onReaudit ?? vi.fn()}
      pollExhausted={over.pollExhausted ?? false}
      onCheckAgain={over.onCheckAgain ?? vi.fn()}
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

    // The bug this card closes: the ONLY trigger for a first audit lived inside
    // DeepenAuditCard, which renders after the `!audit` early return — so a
    // repo-backed project could never derive the audit that would reveal the
    // button. The action makes the state actionable rather than merely truthful.
    it('offers the action that derives the first audit', () => {
      renderPanel({ repoRefs: REPOS });
      expect(screen.getByRole('button', { name: B_ACTION })).toBeTruthy();
    });

    it('fires the SAME trigger the "Re-audit now" button does — one code path', () => {
      const onReaudit = vi.fn();
      renderPanel({ repoRefs: REPOS, onReaudit });
      fireEvent.click(screen.getByRole('button', { name: B_ACTION }));
      expect(onReaudit).toHaveBeenCalledTimes(1);
    });

    // State A's action stays unwired (no "chosen stack" surface exists), and a
    // project with no code must never be offered an audit it cannot run.
    it('offers NO action on the start-fresh state', () => {
      const { container } = renderPanel({ repoRefs: [] });
      expect(container.querySelector('button')).toBeNull();
    });
  });

  // States C and D are what happens AFTER the action fires. The job is async —
  // two queued jobs the page polls for — so the screen it leaves behind is part
  // of the deliverable, not an afterthought.
  describe('State C · the first audit deriving', () => {
    it('replaces the action with progress, rather than leaving a button pending', () => {
      const { container } = renderPanel({ repoRefs: REPOS, reauditing: true });
      expect(screen.getByText(C_TITLE)).toBeTruthy();
      // REMOVED, not disabled: the job runs for minutes, and a pending button
      // implies a request the page is blocked on and invites a second click.
      expect(container.querySelector('button')).toBeNull();
      expect(screen.queryByText(B_TITLE)).toBeNull();
    });

    it('keeps the repo list visible and says how long this takes', () => {
      renderPanel({ repoRefs: REPOS, reauditing: true });
      for (const repoRef of REPOS) expect(screen.getByText(repoRef)).toBeTruthy();
      expect(screen.getByText(C_DURATION)).toBeTruthy();
    });

    it('signals deriving with a spinner, never a border-style change', () => {
      const { container } = renderPanel({ repoRefs: REPOS, reauditing: true });
      expect(container.querySelector('.animate-spin')).toBeTruthy();
      // A dashed border would collide with borders that carry data elsewhere.
      expect(container.querySelector('[class*="border-dashed"]')).toBeNull();
    });
  });

  describe('State D · the page stopped waiting; the job did not', () => {
    // Routine, not an edge case: the poll is 3s × 20 = 60s, and a first audit
    // across several repos does not finish in a minute — so most first runs
    // land here. It must read as waiting, never as failure.
    it('rests inside the empty state, keeping the repo list', () => {
      renderPanel({ repoRefs: REPOS, pollExhausted: true });
      expect(screen.getByText(D_TITLE)).toBeTruthy();
      for (const repoRef of REPOS) expect(screen.getByText(repoRef)).toBeTruthy();
    });

    it('offers "Check again", which RE-READS and never re-fires the audit', () => {
      const onReaudit = vi.fn();
      const onCheckAgain = vi.fn();
      renderPanel({ repoRefs: REPOS, pollExhausted: true, onReaudit, onCheckAgain });
      fireEvent.click(screen.getByRole('button', { name: D_ACTION }));
      expect(onCheckAgain).toHaveBeenCalledTimes(1);
      // Re-POSTing would queue a SECOND code_audit + propose_convention pair for
      // work already in flight.
      expect(onReaudit).not.toHaveBeenCalled();
    });

    it('is superseded by the deriving state while a poll is actually running', () => {
      renderPanel({ repoRefs: REPOS, reauditing: true, pollExhausted: true });
      expect(screen.getByText(C_TITLE)).toBeTruthy();
      expect(screen.queryByText(D_TITLE)).toBeNull();
    });

    // With no repos there is no action to fire, so neither C nor D is reachable —
    // and a code-less project must not be told an audit of its code is running.
    it('cannot be reached by a project with no connected repos', () => {
      renderPanel({ repoRefs: [], pollExhausted: true, reauditing: true });
      expect(screen.getByText(A_TITLE)).toBeTruthy();
      expect(screen.queryByText(C_TITLE)).toBeNull();
      expect(screen.queryByText(D_TITLE)).toBeNull();
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

  // The four pre-audit states are BEHIND the `!audit` return, so none of the new
  // props may change the report once an audit exists — including the re-audit
  // path, which keeps its own in-report affordance and its own pending message.
  it('leaves the existing report + deepen behaviour untouched once an audit exists', () => {
    const onReaudit = vi.fn();
    renderPanel({
      repoRefs: REPOS,
      onReaudit,
      // Both pre-audit flags set: neither may leak into the report view.
      reauditing: true,
      pollExhausted: true,
      audit: {
        id: 'audit-1',
        healthSummary: { grade: 'B', conformancePct: 74, conventionVersion: 2 },
        codeGraphRef: null,
        repoKey: 'moooon-B-V/motir-core',
        createdAt: '2026-08-04T00:00:00.000Z',
      },
    });
    expect(screen.getByText(enMessages.codeHealth.audit.measuredAgainst)).toBeTruthy();
    for (const title of [A_TITLE, B_TITLE, C_TITLE, D_TITLE]) {
      expect(screen.queryByText(title)).toBeNull();
    }
    expect(screen.queryByRole('button', { name: B_ACTION })).toBeNull();
    expect(screen.queryByRole('button', { name: D_ACTION })).toBeNull();
    expect(onReaudit).not.toHaveBeenCalled();
  });
});
