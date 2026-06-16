// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { Switch } from '@/components/ui/Switch';

afterEach(() => cleanup());

const noop = () => {};

describe('Switch — accessible name', () => {
  it('takes its accessible name from aria-label', () => {
    render(<Switch checked={false} onCheckedChange={noop} aria-label="Email for Mentioned" />);
    // Resolves by name → the name is non-empty and correct.
    expect(screen.getByRole('switch', { name: 'Email for Mentioned' })).toBeTruthy();
  });

  // Regression for MOTIR-801: the primitive previously dropped `aria-labelledby`
  // (it forwarded only `aria-label`), so a switch named via a visible label span
  // — as EpicPrivacyControl does — rendered with an EMPTY accessible name.
  it('forwards aria-labelledby so a visible label names the switch', () => {
    render(
      <>
        <span id="lbl">Make this epic private</span>
        <Switch checked={false} onCheckedChange={noop} aria-labelledby="lbl" />
      </>,
    );
    const toggle = screen.getByRole('switch', { name: 'Make this epic private' });
    expect(toggle.getAttribute('aria-labelledby')).toBe('lbl');
    // The computed accessible name is non-empty.
    expect(screen.getByRole('switch', { name: /.+/ })).toBe(toggle);
  });
});
