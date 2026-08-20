// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { PlanReviewRail } from '@/components/planning/PlanReviewRail';
import type { PlanReviewDto } from '@/lib/dto/planReview';

// The plan DETAIL header's attribution — who ASKED for this plan and who WROTE
// it (`design/ai-planning/design-notes.md` Part III §6; Story MOTIR-2982 ·
// MOTIR-2991, retired inference MOTIR-2996).
//
// The LIST row's state machine has been pinned since MOTIR-2991
// (`PlanRow.test.tsx`); the header's had not, and the two are not the same
// machine — the header names the roles in WORDS, keeps the requester on a decided
// plan, and carries the MODEL, all of which the row deliberately does not. So the
// design's five attribution states are asserted HERE too, on the surface the
// person about to press Approve actually reads.
//
// The state these tests exist to protect is *Motir generated it*: it was read off
// `sourceJobId !== null` until MOTIR-2996, because the generator recorded no
// author. It now reads `authorSource === 'native'`, and `sourceJobId` has left
// `PlanReviewDto` entirely — one fact, one source.

afterEach(cleanup);

function review(over: Partial<PlanReviewDto> = {}): PlanReviewDto {
  return {
    id: 'plan_1',
    projectId: 'proj_1',
    status: 'planned',
    title: 'Stripe Connect payouts',
    summary: null,
    itemCount: 3,
    createdAt: '2026-08-19T00:00:00.000Z',
    plannedAt: '2026-08-19T00:00:00.000Z',
    decidedAt: null,
    decidedByName: null,
    decisionReason: null,
    // The default is the UNATTRIBUTED state — no requester, no author — so each
    // state below opts in explicitly.
    origin: 'user',
    createdByName: null,
    authorSource: null,
    authorHarness: null,
    authorModel: null,
    history: [],
    items: [],
    stale: false,
    staleCount: 0,
    ...over,
  };
}

function renderRail(over: Partial<PlanReviewDto> = {}) {
  return renderWithIntl(
    <PlanReviewRail
      review={review(over)}
      onApprove={() => {}}
      onDecline={() => {}}
      busy={false}
      errorCode={null}
    />,
  );
}

describe('PlanReviewRail — who asked and who wrote (the five states the design draws)', () => {
  it('names the requester and the AGENT, with its model, in words', () => {
    renderRail({
      createdByName: 'Mara',
      authorSource: 'mcp',
      authorHarness: 'Claude Code',
      authorModel: 'claude-opus-5',
    });

    // The roles are NAMED here, where the row would say a bare `Mara · via Claude
    // Code` — this line is read once, by the person about to approve, and the
    // words are what stop two names being taken for one party.
    expect(screen.getByText('Requested by Mara')).toBeTruthy();
    expect(screen.getByText('written by Claude Code')).toBeTruthy();
    // …and the MODEL, which the list row omits: it is the difference between two
    // agent-written plans, and nobody scans a list on it.
    expect(screen.getByText('claude-opus-5')).toBeTruthy();
  });

  it('names MOTIR off `authorSource === "native"` alone — no job, no inference', () => {
    renderRail({ createdByName: 'Jonas', authorSource: 'native', authorHarness: 'Motir' });

    expect(screen.getByText('Requested by Jonas')).toBeTruthy();
    expect(screen.getByText('written by Motir AI')).toBeTruthy();
  });

  it('renders the native state with NO model — Motir does not expose its planning LLM', () => {
    // `authorModel` is null on every native plan: motir-core does not know the
    // model, and `work-item-provenance.md` Decision 6 strips one at the read
    // boundary. The separator must go with it rather than leaving a dangling `·`.
    const { container } = renderRail({ authorSource: 'native', authorHarness: 'Motir' });

    expect(screen.getByText('written by Motir AI')).toBeTruthy();
    expect(container.textContent).not.toContain('written by Motir AI ·');
  });

  it('spells out AUTO-PLANNED when nobody asked', () => {
    renderRail({ origin: 'cadence', createdByName: null, authorSource: 'native' });

    // The most explicit copy of the five, deliberately: this is the surface where
    // somebody is about to accept the work, and *no requester* is a fact they
    // should read rather than infer from a missing name.
    expect(screen.getByText('Auto-planned — nobody requested this')).toBeTruthy();
    expect(screen.getByText('written by Motir AI')).toBeTruthy();
  });

  it('renders NOTHING when neither party is known — the unattributed state', () => {
    // After MOTIR-2996 this means exactly one thing: a plan with no recorded
    // author and no job behind it. It used to also swallow every Motir generation.
    renderRail();

    expect(screen.queryByText(/written by/)).toBeNull();
    expect(screen.queryByText(/Requested by/)).toBeNull();
    expect(screen.queryByText(/Auto-planned/)).toBeNull();
  });

  it('keeps the requester on a DECIDED plan — unlike the list row', () => {
    // Part III §6's second difference: the row drops the requester once decided
    // because its decider sits in the same line, and this header's does not — it
    // is in the history timeline below, so no two bare names compete.
    renderRail({
      status: 'approved',
      decidedAt: '2026-08-19T10:00:00.000Z',
      decidedByName: 'Mara',
      createdByName: 'Priya',
      authorSource: 'native',
      authorHarness: 'Motir',
    });

    expect(screen.getByText('Requested by Priya')).toBeTruthy();
    expect(screen.getByText('written by Motir AI')).toBeTruthy();
  });

  it('renders the requester alone when no author is recorded', () => {
    renderRail({ createdByName: 'Priya' });

    expect(screen.getByText('Requested by Priya')).toBeTruthy();
    expect(screen.queryByText(/written by/)).toBeNull();
  });

  it('carries both parties in TEXT — the glyphs are decorative', () => {
    const { container } = renderRail({
      createdByName: 'Mara',
      authorSource: 'mcp',
      authorHarness: 'Codex',
    });

    // `--el-text-faint` is legal on the glyphs and separators precisely because
    // the WORDS carry the meaning; neither party may be conveyed by icon or
    // colour alone.
    for (const svg of Array.from(container.querySelectorAll('svg'))) {
      expect(svg.getAttribute('aria-hidden')).toBe('true');
    }
    expect(container.textContent).toContain('Requested by Mara');
    expect(container.textContent).toContain('written by Codex');
  });
});
