// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { Button } from '@/components/ui/Button';
import { Segmented } from '@/components/ui/Segmented';

// Story MOTIR-7730 · MOTIR-7759 — a translated label longer than its English
// draft widens its control instead of spilling out of it, and the one place a
// label may truncate (a `fill` segment) keeps the whole label readable.

afterEach(cleanup);

const LONG = 'Arbeitselementeinstellungen speichern';

describe('Button', () => {
  it('keeps a long label on one line and renders it whole', () => {
    render(<Button>{LONG}</Button>);
    const button = screen.getByRole('button', { name: LONG });
    expect(button.className).toContain('whitespace-nowrap');
    expect(button.textContent).toBe(LONG);
  });
});

describe('Segmented', () => {
  const options = [
    { value: 'a', label: LONG },
    { value: 'b', label: 'Kurz', title: 'Eigener Hinweis' },
  ] as const;

  it('a non-fill option sizes to its label and never wraps', () => {
    render(<Segmented label="Ansicht" options={[...options]} value="a" onChange={() => {}} />);
    expect(screen.getByRole('button', { name: LONG }).className).toContain('whitespace-nowrap');
  });

  it('a fill option given no title takes its label as the title, and keeps its own', () => {
    render(<Segmented fill label="Ansicht" options={[...options]} value="a" onChange={() => {}} />);
    const long = screen.getByRole('button', { name: LONG });
    expect(long.getAttribute('title')).toBe(LONG);
    expect(screen.getByRole('button', { name: 'Kurz' }).getAttribute('title')).toBe(
      'Eigener Hinweis',
    );
  });
});
