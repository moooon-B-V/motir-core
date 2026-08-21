// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { PlanRow } from '@/app/(authed)/plans/_components/PlanRow';
import type { PlanRowView } from '@/app/(authed)/plans/_components/types';

// Component test for the Plans-list row (Subtask 7.21.1 / MOTIR-1338). Asserts
// the row binds the server-built view-model to the design (title, item count,
// when-label, the status pill, and the conditional stale flag) and links the
// whole row to the plan detail. happy-dom + the real `en` catalog (renderWithIntl)
// — no jest-dom (the component-test convention).

afterEach(() => cleanup());

function view(overrides: Partial<PlanRowView> = {}): PlanRowView {
  return {
    id: 'plan_1',
    status: 'planned',
    title: 'Stripe Connect payouts',
    itemCount: 14,
    staleCount: 0,
    whenKey: 'plannedAt',
    whenLabel: '2 hours ago',
    // The three-party attribution (MOTIR-2991). The default is the UNATTRIBUTED
    // state — no requester and no author — so every pre-existing case below
    // keeps asserting the row without one, and each attribution state opts in.
    origin: 'user',
    createdByName: null,
    // WHO DECIDED it (MOTIR-3238). Default null — the undecided states and the
    // ABANDONED one both read it that way, so a case that wants a decider opts
    // in rather than every pre-existing case carrying one.
    decidedByName: null,
    authorSource: null,
    authorHarness: null,
    ...overrides,
  };
}

describe('PlanRow', () => {
  it('renders the title, item count + when-label, and links the row to the plan detail', () => {
    renderWithIntl(<PlanRow view={view()} />);
    expect(screen.getByText('Stripe Connect payouts')).toBeTruthy();
    expect(screen.getByText('14 items')).toBeTruthy();
    expect(screen.getByText('planned 2 hours ago')).toBeTruthy();
    const link = screen.getByRole('link', { name: /Stripe Connect payouts/ });
    expect(link.getAttribute('href')).toBe('/plans/plan_1');
  });

  it('labels the when-line with the verb matching the lifecycle timestamp', () => {
    renderWithIntl(
      <PlanRow
        view={view({ status: 'approved', whenKey: 'approvedAt', whenLabel: 'yesterday' })}
      />,
    );
    expect(screen.getByText('approved yesterday')).toBeTruthy();
    expect(screen.getByText('Approved')).toBeTruthy();
  });

  it('renders the declined status pill', () => {
    renderWithIntl(
      <PlanRow
        view={view({ status: 'declined', whenKey: 'declinedAt', whenLabel: '3 days ago' })}
      />,
    );
    expect(screen.getByText('Declined')).toBeTruthy();
    expect(screen.getByText('declined 3 days ago')).toBeTruthy();
  });

  it('shows the stale flag when staleCount > 0', () => {
    renderWithIntl(<PlanRow view={view({ staleCount: 3 })} />);
    expect(screen.getByText('3 may be out of date')).toBeTruthy();
  });

  it('omits the stale flag when nothing has drifted', () => {
    renderWithIntl(<PlanRow view={view({ staleCount: 0 })} />);
    expect(screen.queryByText(/may be out of date/)).toBeNull();
  });

  it('falls back to a placeholder title for an unnamed generating plan', () => {
    renderWithIntl(
      <PlanRow view={view({ title: '', status: 'generating', whenKey: 'createdAt' })} />,
    );
    expect(screen.getByText('Untitled plan')).toBeTruthy();
    expect(screen.getByText('Generating')).toBeTruthy();
  });

  it('uses the singular item label for a one-item plan', () => {
    renderWithIntl(<PlanRow view={view({ itemCount: 1 })} />);
    expect(screen.getByText('1 item')).toBeTruthy();
  });
});

// ── The three-party attribution (Story MOTIR-2982 · MOTIR-2991) ─────────────
// `design/ai-planning/design-notes.md` Part III is the spec; panel A2 draws the
// seven rows. These assert the STATE MACHINE behind them — which of the two
// halves renders, and the one rule that is easy to get wrong (a decided row
// shows the decider, not the requester).
describe('PlanRow — who asked and who wrote', () => {
  it('names the person and the AGENT on an undecided plan', () => {
    renderWithIntl(
      <PlanRow
        view={view({ createdByName: 'Mara', authorSource: 'mcp', authorHarness: 'Claude Code' })}
      />,
    );
    expect(screen.getByText('Mara')).toBeTruthy();
    expect(screen.getByText('via Claude Code')).toBeTruthy();
  });

  it('names the person and MOTIR when Motir generated it', () => {
    // Read off `authorSource === 'native'` ALONE (MOTIR-2996). The generator now
    // RECORDS its authorship, so the row no longer infers it from a
    // `sourceJobId` — which named WHICH JOB, not who wrote the plan.
    renderWithIntl(<PlanRow view={view({ createdByName: 'Jonas', authorSource: 'native' })} />);
    expect(screen.getByText('Jonas')).toBeTruthy();
    expect(screen.getByText('via Motir AI')).toBeTruthy();
  });

  it('says AUTO-PLANNED instead of a requester when nobody asked', () => {
    renderWithIntl(
      <PlanRow view={view({ origin: 'cadence', createdByName: null, authorSource: 'native' })} />,
    );
    expect(screen.getByText('auto-planned')).toBeTruthy();
    expect(screen.getByText('via Motir AI')).toBeTruthy();
  });

  it('renders NOTHING when neither party is known — no placeholder, no gap', () => {
    // The unattributed state. Every plan predating the columns is in it, and a
    // placeholder in a scanned list is a value the reader must learn to ignore.
    const { container } = renderWithIntl(<PlanRow view={view()} />);
    expect(screen.queryByText(/via /)).toBeNull();
    expect(screen.queryByText('auto-planned')).toBeNull();
    // …and specifically no orphan separator left behind by the absent halves.
    expect(container.textContent).not.toContain('·');
  });

  it('renders the requester alone when no agent is known', () => {
    renderWithIntl(<PlanRow view={view({ createdByName: 'Priya' })} />);
    expect(screen.getByText('Priya')).toBeTruthy();
    expect(screen.queryByText(/via /)).toBeNull();
  });

  it('KEEPS the requester once the plan is decided, and names the decider too', () => {
    // ⚠️ THIS TEST WAS REVERSED BY MOTIR-3238, and the old assertion is quoted
    // rather than deleted. It read *"DROPS the requester once the plan is
    // decided, and keeps the agent"*, and asserted `queryByText('Mara')` was
    // null — Part III §3's rule that a decided row shows the decider, not the
    // requester.
    //
    // That rule named a real hazard (two bare names in one scanned line) and
    // rested on a premise that was false: the decider it deferred to was drawn
    // in panel A since 843 and NEVER SHIPPED, so the row named NOBODY. Part VII
    // reverses it by putting the two in DIFFERENT entries — the decider behind
    // the timestamp's verb, the requester behind its avatar.
    for (const status of ['approved', 'declined'] as const) {
      cleanup();
      renderWithIntl(
        <PlanRow
          view={view({
            status,
            whenKey: status === 'approved' ? 'approvedAt' : 'declinedAt',
            createdByName: 'Mara',
            decidedByName: 'Jonas',
            authorSource: 'native',
          })}
        />,
      );
      // The requester, in the attribution entry, exactly as on an undecided row.
      expect(screen.getByText('Mara')).toBeTruthy();
      // The decider, INSIDE the when-entry, behind the verb that says the role.
      const verb = status === 'approved' ? 'approved' : 'declined';
      expect(screen.getByText(`${verb} 2 hours ago by Jonas`)).toBeTruthy();
      expect(screen.getByText('via Motir AI')).toBeTruthy();
    }
  });

  it('a decided plan with NO decider renders the plain timestamp — no placeholder', () => {
    // The abandoned-plan case (MOTIR-3189): `declined` with `decidedById` NULL,
    // because nobody decided it. Part III §3's *absence, never a placeholder*
    // rule, one axis over — the fallback is a whole sentence, not a name-shaped
    // hole in one.
    renderWithIntl(
      <PlanRow
        view={view({
          status: 'declined',
          whenKey: 'declinedAt',
          createdByName: 'Mara',
          decidedByName: null,
          authorSource: 'mcp',
          authorHarness: 'Claude Code',
        })}
      />,
    );
    expect(screen.getByText('declined 2 hours ago')).toBeTruthy();
    expect(screen.queryByText(/ by /)).toBeNull();
    // The requester and the agent are both still there — only the decider is
    // absent, and only because there is not one.
    expect(screen.getByText('Mara')).toBeTruthy();
    expect(screen.getByText('via Claude Code')).toBeTruthy();
  });

  it('an UNDECIDED row is untouched by the reversal', () => {
    // The rule Part VII reverses applied only to a decided row. A `planned` one
    // rendered the requester before and renders it now, with no decider in
    // sight — asserted so the reversal cannot leak into the state it never
    // governed.
    renderWithIntl(
      <PlanRow
        view={view({
          status: 'planned',
          whenKey: 'plannedAt',
          createdByName: 'Mara',
          decidedByName: 'Jonas',
          authorSource: 'mcp',
          authorHarness: 'Claude Code',
        })}
      />,
    );
    // Even with a decider in the view-model — which cannot happen in practice —
    // a `planned` row shows the plain timestamp: the keys are chosen off
    // `whenKey`, so only the two decided verbs can carry a name.
    expect(screen.getByText('planned 2 hours ago')).toBeTruthy();
    expect(screen.getByText('Mara')).toBeTruthy();
  });

  it('the cadence row is unchanged — nobody asked, so no requester is invented', () => {
    renderWithIntl(
      <PlanRow
        view={view({
          status: 'approved',
          whenKey: 'approvedAt',
          origin: 'cadence',
          createdByName: null,
          decidedByName: 'Jonas',
          authorSource: 'native',
        })}
      />,
    );
    expect(screen.getByText('auto-planned')).toBeTruthy();
    expect(screen.getByText('approved 2 hours ago by Jonas')).toBeTruthy();
  });

  it('truncates a long harness without touching the title', () => {
    const harness = 'acme-internal-planning-harness v4 (nightly build)';
    renderWithIntl(
      <PlanRow
        view={view({ createdByName: 'Mara', authorSource: 'mcp', authorHarness: harness })}
      />,
    );
    const agent = screen.getByText(`via ${harness}`);
    expect(agent.className).toContain('truncate');
    expect(agent.className).toContain('max-w-[12rem]');
    // The title keeps its OWN ellipsis and is never shortened by this line.
    expect(screen.getByText('Stripe Connect payouts').className).toContain('truncate');
  });

  it('carries the attribution in TEXT, never by icon or colour alone', () => {
    const { container } = renderWithIntl(
      <PlanRow
        view={view({ createdByName: 'Mara', authorSource: 'mcp', authorHarness: 'Codex' })}
      />,
    );
    // Every glyph in the attribution is decorative; the words say the whole thing.
    for (const svg of container.querySelectorAll('svg')) {
      if (svg.closest('a')?.textContent?.includes('Codex')) {
        expect(svg.getAttribute('aria-hidden')).toBe('true');
      }
    }
    expect(screen.getByText('via Codex')).toBeTruthy();
    expect(screen.getByText('Mara')).toBeTruthy();
  });
});
