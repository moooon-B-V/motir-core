// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { GenerationHandoff } from '@/components/onboarding/GenerationHandoff';
import { STYLE_REGISTRY } from '@/lib/theme/styles';
import { PALETTE_REGISTRY } from '@/lib/theme/palettes';
import { TYPE_REGISTRY } from '@/lib/theme/typography';
import type { DesignChoiceDTO } from '@/lib/dto/aiPreplan';

// The pre-plan → generation HAND-OFF view (Subtask 7.3.28 / MOTIR-1041) — the
// LAST 7.3 affordance. It presents the FROZEN (already-persisted) baseline as the
// generation input and offers one-click re-entry (Back) into the pre-plan loop. It
// does NOT generate the tree (that is 7.4). No jest-dom (project convention).

const CHOICE: DesignChoiceDTO = {
  styleId: 'glassmorphism',
  paletteId: 'cobalt',
  typeId: 'grotesk',
};

function renderHandoff(props: Partial<React.ComponentProps<typeof GenerationHandoff>> = {}) {
  const onBack = props.onBack ?? vi.fn();
  const onGenerate = props.onGenerate ?? vi.fn();
  renderWithIntl(
    <GenerationHandoff
      onBack={onBack}
      onGenerate={onGenerate}
      reviewedCount={props.reviewedCount ?? 4}
      designChoice={props.designChoice ?? CHOICE}
      designApplied={props.designApplied ?? true}
    />,
  );
  return { onBack, onGenerate };
}

afterEach(() => cleanup());

describe('GenerationHandoff (MOTIR-1041)', () => {
  it('renders the hand-off heading and the Back re-entry control', () => {
    renderHandoff();
    expect(screen.getByText('Your direction is set')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Back to planning' })).toBeTruthy();
  });

  it('Back (one-click re-entry) calls onBack — the baseline stays revisable', () => {
    const { onBack } = renderHandoff();
    fireEvent.click(screen.getByRole('button', { name: 'Back to planning' }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('shows the frozen baseline: the reviewed-step count + the chosen design', () => {
    renderHandoff({ reviewedCount: 4, designChoice: CHOICE, designApplied: true });
    expect(screen.getByText('4 steps reviewed')).toBeTruthy();
    // The chosen design names (style · palette · type) summarise the frozen look.
    const summary = [
      STYLE_REGISTRY[CHOICE.styleId].name,
      PALETTE_REGISTRY[CHOICE.paletteId].name,
      TYPE_REGISTRY[CHOICE.typeId].name,
    ].join(' · ');
    expect(screen.getByText(summary)).toBeTruthy();
  });

  it('pluralises a single reviewed step', () => {
    renderHandoff({ reviewedCount: 1 });
    expect(screen.getByText('1 step reviewed')).toBeTruthy();
  });

  it('reads "Default look" when the design step was skipped / gated out', () => {
    renderHandoff({ designApplied: false, designChoice: null });
    expect(screen.getByText('Default look')).toBeTruthy();
  });

  it('renders the 7.4 Generate trigger and clicking it calls onGenerate (MOTIR-1396)', () => {
    // 7.4.9 mounts the generation entry INTO this hand-off view — the boundary the
    // comment always anticipated ("7.4's generation surface mounts into this same
    // view"). The earlier 7.3-only contract (no generate action) is now reversed.
    const { onGenerate } = renderHandoff();
    const trigger = screen.getByRole('button', { name: 'Generate plan' });
    expect(trigger).toBeTruthy();
    fireEvent.click(trigger);
    expect(onGenerate).toHaveBeenCalledTimes(1);
  });
});
