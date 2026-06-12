// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { Modal } from '@/components/ui/Modal';

afterEach(cleanup);

// Regression cover for `bug-settings-modal-input-focus-ring-clipped`:
// Modal.Body owns the scrollable-body recipe once and makes it ring-safe, so a
// focused field's ring (Input's ring-2 + ring-offset-2 ≈ 4px overhang) is not
// clipped against the scroll box. The fix is the inset compensation (padding ≥
// the overhang, paired with an equal negative margin); if either half
// regresses, the ring clips again.
describe('Modal.Body', () => {
  it('renders its children', () => {
    render(
      <Modal.Body>
        <span>field area</span>
      </Modal.Body>,
    );
    expect(screen.getByText('field area')).toBeTruthy();
  });

  it('applies the ring-safe scroll recipe classes', () => {
    render(
      <Modal.Body data-testid="body">
        <span>x</span>
      </Modal.Body>,
    );
    const body = screen.getByTestId('body');
    // Scroll recipe: fills the remaining column height and scrolls so a pinned
    // Modal.Footer sibling stays put.
    for (const cls of ['flex', 'min-h-0', 'flex-1', 'flex-col', 'overflow-y-auto']) {
      expect(body.classList.contains(cls)).toBe(true);
    }
    // Ring-safe inset: padding gives the focus ring room, the equal negative
    // margin keeps the visual gutter unchanged. BOTH halves must be present —
    // padding without the margin would shift the fields inward; margin without
    // the padding would not clear the ring.
    expect(body.classList.contains('p-1.5')).toBe(true);
    expect(body.classList.contains('-m-1.5')).toBe(true);
  });

  it('merges a consumer className (e.g. the field gap) onto the recipe', () => {
    render(
      <Modal.Body data-testid="body" className="gap-3">
        <span>x</span>
      </Modal.Body>,
    );
    const body = screen.getByTestId('body');
    expect(body.classList.contains('gap-3')).toBe(true);
    // The recipe survives the merge.
    for (const cls of ['overflow-y-auto', 'p-1.5', '-m-1.5']) {
      expect(body.classList.contains(cls)).toBe(true);
    }
  });

  it('forwards arbitrary div props (e.g. role) to the underlying element', () => {
    render(
      <Modal.Body role="group" aria-label="fields">
        <span>x</span>
      </Modal.Body>,
    );
    expect(screen.getByRole('group', { name: 'fields' })).toBeTruthy();
  });
});
