// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ThemeProvider } from '@/lib/contexts/theme-context';
import { ThemeToggle } from '@/app/(authed)/_components/ThemeToggle';
import { THEME_STORAGE_KEYS } from '@/lib/theme/types';

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => cleanup());

function renderToggle() {
  return render(
    <ThemeProvider>
      <ThemeToggle />
    </ThemeProvider>,
  );
}

describe('ThemeToggle', () => {
  it('cycles light → dark → system → light and persists each choice', () => {
    renderToggle();
    const button = screen.getByRole('button');

    // Default pattern is `system` (THEME_DEFAULTS) on a clean localStorage.
    expect(button.getAttribute('aria-label')).toContain('System');

    fireEvent.click(button); // system → light
    expect(button.getAttribute('aria-label')).toContain('Light');
    expect(localStorage.getItem(THEME_STORAGE_KEYS.pattern)).toBe('light');

    fireEvent.click(button); // light → dark
    expect(button.getAttribute('aria-label')).toContain('Dark');
    expect(localStorage.getItem(THEME_STORAGE_KEYS.pattern)).toBe('dark');

    fireEvent.click(button); // dark → system
    expect(button.getAttribute('aria-label')).toContain('System');
    expect(localStorage.getItem(THEME_STORAGE_KEYS.pattern)).toBe('system');

    fireEvent.click(button); // system → light (wraps)
    expect(button.getAttribute('aria-label')).toContain('Light');
  });

  it('reflects a pre-existing saved preference on mount', () => {
    localStorage.setItem(THEME_STORAGE_KEYS.pattern, 'dark');
    renderToggle();
    expect(screen.getByRole('button').getAttribute('aria-label')).toContain('Dark');
  });
});
