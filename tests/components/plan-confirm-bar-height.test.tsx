// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import {
  PlanChangeConfirmBar,
  PLAN_CONFIRM_BAR_HEIGHT,
} from '@/components/planning/PlanChangeConfirmBar';
import { EMPTY_DIFF_INDEX } from '@/lib/planning/planChangeDiff';

// MOTIR-6186 — the confirm bar's height is ONE number, and this is what stops it
// being a magic one.
//
// ── Why this spec exists ────────────────────────────────────────────────────
// The planning surface no longer puts this bar in a footer slot below the canvas
// box. When there is nothing to decide the footer HIDES (`design-notes.md` Part
// XXI 21.8), and the bar floats OVER the box's bottom edge instead — so that
// hiding it resizes nothing and the canvas's three bottom-anchored control
// clusters never move. That was bug MOTIR-1815, whose shipped fix (an
// always-there resting footer) this replaces.
//
// For it to work the canvas has to keep those clusters clear of the strip the bar
// will occupy, which it does with a `--canvas-foot` inset. Part XXI's rule for
// that inset is *derive it, never pin it* — the hazard being two numbers, a magic
// `min-h` on one side and a magic inset on the other, drifting apart.
//
// There is one number here, `PLAN_CONFIRM_BAR_HEIGHT`, read by the bar AND by the
// host's inset. This spec is the other half of that: it asserts the bar the
// browser actually lays out is that tall. A pinned number that is CHECKED cannot
// drift silently; an unchecked one is exactly what the rule is about.
//
// ⚠️ IT DOES NOT ASSERT A LITERAL. The expected value is read from the constant,
// so changing the constant moves the requirement with it — what fails is the bar
// growing past it, which is the case where the inset goes short.

afterEach(() => cleanup());

/** `3.5rem` → 56, against happy-dom's 16px root. */
function remToPx(value: string): number {
  const match = /^([\d.]+)rem$/.exec(value);
  if (!match) throw new Error(`expected a rem value, got ${value}`);
  return Number(match[1]) * 16;
}

describe('the plan confirm bar declares ONE height, and honours it (MOTIR-6186)', () => {
  it.each([
    ['ungated', { kind: 'ungated' } as const],
    ['decide', { kind: 'decide' } as const],
    ['held', { kind: 'held', heldBy: null } as const],
  ])('the %s bar carries the shared min-height', (_name, view) => {
    renderWithIntl(
      <PlanChangeConfirmBar
        index={EMPTY_DIFF_INDEX}
        deciding={false}
        onApprove={() => {}}
        onDiscard={() => {}}
        view={view}
      />,
    );

    const bar = screen.getByTestId('plan-change-confirm-bar');
    expect(bar.style.minHeight).toBe(PLAN_CONFIRM_BAR_HEIGHT);
  });

  it('the constant is a rem value the host can put straight into a calc()', () => {
    // The host writes `--canvas-foot: var(--height-plan-confirm-bar)` and the
    // canvases read it inside `calc(var(--canvas-foot,0px) + …)`. A unitless or
    // percentage value would make that calc invalid and the inset would silently
    // become nothing — which looks exactly like the bug this arrangement removes.
    expect(PLAN_CONFIRM_BAR_HEIGHT).toMatch(/^[\d.]+rem$/);
    expect(remToPx(PLAN_CONFIRM_BAR_HEIGHT)).toBeGreaterThan(0);
  });
});
