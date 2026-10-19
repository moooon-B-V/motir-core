// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { OverlayExitButton } from '@/components/ui/OverlayExitButton';

afterEach(cleanup);

describe('OverlayExitButton (MOTIR-9070)', () => {
  it('shows the label and the Esc chip and calls back on click', () => {
    const onClose = vi.fn();
    render(<OverlayExitButton onClose={onClose} label="Close" escLabel="Esc" />);
    const btn = screen.getByRole('button', { name: /Close/ });
    expect(btn.querySelector('kbd')!.textContent).toBe('Esc');
    expect(btn.querySelector('kbd')!.className).not.toContain('hidden');
    expect(btn.getAttribute('data-testid')).toBe('overlay-exit');
    expect(btn.querySelector('svg')!.getAttribute('aria-hidden')).toBe('true');
    fireEvent.click(btn);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('hides the chip below md only when asked', () => {
    render(<OverlayExitButton onClose={() => {}} label="Close" escLabel="Esc" escHint="md" />);
    expect(screen.getByRole('button').querySelector('kbd')!.className).toContain(
      'hidden md:inline',
    );
  });
});
