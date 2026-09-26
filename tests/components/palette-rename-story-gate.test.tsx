// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ThemeProvider, useTheme } from '@/lib/contexts/theme-context';
import { buildThemeInitScript } from '@/lib/theme/init-script';
import { DEFAULT_PROJECT_PALETTE_ID } from '@/lib/theme/palettes';
import { PALETTE_IDS_VERSION, THEME_STORAGE_KEYS } from '@/lib/theme/types';
import { DesignStep } from '@/components/onboarding/DesignStep';
import type { DesignChoiceDTO } from '@/lib/dto/aiPreplan';
import { renderWithIntl } from '../helpers/renderWithIntl';

// STORY INTEGRATION GATE (motir-core) — MOTIR-6475, the browser-side seams of
// story MOTIR-6470. The server seam and the guards are in
// `tests/integration/palette-rename-story-gate.test.ts`.

function PaletteProbe() {
  return <span data-testid="palette">{useTheme().palette}</span>;
}

/** Run the real inline init script against this happy-dom window. */
function runInitScript() {
  new Function(buildThemeInitScript(null))();
}

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('seam — the init script and the ThemeProvider read one migrated value', () => {
  it.each([
    ['motir', null, 'amethyst'],
    ['graphite', null, 'motir'],
    ['motir', PALETTE_IDS_VERSION, 'motir'],
  ] as const)(
    'stored %s with marker %s → the page and the provider both say %s',
    (stored, marker, expected) => {
      localStorage.setItem(THEME_STORAGE_KEYS.palette, stored);
      if (marker) localStorage.setItem(THEME_STORAGE_KEYS.paletteIds, marker);

      runInitScript();
      expect(document.documentElement.getAttribute('data-palette')).toBe(expected);

      render(
        <ThemeProvider>
          <PaletteProbe />
        </ThemeProvider>,
      );
      expect(screen.getByTestId('palette').textContent).toBe(expected);
    },
  );

  it('the provider alone migrates the same way when the init script did not run', () => {
    localStorage.setItem(THEME_STORAGE_KEYS.palette, 'motir');
    render(
      <ThemeProvider>
        <PaletteProbe />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('palette').textContent).toBe('amethyst');
  });
});

describe('seam — the onboarding restore', () => {
  function restore(paletteId: string) {
    const choice = { styleId: 'warm-editorial', paletteId, typeId: 'motir' } as DesignChoiceDTO;
    const { container } = renderWithIntl(
      <DesignStep onBack={vi.fn()} onUseDesign={vi.fn()} initialChoice={choice} />,
    );
    return container.querySelector('[data-testid="design-page"]')!.getAttribute('data-palette');
  }

  it('a saved Amethyst choice restores Amethyst', () => {
    expect(restore('amethyst')).toBe('amethyst');
  });

  it('a retired graphite choice falls back to the project default', () => {
    expect(restore('graphite')).toBe(DEFAULT_PROJECT_PALETTE_ID);
  });

  it('the System theme leaves data-theme off the page (coverage floor — MOTIR-6475)', () => {
    const { container } = renderWithIntl(<DesignStep onBack={vi.fn()} onUseDesign={vi.fn()} />);
    fireEvent.click(screen.getByRole('radio', { name: 'System' }));
    const page = container.querySelector('[data-testid="design-page"]')!;
    expect(page.hasAttribute('data-theme')).toBe(false);
    expect(page.getAttribute('data-palette')).toBe(DEFAULT_PROJECT_PALETTE_ID);
  });
});
