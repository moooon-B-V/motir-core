// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { TOKEN_SCOPES } from '@/lib/mcp/scopes';
import { mcpClients, mcpToolCount, mcpToolRows, mcpTransportFacts } from '@/lib/apiDocs/mcp';

// The published MCP pages (Story MOTIR-2309 · Subtask MOTIR-2327 · ADR
// Amendment 13).
//
// The page is a Server Component, so `getTranslations` is stubbed the way the
// sibling guide suites do — it returns the KEY, which is why page chrome is
// asserted by key and rail chrome (a client component, given real messages by
// `renderWithIntl`) by its English string.

vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn(async () => {
    const t = (key: string) => key;
    return t;
  }),
}));

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (file: string) => readFileSync(join(REPO_ROOT, file), 'utf8');

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.resetModules();
});

describe('/docs/mcp — the wiring page', () => {
  it('renders unauthenticated, with the rail marking itself current', async () => {
    const { default: Page } = await import('@/app/(public)/docs/mcp/page');
    renderWithIntl(await Page());

    const current = document.querySelector('nav a[aria-current="page"]');
    expect(current?.getAttribute('href')).toBe('/docs/mcp');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('mcpTitle');
  });

  it('renders NO /api/v1 operation rows — it is outside the API sub-area', async () => {
    const { default: Page } = await import('@/app/(public)/docs/mcp/page');
    renderWithIntl(await Page());

    const nav = document.querySelector('nav');
    expect(nav?.querySelectorAll('[data-operation-id]').length).toBe(0);
    // …and the operation search box the API pages carry is absent too.
    expect(nav?.querySelector('input[type="search"]')).toBeNull();
  });

  it('carries a wiring block for every client, each with its file and vendor link', async () => {
    const { default: Page } = await import('@/app/(public)/docs/mcp/page');
    const { container } = renderWithIntl(await Page());

    for (const client of mcpClients()) {
      expect(container.textContent).toContain(client.label);
      expect(container.textContent).toContain(client.file);
      expect(container.querySelector(`a[href="${client.docsUrl}"]`)).not.toBeNull();
    }
  });

  it('shows every client’s config, carrying the one endpoint', async () => {
    const { default: Page } = await import('@/app/(public)/docs/mcp/page');
    const { container } = renderWithIntl(await Page());

    const url = mcpTransportFacts().url;
    const code = [...container.querySelectorAll('pre')].map((node) => node.textContent ?? '');
    expect(code.length).toBeGreaterThanOrEqual(mcpClients().length);
    // Every client block names the same endpoint — the containment Amendment 13
    // Q3a buys, observed here at the surface a reader actually copies from.
    const blocksWithUrl = code.filter((text) => text.includes(url));
    expect(blocksWithUrl.length).toBe(mcpClients().length);
  });

  it('never renders a plausible-looking credential', async () => {
    const { default: Page } = await import('@/app/(public)/docs/mcp/page');
    const { container } = renderWithIntl(await Page());
    expect(container.textContent).not.toMatch(/motir_pat_[A-Za-z0-9]{10,}/);
  });

  it('lists every scope in the legend, marking the one that is off by default', async () => {
    const { default: Page } = await import('@/app/(public)/docs/mcp/page');
    const { container } = renderWithIntl(await Page());

    for (const scope of TOKEN_SCOPES) {
      expect(container.textContent).toContain(scope);
    }
    expect(container.textContent).toContain('mcpScopeDefaultOff');
  });

  it('links on to the catalogue and out to the reference', async () => {
    const { default: Page } = await import('@/app/(public)/docs/mcp/page');
    const { container } = renderWithIntl(await Page());

    expect(container.querySelector('a[href="/docs/mcp/tools"]')).not.toBeNull();
    expect(container.querySelector('a[href*="docs/mcp.md"]')).not.toBeNull();
  });
});

describe('/docs/mcp/tools — the catalogue', () => {
  it('renders unauthenticated, with the rail marking itself current', async () => {
    const { default: Page } = await import('@/app/(public)/docs/mcp/tools/page');
    renderWithIntl(await Page());

    const current = document.querySelector('nav a[aria-current="page"]');
    expect(current?.getAttribute('href')).toBe('/docs/mcp/tools');
  });

  it('renders EVERY derived tool — nothing truncated, capped or paginated away', async () => {
    const { default: Page } = await import('@/app/(public)/docs/mcp/tools/page');
    const { container } = renderWithIntl(await Page());

    for (const row of mcpToolRows()) {
      expect(container.textContent).toContain(row.name);
    }
  });

  it('shows a count that is the DERIVED length, and a group per populated scope', async () => {
    const { default: Page } = await import('@/app/(public)/docs/mcp/tools/page');
    const { container } = renderWithIntl(await Page());

    const groups = container.querySelectorAll('[data-testid^="mcp-group-"]');
    expect(groups.length).toBeGreaterThan(0);
    // Every rendered group belongs to a real scope.
    for (const group of groups) {
      const scope = group.getAttribute('data-testid')?.replace('mcp-group-', '');
      expect(TOKEN_SCOPES).toContain(scope);
    }
    // The tools rendered across the groups are exactly the derived set.
    const rendered = mcpToolRows().filter((row) => container.textContent?.includes(row.name));
    expect(rendered.length).toBe(mcpToolCount());
  });

  it('renders no /api/v1 operation rows', async () => {
    const { default: Page } = await import('@/app/(public)/docs/mcp/tools/page');
    renderWithIntl(await Page());
    expect(document.querySelectorAll('[data-operation-id]').length).toBe(0);
  });

  it('renders the EMPTY state, and no bare column, when the derivation yields nothing', async () => {
    vi.resetModules();
    vi.doMock('@/lib/apiDocs/mcp', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@/lib/apiDocs/mcp')>();
      return { ...actual, mcpCatalogue: () => [], mcpToolCount: () => 0 };
    });

    const { default: Page } = await import('@/app/(public)/docs/mcp/tools/page');
    const { container } = renderWithIntl(await Page());

    expect(container.querySelector('[data-testid="mcp-tools-empty"]')).not.toBeNull();
    expect(container.textContent).toContain('mcpToolsEmptyTitle');
    // The reader is kept moving rather than parked on a dead page.
    expect(container.querySelector('a[href="/docs/mcp"]')).not.toBeNull();
    // …and no group heading renders over nothing.
    expect(container.querySelectorAll('[data-testid^="mcp-group-"]').length).toBe(0);
    vi.doUnmock('@/lib/apiDocs/mcp');
  });
});

describe('the rail carries TWO sub-areas (Amendment 13 Q1)', () => {
  it('renders the MCP’s second tier inside /docs/mcp/* and its pages only', async () => {
    const { CatalogueNav } = await import('@/app/(public)/docs/_components/CatalogueNav');
    const { container } = renderWithIntl(<CatalogueNav current="mcpTools" />);

    const tier2 = container.querySelector('[data-testid="catalogue-subarea-mcp"]');
    expect(tier2).not.toBeNull();
    const hrefs = [...(tier2?.querySelectorAll('a') ?? [])].map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual(['/docs/mcp/tools']);
    // The API sub-area's tier must NOT render here.
    expect(container.querySelector('[data-testid="catalogue-subarea-api"]')).toBeNull();
  });

  it('still renders the API’s second tier inside /docs/api/*, and only its pages', async () => {
    const { CatalogueNav } = await import('@/app/(public)/docs/_components/CatalogueNav');
    const { container } = renderWithIntl(<CatalogueNav current="gettingStarted" groups={[]} />);

    const tier2 = container.querySelector('[data-testid="catalogue-subarea-api"]');
    expect(tier2).not.toBeNull();
    const hrefs = [...(tier2?.querySelectorAll('a') ?? [])].map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual(['/docs/api/getting-started', '/docs/api/stability']);
    expect(container.querySelector('[data-testid="catalogue-subarea-mcp"]')).toBeNull();
  });

  it('gives a SINGLE-page surface no second tier at all', async () => {
    const { CatalogueNav } = await import('@/app/(public)/docs/_components/CatalogueNav');
    const { container } = renderWithIntl(<CatalogueNav current="sandbox" />);
    expect(container.querySelectorAll('[data-testid^="catalogue-subarea-"]').length).toBe(0);
  });

  it('lists the MCP in the SURFACE tier, on every page in the area', async () => {
    const { CatalogueNav } = await import('@/app/(public)/docs/_components/CatalogueNav');
    for (const current of ['sandbox', 'reference', 'mcp'] as const) {
      cleanup();
      const { container } = renderWithIntl(<CatalogueNav current={current} groups={[]} />);
      const surfaces = container.querySelector('[data-testid="catalogue-surfaces"]');
      const hrefs = [...(surfaces?.querySelectorAll('a') ?? [])].map((a) => a.getAttribute('href'));
      expect(hrefs).toContain('/docs/mcp');
    }
  });

  it('routes each sub-area page to its own tier — the PREFIX decides, not a prop', async () => {
    const { subAreaFor } = await import('@/app/(public)/docs/_components/CatalogueNav');
    expect(subAreaFor('mcp')?.prefix).toBe('/docs/mcp');
    expect(subAreaFor('mcpTools')?.prefix).toBe('/docs/mcp');
    expect(subAreaFor('reference')?.prefix).toBe('/docs/api');
    expect(subAreaFor('stability')?.prefix).toBe('/docs/api');
    expect(subAreaFor('sandbox')).toBeUndefined();
  });
});

describe('the source boundaries', () => {
  it('imports no MCP registry from any public page', () => {
    for (const file of ['app/(public)/docs/mcp/page.tsx', 'app/(public)/docs/mcp/tools/page.tsx']) {
      expect(read(file)).not.toContain('lib/mcp/registry');
    }
  });

  it('keeps every new chrome key in BOTH catalogs', () => {
    const en = JSON.parse(read('messages/en.json')) as { apiDocs: Record<string, string> };
    const zh = JSON.parse(read('messages/zh.json')) as { apiDocs: Record<string, string> };
    const mcpKeys = Object.keys(en.apiDocs).filter((key) => key.startsWith('mcp'));
    expect(mcpKeys.length).toBeGreaterThan(0);
    for (const key of mcpKeys) {
      expect(key in zh.apiDocs, `zh.json is missing apiDocs.${key}`).toBe(true);
    }
  });

  it('translates the zh chrome rather than echoing the English', () => {
    const en = JSON.parse(read('messages/en.json')) as { apiDocs: Record<string, string> };
    const zh = JSON.parse(read('messages/zh.json')) as { apiDocs: Record<string, string> };
    // Prose keys must differ; short technical labels legitimately may not.
    for (const key of ['mcpTitle', 'mcpLede', 'mcpToolsLede', 'mcpToolsEmptyBody']) {
      expect(zh.apiDocs[key]).not.toBe(en.apiDocs[key]);
      expect(zh.apiDocs[key]).toMatch(/[一-鿿]/);
    }
  });
});

describe('the in-app door (MOTIR-2328)', () => {
  it('points the API-tokens empty state at the published page, not a GitHub blob', () => {
    const source = read('app/(authed)/settings/account/_components/ApiTokensManager.tsx');
    expect(source).toContain("const MCP_GUIDE_HREF = '/docs/mcp'");
    // The whole point of the card: a user who has just minted their first token
    // is no longer sent out of the product to a raw file on a source-code host.
    expect(source).not.toContain('github.com/moooon-B-V/motir-core/blob/main/docs/mcp.md');
  });

  it('opens that link in THIS tab — it is in-product navigation now', () => {
    const source = read('app/(authed)/settings/account/_components/ApiTokensManager.tsx');
    const anchor = source.slice(
      source.indexOf('href={MCP_GUIDE_HREF}'),
      source.indexOf('empty.guideLink'),
    );
    expect(anchor).not.toContain('target="_blank"');
  });

  it('links docs/mcp.md BACK to the published guide and its catalogue', () => {
    const reference = read('docs/mcp.md');
    expect(reference).toContain('/docs/mcp');
    expect(reference).toContain('/docs/mcp/tools');
  });
});
