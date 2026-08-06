// @vitest-environment happy-dom
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, within } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { stripComments } from '../helpers/v1RouteAudit';
import { V1_OPERATIONS } from '@/lib/api/v1/openapi/registry';

// The published API reference (Story 11.4 · Subtask 11.4.7 — MOTIR-2188).
//
// The same technique `tests/components/public-top-bar.test.tsx` uses for an
// async server component: mock the server translator to echo keys and render the
// component's RESOLVED tree. The client children read the real `en` catalog
// through the intl provider, so their labels are the real strings.
//
// ⚠️ Completeness — "the reference renders EVERY operation" — is asserted in
// `reference-view-model.test.ts` against the registry, because that is where it
// is decidable as two arrays rather than as a DOM sweep. This suite asserts what
// only a render can: that an operation SECTION shows each thing the criteria
// name, that the failure state is a message rather than an empty page, and that
// both doors exist and point at the reference.

vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn(async () => (key: string) => key),
}));

const REPO_ROOT = process.cwd();

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  // `vi.doMock` registration outlives `resetModules`, so the spec-unavailable
  // test's throwing builder would leak into every later `import()`. Unmock it
  // here rather than at the end of that test, so it is released even when the
  // test fails partway.
  vi.doUnmock('@/lib/apiDocs/reference');
  vi.resetModules();
});

/** Every source file under a directory, recursively. */
function sourcesUnder(dir: string): { file: string; source: string }[] {
  const found: { file: string; source: string }[] = [];
  const walk = (current: string) => {
    for (const entry of readdirSync(current)) {
      const full = join(current, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry)) {
        // Comments STRIPPED, for the reason `auditV1RouteSource` strips them in
        // its own rules: this layout's header explains the decision by NAMING
        // `getSession()`, and a check that fires on its own documentation
        // teaches the next author to delete the documentation.
        found.push({ file: full, source: stripComments(readFileSync(full, 'utf8')) });
      }
    }
  };
  walk(join(REPO_ROOT, dir));
  return found;
}

describe('the docs surface is PUBLIC by construction', () => {
  const sources = sourcesUnder('app/(public)/docs');

  it('has files to check — the sweep is not vacuous', () => {
    expect(sources.length).toBeGreaterThan(3);
  });

  it('gates on NOTHING — no session read, no redirect, no workspace context', () => {
    // Documentation a prospective integrator cannot read before signing up is
    // not published documentation. Asserted against the SOURCE, because a
    // render test can only show that the path taken was ungated.
    for (const { file, source } of sources) {
      expect(source, `${file} reads a session`).not.toMatch(/getSession|getWorkspaceContext/);
      expect(source, `${file} redirects`).not.toMatch(/from 'next\/navigation'/);
    }
  });

  it('reads the spec from the EMITTER, never over HTTP', () => {
    // A page that fetched its own public URL would add a round trip, a failure
    // mode and a bootstrapping problem for no gain.
    for (const { file, source } of sources) {
      expect(source, `${file} fetches`).not.toMatch(/\bfetch\s*\(/);
      expect(source, `${file} names the spec URL as a data source`).not.toMatch(
        /await.*openapi\/v1\.json/,
      );
    }
    const page = sources.find((s) => s.file.endsWith(join('docs', 'api', 'page.tsx')));
    expect(page?.source).toContain('buildApiReference');
  });
});

describe('an operation section', () => {
  it('shows the method, path, scope, parameters, example and every status', async () => {
    const { OperationSection } = await import('@/app/(public)/docs/_components/OperationSection');
    const { toReferenceOperation } = await import('@/lib/apiDocs/reference');
    const { findV1Operation } = await import('@/lib/api/v1/openapi/registry');

    const operation = toReferenceOperation(findV1Operation('PATCH', '/api/v1/work-items/{key}')!);
    render(await OperationSection({ operation }));

    const section = document.querySelector('[data-operation-id="updateWorkItem"]');
    expect(section).not.toBeNull();
    const scope = within(section as HTMLElement);

    expect(scope.getByText('/api/v1/work-items/{key}')).toBeTruthy();
    // The verb is abbreviated for width but its full name stays in the
    // accessible tree, so a screen reader is not handed a truncation.
    expect(scope.getAllByText('PATCH').length).toBeGreaterThan(0);
    expect(scope.getByText('work_items:write')).toBeTruthy();
    // A conditional-header parameter, a request body, and the example.
    expect(scope.getByText('If-Match')).toBeTruthy();
    expect(scope.getByText(/curl -X PATCH/)).toBeTruthy();
    expect(scope.getByText(/Bearer motir_pat_<your-token>/)).toBeTruthy();
    // Its own statuses AND the wrapper's, on the same operation.
    for (const status of ['200', '412', '422', '404', '401', '403', '429', '500']) {
      expect(scope.getAllByText(status).length, `status ${status} missing`).toBeGreaterThan(0);
    }
  });

  it('gives a 204 operation no response-body block to read', async () => {
    const { OperationSection } = await import('@/app/(public)/docs/_components/OperationSection');
    const { toReferenceOperation } = await import('@/lib/apiDocs/reference');
    const { findV1Operation } = await import('@/lib/api/v1/openapi/registry');

    const operation = toReferenceOperation(
      findV1Operation('DELETE', '/api/v1/work-items/{key}/links')!,
    );
    render(await OperationSection({ operation }));
    expect(operation.responseBody).toBeUndefined();
    expect(screen.queryByText('sectionResponseSchema')).toBeNull();
  });
});

describe('the SPEC-UNAVAILABLE state', () => {
  it('renders a message and a way out, not an empty catalogue', async () => {
    // An empty catalogue would read as "this API has no operations" — a
    // statement that is false and unfalsifiable from the outside.
    vi.doMock('@/lib/apiDocs/reference', async (importOriginal) => ({
      ...(await importOriginal<typeof import('@/lib/apiDocs/reference')>()),
      buildApiReference: () => {
        throw new Error('registry unavailable');
      },
    }));
    const { default: Page } = await import('@/app/(public)/docs/api/page');

    render(await Page());

    expect(screen.getByText('unavailableTitle')).toBeTruthy();
    expect(screen.getByText('unavailableBody')).toBeTruthy();
    // The spec is public, so the reader can still fetch it themselves.
    const specLink = screen.getByText('unavailableOpenSpec').closest('a');
    expect(specLink?.getAttribute('href')).toBe('/api/openapi/v1.json');
    // And the surface's other two pages are unaffected, so nobody is stranded.
    expect(screen.getAllByText('navGettingStarted').length).toBeGreaterThan(0);
  });
});

describe('THE PUBLIC DOOR — the shipped marketing chrome', () => {
  it('renders `Docs` as a LINK to /docs/api, where it used to be a dead label', async () => {
    const { ExploreTopBar } = await import('@/app/(public)/explore/_components/ExploreTopBar');
    render(await ExploreTopBar());

    const docs = screen.getByText('navDocs').closest('a');
    expect(docs, 'Docs is still a non-interactive label').not.toBeNull();
    expect(docs?.getAttribute('href')).toBe('/docs/api');
  });

  it('keeps Product and Pricing as labels — they still resolve to nothing', () => {
    // The bar's own rule, unchanged: a future page is a label, not a dead link a
    // crawler would 404 on. Only `Docs` graduated.
    const source = readFileSync(
      join(REPO_ROOT, 'app/(public)/explore/_components/ExploreTopBar.tsx'),
      'utf8',
    );
    expect(source).toContain("{ key: 'navProduct'");
    expect(source).toContain("{ key: 'navPricing'");
    expect(source).not.toContain("{ key: 'navDocs'");
  });

  it('marks the CURRENT page on whichever of the two resolving items is being read', async () => {
    const { ExploreTopBar } = await import('@/app/(public)/explore/_components/ExploreTopBar');

    render(await ExploreTopBar({ current: 'docs' }));
    expect(screen.getByText('navDocs').closest('a')?.getAttribute('aria-current')).toBe('page');
    expect(screen.getByText('navExplore').closest('a')?.getAttribute('aria-current')).toBeNull();
    cleanup();

    // Defaulting to `explore` keeps the project square's shipped behaviour
    // exactly as it was — this story adds a caller, it does not change one.
    render(await ExploreTopBar());
    expect(screen.getByText('navExplore').closest('a')?.getAttribute('aria-current')).toBe('page');
    expect(screen.getByText('navDocs').closest('a')?.getAttribute('aria-current')).toBeNull();
  });

  it('links API docs from the footer’s Product column — the crawl surface', async () => {
    const { ExploreFooter } = await import('@/app/(public)/explore/_components/ExploreFooter');
    render(await ExploreFooter({ topics: [{ slug: 'ai', label: 'AI' }] }));

    const link = screen.getByText('footProductApiDocs').closest('a');
    expect(link?.getAttribute('href')).toBe('/docs/api');
    // The other Product entries stay labels.
    expect(screen.getByText('footProductOverview').closest('a')).toBeNull();
  });
});

describe('THE IN-APP DOOR — the API-tokens settings page', () => {
  it('links a reader who just minted a token to the reference AND the guide', async () => {
    const { ApiDocsLinkPanel } =
      await import('@/app/(authed)/settings/account/_components/ApiDocsLinkPanel');
    render(await ApiDocsLinkPanel());

    expect(screen.getByText('doorHeading')).toBeTruthy();
    expect(screen.getByText('doorReferenceCta').closest('a')?.getAttribute('href')).toBe(
      '/docs/api',
    );
    expect(screen.getByText('navGettingStarted').closest('a')?.getAttribute('href')).toBe(
      '/docs/getting-started',
    );
  });

  it('is the ONLY thing this story adds to the tokens page', () => {
    // The card: "No file under app/(authed)/settings/account/api-tokens/ changes
    // apart from the added link." The token manager and the CLI panel belong to
    // design/settings and design/cli-connect.
    const page = readFileSync(
      join(REPO_ROOT, 'app/(authed)/settings/account/api-tokens/page.tsx'),
      'utf8',
    );
    expect(page).toContain('<ApiDocsLinkPanel />');
    // Everything that was there before is still there, untouched.
    expect(page).toContain('<ConnectCliPanel hasTokens={tokens.length > 0} />');
    expect(page).toContain('<ApiTokensManager');
    // Exactly one added element.
    expect(page.match(/<ApiDocsLinkPanel/g)).toHaveLength(1);
  });

  it('reads FIRST — above the CLI panel and the token manager', () => {
    const page = readFileSync(
      join(REPO_ROOT, 'app/(authed)/settings/account/api-tokens/page.tsx'),
      'utf8',
    );
    // The placement IS the argument (MOTIR-1869's "the route out reads first",
    // one line higher), so it is asserted rather than left to a reviewer's eye.
    expect(page.indexOf('<ApiDocsLinkPanel />')).toBeLessThan(page.indexOf('<ConnectCliPanel'));
    expect(page.indexOf('<ConnectCliPanel')).toBeLessThan(page.indexOf('<ApiTokensManager'));
  });
});

describe('the catalogue rail', () => {
  it('lists every operation the reference holds, grouped, with the four pages on top', async () => {
    const { CatalogueNav } = await import('@/app/(public)/docs/_components/CatalogueNav');
    const { buildApiReference } = await import('@/lib/apiDocs/reference');

    render(<CatalogueNav current="reference" groups={buildApiReference().groups} />);

    const listed = [...document.querySelectorAll('[data-operation-id]')].map((node) =>
      node.getAttribute('data-operation-id'),
    );
    expect(listed.sort()).toEqual(V1_OPERATIONS.map((o) => o.operationId).sort());

    // The pages are the top group in the SAME nav — what makes the reference,
    // the guides and the policy read as one surface. Story MOTIR-2268 made this
    // group four: the sandbox row is that page's ONLY entrance, so an assertion
    // that stopped at three would let it go missing silently.
    const reference = screen.getByText('API reference', { selector: 'a' });
    expect(reference.getAttribute('aria-current')).toBe('page');
    expect(screen.getByText('Getting started').getAttribute('href')).toBe('/docs/getting-started');
    expect(screen.getByText('Stability & deprecation').getAttribute('href')).toBe(
      '/docs/stability',
    );
    expect(screen.getByText('Agent sandbox').getAttribute('href')).toBe('/docs/sandbox');
  });

  it('renders the pages even when the spec could not be built', async () => {
    const { CatalogueNav } = await import('@/app/(public)/docs/_components/CatalogueNav');
    render(<CatalogueNav current="reference" groups={[]} />);

    expect(screen.getByText('Getting started')).toBeTruthy();
    expect(document.querySelectorAll('[data-operation-id]')).toHaveLength(0);
    // No find box over nothing — an empty search is worse than no search.
    expect(screen.queryByRole('searchbox')).toBeNull();
  });
});
