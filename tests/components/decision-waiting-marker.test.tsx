// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { DecisionWaitingMarker } from '@/components/approvals/DecisionWaitingMarker';
import zhMessages from '@/messages/zh.json';

// THE DECISION-WAITING MARKER (MOTIR-5877; design MOTIR-5875) — one component,
// two forms. Loud and quiet must differ in TREATMENT, never in text alone, so
// every pair below asserts the element's classes and glyph, not only its words.
// The third state, NONE, is a marker that is not rendered: that is each
// surface's decision and is asserted there (board-card.test.tsx).

afterEach(cleanup);

function marker() {
  return document.querySelector('[data-decision-marker]');
}

describe('DecisionWaitingMarker — label form (board card, item header)', () => {
  it('YOURS is the loud pill — yellow tint, Stamp glyph, "Awaiting you"', () => {
    render(<DecisionWaitingMarker state="yours" kind="design_result" routedToName="Me" />);
    const el = marker();
    expect(el?.textContent).toBe('Awaiting you');
    expect(el?.getAttribute('data-decision-marker')).toBe('yours');
    expect(el?.getAttribute('data-decision-kind')).toBe('design_result');
    expect(el?.className).toContain('--el-tint-yellow');
    expect(el?.querySelector('.lucide-stamp')).toBeTruthy();
  });

  it('OTHERS is the quiet chip — neutral tint, Hourglass glyph, naming who it waits on', () => {
    render(
      <DecisionWaitingMarker state="others" kind="acceptance_result" routedToName="Ana Ruiz" />,
    );
    const el = marker();
    expect(el?.textContent).toBe('Waiting on Ana Ruiz');
    expect(el?.className).toContain('--el-chip-bg');
    expect(el?.className).not.toContain('--el-tint-yellow');
    expect(el?.querySelector('.lucide-hourglass')).toBeTruthy();
  });

  it('a name the caller could not resolve reads as this work item’s assignee', () => {
    render(<DecisionWaitingMarker state="others" kind="design_result" routedToName={null} />);
    expect(marker()?.textContent).toBe("Waiting on this work item's assignee");
  });

  it('carries the id a card points aria-describedby at', () => {
    render(
      <DecisionWaitingMarker state="yours" kind="design_result" routedToName={null} id="m-1" />,
    );
    expect(document.getElementById('m-1')).toBe(marker());
  });

  it('truncates a long name INSIDE the pill rather than overflowing the card', () => {
    render(
      <DecisionWaitingMarker
        state="others"
        kind="design_result"
        routedToName="Maximiliana Wilhelmina von Hohenzollern-Sigmaringen"
      />,
    );
    expect(marker()?.className).toContain('max-w-full');
    expect(marker()?.querySelector('.truncate')).toBeTruthy();
  });
});

describe('DecisionWaitingMarker — glyph form (List / Tree status cell)', () => {
  it('YOURS is a stamp on a yellow disc, named "Awaiting you — {decision}"', () => {
    render(
      <DecisionWaitingMarker form="glyph" state="yours" kind="design_result" routedToName={null} />,
    );
    const el = screen.getByRole('img', { name: 'Awaiting you — design approval' });
    expect(el.getAttribute('title')).toBe('Awaiting you — design approval');
    expect(el.className).toContain('--el-tint-yellow');
    expect(el.className).toContain('rounded-full');
    expect(el.querySelector('.lucide-stamp')).toBeTruthy();
  });

  it('OTHERS is a bare hourglass, named "Waiting on {name} — {decision}"', () => {
    render(
      <DecisionWaitingMarker
        form="glyph"
        state="others"
        kind="pull_request_approval"
        routedToName="Ada Lovelace"
      />,
    );
    const el = screen.getByRole('img', {
      name: 'Waiting on Ada Lovelace — pull-request approval',
    });
    expect(el.className).not.toContain('--el-tint-yellow');
    expect(el.className).toContain('--el-text-secondary');
    expect(el.querySelector('.lucide-hourglass')).toBeTruthy();
  });

  it('is shrink-0, so the status cell cannot squeeze it over the status pill', () => {
    render(
      <DecisionWaitingMarker
        form="glyph"
        state="yours"
        kind="decision_approval"
        routedToName={null}
      />,
    );
    expect(marker()?.className).toContain('shrink-0');
  });
});

describe('DecisionWaitingMarker — zh', () => {
  it('renders both states and the glyph name in Chinese', () => {
    const { unmount } = render(
      <DecisionWaitingMarker state="yours" kind="design_result" routedToName={null} />,
      { locale: 'zh', messages: zhMessages },
    );
    expect(marker()?.textContent).toBe('等待你处理');
    unmount();
    render(
      <DecisionWaitingMarker form="glyph" state="others" kind="design_result" routedToName="Ana" />,
      { locale: 'zh', messages: zhMessages },
    );
    expect(screen.getByRole('img', { name: '等待 Ana 处理——设计审批' })).toBeTruthy();
  });
});
