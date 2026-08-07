// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/messages/en.json';
import { isInApiArea, type DocsPage } from '@/app/(public)/docs/_components/CatalogueNav';

// The docs rail's TWO TIERS (Subtask MOTIR-2312, under MOTIR-2307 · ADR
// `public-api-conventions.md` Amendment 11 · design `design/api-docs/` Panel 10).
//
// ── Why this suite renders the real PAGES rather than the component ─────────
// The defect being fixed did not live in `CatalogueNav`. Every page in the area
// called it correctly, with the props it declared — and every page passed the
// full operation list, including the agent sandbox guide, which is about running
// a container. The bug was in the COMPOSITION: four call sites, one of which
// should never have been handing those groups over, and a component that had no
// opinion about it. A test that renders the component with hand-made props
// cannot see that class of defect, because it re-makes the same decision the
// call sites were getting wrong.
//
// So each case below imports a real page module and renders what it returns.
//
// The pages are Server Components, so `getTranslations` is stubbed the way the
// sibling suites do — it returns the KEY, which is why page chrome would be
// asserted by key. The rail is a CLIENT component reading `useTranslations`, so
// the render below wraps the tree in a provider seeded with the real `en`
// catalog and rail rows are asserted by their production English strings.
vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn(async () => (key: string) => key),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.resetModules();
});

/**
 * Render a real docs page to HTML and hand back its rail.
 *
 * ⚠️ SERVER-rendered on purpose, via `react-dom/server.edge` — the same escape
 * hatch `story-gate.test.tsx` uses. `/docs/api`'s happy path renders
 * `<OperationSection>`, which is an ASYNC server component, and React's CLIENT
 * renderer suspends on one forever: Testing Library's `render` produces an empty
 * container rather than an error. (That is exactly why the shipped
 * `reference-page.test.tsx` only ever renders this page's UNAVAILABLE branch.)
 * Since the surface is a public, static, server-rendered page, HTML is also the
 * thing a reader actually receives — so this asserts closer to production than a
 * client render would.
 */
async function renderRail(pagePath: string): Promise<HTMLElement> {
  const { default: Page } = await import(pagePath);
  const { renderToReadableStream } = await import('react-dom/server.edge');
  const stream = await renderToReadableStream(
    <NextIntlClientProvider locale="en" messages={en}>
      {await (Page as () => Promise<React.ReactElement>)()}
    </NextIntlClientProvider>,
  );
  document.body.innerHTML = await new Response(stream).text();

  const nav = document.querySelector('nav');
  expect(nav, `${pagePath} rendered no rail`).not.toBeNull();
  return nav as HTMLElement;
}

const operationRows = (rail: HTMLElement) => rail.querySelectorAll('[data-operation-id]');
const operationGroups = (rail: HTMLElement) =>
  rail.querySelectorAll('[data-testid^="catalogue-group-"]');

describe('the prefix is what decides — Amendment 11 Q2', () => {
  it('puts the reference and its two guides inside the API area, and the sandbox outside', () => {
    // The gate is a pure function of the page's ROUTE, so it is asserted
    // directly as well as through the pages: a future page added to `DocsPage`
    // with no route gets a compile error, and one added under `/docs/api`
    // inherits the second tier with no further edit.
    expect(isInApiArea('reference')).toBe(true);
    expect(isInApiArea('gettingStarted')).toBe(true);
    expect(isInApiArea('stability')).toBe(true);
    expect(isInApiArea('sandbox')).toBe(false);
  });

  it('is total over every DocsPage', () => {
    const pages: DocsPage[] = ['reference', 'gettingStarted', 'stability', 'sandbox'];
    for (const page of pages) {
      expect(typeof isInApiArea(page)).toBe('boolean');
    }
  });
});

describe('a GUIDE page is not framed by the REST API', () => {
  it('/docs/sandbox renders no operation rows and no operation groups', async () => {
    const rail = await renderRail('@/app/(public)/docs/sandbox/page');

    // The whole point of MOTIR-2307, asserted at the composition level: this
    // page used to render all ~28 of them.
    expect(operationRows(rail)).toHaveLength(0);
    expect(operationGroups(rail)).toHaveLength(0);
  });

  it('/docs/sandbox shows the surfaces tier ONLY — no second tier', async () => {
    const rail = await renderRail('@/app/(public)/docs/sandbox/page');

    expect(rail.querySelector('[data-testid="catalogue-surfaces"]')).not.toBeNull();
    expect(rail.querySelector('[data-testid="catalogue-subarea-api"]')).toBeNull();
  });

  it("/docs/sandbox's rail is not announced as the API reference", async () => {
    const rail = await renderRail('@/app/(public)/docs/sandbox/page');

    // It was the literal string "API reference" on every page in the area,
    // including this one — a false statement spoken to a screen-reader user.
    expect(rail.getAttribute('aria-label')).toBe('Documentation');
  });

  it('/docs/sandbox keeps a visible way BACK to the API — the access path', async () => {
    const rail = await renderRail('@/app/(public)/docs/sandbox/page');

    // Removing the operation list from a guide page owes the reader the door in
    // exchange. If this row ever disappears, the regrouping has traded one
    // navigation defect for a worse one.
    const back = [...rail.querySelectorAll('a')].find(
      (anchor) => anchor.getAttribute('href') === '/docs/api',
    );
    expect(back, 'no route from the sandbox guide back to the API reference').toBeDefined();
    expect(back?.textContent).toContain('API reference');
  });
});

describe('an API page gets both tiers and the operation index', () => {
  it('/docs/api renders the surfaces tier, the API tier, and operation rows', async () => {
    const rail = await renderRail('@/app/(public)/docs/api/page');

    expect(rail.querySelector('[data-testid="catalogue-surfaces"]')).not.toBeNull();
    expect(rail.querySelector('[data-testid="catalogue-subarea-api"]')).not.toBeNull();
    expect(operationRows(rail).length).toBeGreaterThan(0);
  });

  it('/docs/api/getting-started renders both tiers, with itself current', async () => {
    const rail = await renderRail('@/app/(public)/docs/api/getting-started/page');

    expect(rail.querySelector('[data-testid="catalogue-subarea-api"]')).not.toBeNull();
    const current = rail.querySelector('a[aria-current="page"]');
    expect(current?.getAttribute('href')).toBe('/docs/api/getting-started');
  });

  it('/docs/api/stability renders both tiers, with itself current', async () => {
    const rail = await renderRail('@/app/(public)/docs/api/stability/page');

    expect(rail.querySelector('[data-testid="catalogue-subarea-api"]')).not.toBeNull();
    const current = rail.querySelector('a[aria-current="page"]');
    expect(current?.getAttribute('href')).toBe('/docs/api/stability');
  });

  it('marks exactly ONE row current, on every page in the area', async () => {
    // Tier 1's row for the current SURFACE is deliberately NOT also marked: the
    // second tier's presence is the "you are here" signal for the sub-area, so
    // the component needed no new state. Two `aria-current` rows in one nav is
    // the regression this catches.
    for (const pageModule of [
      '@/app/(public)/docs/api/page',
      '@/app/(public)/docs/api/getting-started/page',
      '@/app/(public)/docs/api/stability/page',
      '@/app/(public)/docs/sandbox/page',
    ]) {
      const rail = await renderRail(pageModule);
      expect(rail.querySelectorAll('a[aria-current="page"]'), pageModule).toHaveLength(1);
      vi.resetModules();
    }
  });
});

describe('the surfaces tier lists SURFACES, not pages', () => {
  it('holds exactly the documented surfaces, each pointing at its index', async () => {
    const rail = await renderRail('@/app/(public)/docs/api/page');
    const tier = rail.querySelector('[data-testid="catalogue-surfaces"]') as HTMLElement;

    const hrefs = [...tier.querySelectorAll('a')].map((anchor) => anchor.getAttribute('href'));
    // The guide and the policy are NOT here — they are the API's own pages and
    // belong to tier 2. That separation is the fix; a regression puts them back.
    //
    // RE-POINTED, not loosened, by Story MOTIR-2308 (`/docs/cli`): this list
    // GROWS by one row per documented surface, and it stays an exact array so
    // the next row is a deliberate edit. What it must never gain is a PAGE.
    expect(hrefs).toEqual(['/docs/api', '/docs/sandbox', '/docs/cli']);
  });

  it('still gives a one-page surface NO second tier', async () => {
    // The property the exact array above cannot state: `/docs/cli` joining the
    // tier must not drag a sub-area tier or the operation index along with it
    // (ADR Amendment 12 Q1 · Amendment 11 Q2 — both are gated on the
    // `/docs/api` prefix, not on membership of this list).
    const rail = await renderRail('@/app/(public)/docs/cli/page');
    expect(rail.querySelector('[data-testid="catalogue-subarea-api"]')).toBeNull();
    expect(rail.querySelector('[data-operation-id]')).toBeNull();
    expect(rail.querySelectorAll('a[aria-current="page"]')).toHaveLength(1);
  });
});
