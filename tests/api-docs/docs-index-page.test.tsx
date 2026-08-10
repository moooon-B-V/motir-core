// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/messages/en.json';
import { DOC_SURFACES } from '@/lib/apiDocs/surfaces';

// The `/docs` index (Subtask MOTIR-2523, under MOTIR-2315 · ADR
// `public-api-conventions.md` Amendment 19 · design
// `design/api-docs/docs-index.mock.html` Panels 1–2).
//
// ── This renders the REAL page module ───────────────────────────────────────
// Not a component with hand-made props. Every defect this area has actually had
// lived in the COMPOSITION — four call sites handing the rail an operation list
// (MOTIR-2307), seven pages inheriting a title (MOTIR-2526) — and a test that
// re-makes the call site's decision cannot see that class of bug.
//
// `getTranslations` is stubbed to return the KEY, as the sibling suites do, so
// the assertions below read as keys rather than as English.
vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn(async () => (key: string) => key),
}));

afterEach(() => cleanup());

async function renderIndex() {
  const { default: DocsIndexPage } = await import('@/app/(public)/docs/page');
  render(
    <NextIntlClientProvider locale="en" messages={en}>
      {await DocsIndexPage()}
    </NextIntlClientProvider>,
  );
}

describe('the /docs index', () => {
  it('leads with the AREA, not one of its surfaces', async () => {
    await renderIndex();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('indexTitle');
    expect(screen.getByText('indexLede')).toBeTruthy();
  });

  it('renders one row per DOCUMENTED SURFACE, from the shared list', async () => {
    await renderIndex();
    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(DOC_SURFACES.length);

    // Derived, not restated: the row set, its ORDER and each row's target all
    // come from `lib/apiDocs/surfaces.ts`. A surface added there lands here with
    // no edit to the page — which is the property Amendment 19 Q3 bought.
    const links = screen.getAllByRole('link');
    expect(links.map((a) => a.getAttribute('href'))).toEqual(
      DOC_SURFACES.map((surface) => surface.route),
    );
  });

  it('gives every row BOTH lines — the name and what it is for', async () => {
    await renderIndex();
    for (const surface of DOC_SURFACES) {
      const link = screen.getByRole('link', {
        name: new RegExp(`${surface.labelKey}.*${surface.descriptionKey}`, 's'),
      });
      // The whole card is the target, and the accessible name carries the
      // description — a screen-reader user gets the same routing information a
      // sighted reader does, in the same order (notes.html mistake #7).
      expect(link.getAttribute('href')).toBe(surface.route);
    }
  });

  it('renders NO catalogue rail, and therefore no operation rows', async () => {
    await renderIndex();
    // Amendment 19 Q4: the page's body IS the navigation, so a rail listing the
    // same four destinations would show them twice with the shorter copy on top.
    expect(document.querySelectorAll('nav')).toHaveLength(0);
    expect(document.querySelectorAll('[data-testid="catalogue-surfaces"]')).toHaveLength(0);
    expect(document.querySelectorAll('[data-operation-id]')).toHaveLength(0);
    expect(document.querySelectorAll('[data-testid^="catalogue-group-"]')).toHaveLength(0);
  });

  it('exports no metadata of its own, because the area default IS its own', async () => {
    // MOTIR-2526 retargeted `apiDocs.metaTitle` to the AREA's identity, and this
    // page is the area — so inheriting the layout's is correct here and only
    // here. `docs-page-metadata.test.ts` exempts this one route by name; if the
    // page ever grows a `generateMetadata`, that exemption becomes a lie.
    const mod = await import('@/app/(public)/docs/page');
    expect('generateMetadata' in mod).toBe(false);
    expect(en.apiDocs.metaTitle).toBe('Motir documentation');
  });
});
