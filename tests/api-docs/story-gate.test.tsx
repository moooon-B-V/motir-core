// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/messages/en.json';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { declaredScopeByMethod, stripComments } from '../helpers/v1RouteAudit';
import { emitOpenApiDocument } from '@/lib/api/v1/openapi/emit';
import {
  V1_PAGE_ENVELOPE_COMPONENT,
  V1_RANKED_PAGE_ENVELOPE_COMPONENT,
} from '@/lib/api/v1/openapi/envelopes';
import {
  V1_ERROR_BODY_COMPONENT,
  V1_INTERNAL_ERROR_BODY_COMPONENT,
} from '@/lib/api/v1/openapi/errorResponse';
import { V1_SHARED_RESPONSE_HEADERS } from '@/lib/api/v1/openapi/headers';
import { V1_SECURITY_SCHEME_NAME } from '@/lib/api/v1/openapi/security';
import { operationKey } from '@/lib/api/v1/openapi/operation';
import { V1_OPERATIONS, findV1Operation } from '@/lib/api/v1/openapi/registry';
import { buildApiReference, toReferenceOperation } from '@/lib/apiDocs/reference';
import { GUIDE_STEPS } from '@/lib/apiDocs/guide';

// STORY 11.4's VITEST GATE (Subtask 11.4.9 — MOTIR-2190).
//
// Five cards build one chain — shapes declared, operations described, a document
// assembled, a route serving it, a page rendering it — and each tests its own
// link with the neighbours stubbed. The failures that survive are the ones
// BETWEEN links, which belong to no single card. This suite drives the real
// compositions, plus the contract properties a coverage percentage cannot see.
//
// ⚠️ It does NOT re-derive Subtask 11.4.6's three drifts (a route with no
// operation, an operation with no route, a response that does not match its
// schema). Those are that card's, and duplicating them here would make a later
// change fail in two places with two different messages.

const REPO_ROOT = process.cwd();

vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn(async () => (key: string) => key),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.doUnmock('@/lib/apiDocs/reference');
  vi.resetModules();
});

/** Render an async server-component tree to HTML, client children included. */
async function renderPageToHtml(page: React.ReactElement): Promise<string> {
  const { renderToReadableStream } = await import('react-dom/server.edge');
  const stream = await renderToReadableStream(
    <NextIntlClientProvider locale="en" messages={en}>
      {page}
    </NextIntlClientProvider>,
  );
  return new Response(stream).text();
}

// ─────────────────────────────────────────────────────────────────────────────
// SEAM 1 — the shared schemas reach the emitted document as real components
// ─────────────────────────────────────────────────────────────────────────────

describe('seam: 11.4.3’s shared schemas → 11.4.4’s document', () => {
  const document = emitOpenApiDocument();
  const components = (document['components'] as Record<string, Record<string, unknown>>)[
    'schemas'
  ] as Record<string, unknown>;

  it('registers every shared shape as a real component', () => {
    for (const name of [
      V1_ERROR_BODY_COMPONENT,
      V1_INTERNAL_ERROR_BODY_COMPONENT,
      V1_PAGE_ENVELOPE_COMPONENT,
      V1_RANKED_PAGE_ENVELOPE_COMPONENT,
    ]) {
      expect(components[name], `${name} missing from components.schemas`).toBeDefined();
    }
  });

  it('REFERENCES the envelopes rather than inlining one per operation', () => {
    // The property that makes the shared layer shared. An inlined copy per
    // collection would validate identically and drift independently.
    const serialised = JSON.stringify(document);
    const pageRefs =
      serialised.split(`"#/components/schemas/${V1_PAGE_ENVELOPE_COMPONENT}"`).length - 1;
    const rankedRefs =
      serialised.split(`"#/components/schemas/${V1_RANKED_PAGE_ENVELOPE_COMPONENT}"`).length - 1;
    expect(pageRefs).toBe(V1_OPERATIONS.filter((o) => o.response.body.kind === 'page').length);
    expect(rankedRefs).toBe(
      V1_OPERATIONS.filter((o) => o.response.body.kind === 'rankedPage').length,
    );
    expect(pageRefs).toBeGreaterThan(1);
  });

  it('puts 11.4.3’s rate-limit + request-id headers on every response object', () => {
    const paths = document['paths'] as Record<string, Record<string, Record<string, never>>>;
    const declared = V1_SHARED_RESPONSE_HEADERS.map((header) => header.name);
    let checked = 0;
    for (const operation of V1_OPERATIONS) {
      const responses = paths[operation.path]?.[operation.method.toLowerCase()]?.[
        'responses'
      ] as unknown as Record<string, { headers: Record<string, unknown> }>;
      for (const status of Object.keys(responses)) {
        expect(
          Object.keys(responses[status]?.headers ?? {}),
          `${operation.operationId} ${status}`,
        ).toEqual(declared);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(100);
  });

  it('applies 11.4.3’s security scheme to every operation', () => {
    const paths = document['paths'] as Record<string, Record<string, Record<string, unknown>>>;
    for (const operation of V1_OPERATIONS) {
      expect(
        paths[operation.path]?.[operation.method.toLowerCase()]?.['security'],
        operationKey(operation),
      ).toEqual([{ [V1_SECURITY_SCHEME_NAME]: [] }]);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SEAM 2 — the emitter's document is the one the route serves
// ─────────────────────────────────────────────────────────────────────────────

describe('seam: 11.4.4’s emitter → the served route', () => {
  it('serves BYTE-IDENTICAL output to what the emitter produces', async () => {
    // Not "a document assembled a second way for the test": the same value,
    // serialised the same way, so the route cannot post-process the contract.
    const { GET } = await import('@/app/api/openapi/v1.json/route');
    const served: unknown = await (await GET()).json();
    expect(JSON.stringify(served)).toBe(JSON.stringify(emitOpenApiDocument()));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SEAM 3 — the document and the page describe the same API
// ─────────────────────────────────────────────────────────────────────────────

describe('seam: the document → 11.4.7’s reference page', () => {
  it('renders every operation the DOCUMENT carries — the whole page, not a sample', async () => {
    const { default: Page } = await import('@/app/(public)/docs/api/page');
    const html = await renderPageToHtml(await Page());

    const document = emitOpenApiDocument();
    const paths = document['paths'] as Record<string, Record<string, unknown>>;
    const documented = Object.entries(paths).flatMap(([path, verbs]) =>
      Object.keys(verbs).map((verb) => ({ path, verb })),
    );
    expect(documented.length).toBe(V1_OPERATIONS.length);

    for (const { path, verb } of documented) {
      const operation = findV1Operation(verb.toUpperCase(), path)!;
      expect(html, `${operation.operationId} is in the document but not on the page`).toContain(
        `data-operation-id="${operation.operationId}"`,
      );
    }
  });

  it('renders no operation the document does NOT carry', async () => {
    const { default: Page } = await import('@/app/(public)/docs/api/page');
    const html = await renderPageToHtml(await Page());
    const rendered = [...html.matchAll(/data-operation-id="([^"]+)"/g)].map(([, id]) => id);
    for (const id of new Set(rendered)) {
      expect(
        V1_OPERATIONS.some((operation) => operation.operationId === id),
        id,
      ).toBe(true);
    }
    // Each operation appears twice — once in the rail, once as its section.
    expect(new Set(rendered).size).toBe(V1_OPERATIONS.length);
  });

  it('shows the scope the DOCUMENT declares, on the page, for every operation', async () => {
    const { default: Page } = await import('@/app/(public)/docs/api/page');
    const html = await renderPageToHtml(await Page());
    for (const operation of V1_OPERATIONS) {
      expect(html, `${operation.operationId}: scope missing`).toContain(operation.scope);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SEAM 4 — the registry's scopes are the routes' scopes
// ─────────────────────────────────────────────────────────────────────────────

describe('seam: the registry → the real route tree', () => {
  it('declares the scope each route file declares to withV1Route', () => {
    for (const operation of V1_OPERATIONS) {
      const file = join(
        'app',
        ...operation.path
          .replace(/^\//, '')
          .split('/')
          .map((segment) => (segment.startsWith('{') ? `[${segment.slice(1, -1)}]` : segment)),
        'route.ts',
      );
      const source = readFileSync(join(REPO_ROOT, file), 'utf8');
      expect(declaredScopeByMethod(source).get(operation.method), operationKey(operation)).toBe(
        operation.scope,
      );
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SEAM 5 — the guide describes routes that exist
// ─────────────────────────────────────────────────────────────────────────────

describe('seam: 11.4.8’s guide → the API', () => {
  it('names endpoints, parameters and headers that all resolve', () => {
    const headers = V1_SHARED_RESPONSE_HEADERS.map((header) => header.name);
    let claims = 0;
    for (const step of GUIDE_STEPS) {
      if (step.endpoint) {
        const operation = findV1Operation(step.endpoint.method, step.endpoint.path);
        expect(operation, `${step.id}: ${step.endpoint.path}`).toBeDefined();
        claims += 1;
        for (const parameter of step.parameters ?? []) {
          expect(
            operation!.parameters.map((p) => p.name),
            `${step.id}: ?${parameter}=`,
          ).toContain(parameter);
          claims += 1;
        }
      }
      for (const header of step.headers ?? []) {
        expect(headers, `${step.id}: ${header}`).toContain(header);
        claims += 1;
      }
    }
    expect(claims).toBeGreaterThan(8);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GUARDS — what a coverage percentage cannot see
// ─────────────────────────────────────────────────────────────────────────────

describe('guard: the document is DETERMINISTIC', () => {
  it('emits byte-identical output twice from the same registry', () => {
    // If key order wandered, every future PR would show a document diff and
    // "did the public contract change?" would become unanswerable behind noise
    // instead of behind silence.
    expect(JSON.stringify(emitOpenApiDocument())).toBe(JSON.stringify(emitOpenApiDocument()));
  });

  it('is stable across an emitter OPTION that should not reorder anything', () => {
    const withServer = emitOpenApiDocument({ serverUrl: 'https://motir.internal' });
    const { servers: _servers, ...rest } = withServer as Record<string, unknown>;
    expect(JSON.stringify(rest)).toBe(JSON.stringify(emitOpenApiDocument()));
  });
});

describe('guard: the emitter is REQUEST-INDEPENDENT', () => {
  const source = stripComments(readFileSync(join(REPO_ROOT, 'lib/api/v1/openapi/emit.ts'), 'utf8'));

  it('takes no Request, no session and no workspace — a per-caller contract is not a contract', () => {
    expect(source).not.toMatch(/\bRequest\b/);
    expect(source).not.toMatch(/getSession|workspaceId|ServiceContext|headers\(\)|cookies\(\)/);
  });

  it('reads no database', () => {
    expect(source).not.toMatch(/@\/lib\/db|Repository|Service\b|\$transaction/);
  });

  it('WOULD fail on an emitter that read the caller — the guard has teeth', () => {
    // The same rules against a deliberately-violating source, so a passing run
    // above means the rules fired rather than that they match nothing.
    const violating = 'export function emit(req: Request) { return getSession(); }';
    expect(violating).toMatch(/\bRequest\b/);
    expect(violating).toMatch(/getSession/);
  });
});

describe('guard: the reference page does not fetch its own public URL', () => {
  it('reads the emitter directly — the app must not need to be up to describe itself', () => {
    for (const file of [
      'app/(public)/docs/api/page.tsx',
      'app/(public)/docs/getting-started/page.tsx',
      'app/(public)/docs/stability/page.tsx',
      // Story MOTIR-2268's fourth page. It derives its profile table from the
      // CLI's own record at BUILD time, which is the same principle this guard
      // protects: a documentation page describes the system by reading it, never
      // by calling it over the network.
      'app/(public)/docs/sandbox/page.tsx',
    ]) {
      const source = stripComments(readFileSync(join(REPO_ROOT, file), 'utf8'));
      expect(source, `${file} fetches`).not.toMatch(/\bfetch\s*\(/);
      expect(source, `${file} names its own spec URL`).not.toContain('/api/openapi/v1.json');
    }
    expect(
      stripComments(readFileSync(join(REPO_ROOT, 'app/(public)/docs/api/page.tsx'), 'utf8')),
    ).toContain('buildApiReference');
  });
});

describe('guard: the spec route’s exemption stays bounded', () => {
  it('exempts exactly ONE path, and that file is inert', () => {
    // 11.4.6 asserts the audit does not SEE this file. This asserts the other
    // half: that the one file outside the audit earns being outside it.
    const source = stripComments(
      readFileSync(join(REPO_ROOT, 'app/api/openapi/v1.json/route.ts'), 'utf8'),
    );
    expect(source).not.toMatch(/authenticateApiToken|getSession|withV1Route/);
    expect(source).not.toMatch(/\$transaction|@\/lib\/db|Repository/);
    expect(source).toMatch(/export async function GET\(\)/);
  });
});

describe('guard: no cuid reaches the PUBLISHED description of the API', () => {
  // The identifier rule `tests/api/v1/story-gate.test.ts` asserts for response
  // BODIES, applied to the document that describes them. A cuid in an example
  // teaches an integrator to address a resource the way ADR §7 forbids.
  const CUID = /\bc[a-z0-9]{24}\b/g;

  it('the emitted document carries none', () => {
    expect(JSON.stringify(emitOpenApiDocument()).match(CUID) ?? []).toEqual([]);
  });

  it('no operation EXAMPLE carries one', () => {
    for (const operation of V1_OPERATIONS) {
      const rendered = toReferenceOperation(operation);
      expect(rendered.example.match(CUID) ?? [], operation.operationId).toEqual([]);
    }
  });

  it('the guide carries none', () => {
    const text = JSON.stringify(GUIDE_STEPS);
    expect(text.match(CUID) ?? []).toEqual([]);
  });

  it('WOULD catch one — the pattern matches a real cuid', () => {
    expect('cms6t9vqr000i04kwtj5hfyub'.match(CUID)).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// COVERAGE TOP-UPS — the seams no single subtask's units reach
// ─────────────────────────────────────────────────────────────────────────────
//
// Each subtask ships its own units as the floor; these are the paths that only
// exist once the pieces are assembled — an interaction on a client island, a
// layout that only renders inside a route, a failure branch a happy-path render
// never takes.

describe('the code block’s COPY affordance', () => {
  const write = vi.fn(async () => undefined);

  beforeEach(() => {
    write.mockClear();
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: write },
      configurable: true,
    });
  });

  it('copies the sample and confirms IN THE BUTTON, not in a toast', async () => {
    // The reader is looking at the thing they clicked; a toast would announce a
    // success they can already see.
    const { CodeBlock } = await import('@/app/(public)/docs/_components/CodeBlock');
    render(<CodeBlock caption="curl" code="curl https://app.motir.co/api/v1/me" copyable />);

    const button = screen.getByRole('button', { name: 'Copy' });
    fireEvent.click(button);

    expect(write).toHaveBeenCalledWith('curl https://app.motir.co/api/v1/me');
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeTruthy();
  });

  it('RETURNS to “Copy” — the confirmation is transient, not a new resting state', async () => {
    vi.useFakeTimers();
    try {
      const { CodeBlock } = await import('@/app/(public)/docs/_components/CodeBlock');
      render(<CodeBlock caption="curl" code="curl x" copyable />);
      fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
      await vi.waitFor(() => expect(screen.getByRole('button', { name: 'Copied' })).toBeTruthy());
      act(() => {
        vi.advanceTimersByTime(2000);
      });
      expect(screen.getByRole('button', { name: 'Copy' })).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives a SCHEMA block no copy button — a schema is read, not run', async () => {
    const { CodeBlock } = await import('@/app/(public)/docs/_components/CodeBlock');
    render(<CodeBlock caption="application/json" code="{}" />);
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('the catalogue’s in-page FIND', () => {
  it('filters in place, KEEPS the group headings, and counts honestly', async () => {
    const { CatalogueNav } = await import('@/app/(public)/docs/_components/CatalogueNav');
    const groups = buildApiReference().groups;
    render(<CatalogueNav current="reference" groups={groups} />);

    const total = groups.reduce((sum, group) => sum + group.operations.length, 0);
    expect(screen.getByText(`${total} operations`)).toBeTruthy();

    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'sprint' } });

    const shown = document.querySelectorAll('[data-operation-id]').length;
    expect(shown).toBeGreaterThan(0);
    expect(shown).toBeLessThan(total);
    expect(screen.getByText(`${shown} of ${total} operations`)).toBeTruthy();
    // The heading of a surviving group is still there — a reader learns where
    // an operation LIVES, not only that it exists.
    expect(screen.getByTestId('catalogue-group-sprints')).toBeTruthy();
    // …and a group with no match is gone entirely, not left empty.
    expect(screen.queryByTestId('catalogue-group-identity')).toBeNull();
  });

  it('matches on the VERB too — a reader looking for a write types “post”', async () => {
    const { CatalogueNav } = await import('@/app/(public)/docs/_components/CatalogueNav');
    render(<CatalogueNav current="reference" groups={buildApiReference().groups} />);

    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'patch' } });
    const shown = [...document.querySelectorAll('[data-operation-id]')].map((node) =>
      node.getAttribute('data-operation-id'),
    );
    expect(shown).toContain('updateWorkItem');
    expect(shown).not.toContain('getWorkItem');
  });

  it('says so when nothing matches, and Escape clears the box', async () => {
    const { CatalogueNav } = await import('@/app/(public)/docs/_components/CatalogueNav');
    render(<CatalogueNav current="reference" groups={buildApiReference().groups} />);

    const box = screen.getByRole('searchbox');
    fireEvent.change(box, { target: { value: 'zzzznope' } });
    expect(document.querySelectorAll('[data-operation-id]')).toHaveLength(0);
    expect(screen.getByText(/zzzznope/)).toBeTruthy();

    fireEvent.keyDown(box, { key: 'Escape' });
    expect(document.querySelectorAll('[data-operation-id]').length).toBeGreaterThan(0);
  });
});

describe('the verb chip’s fallback', () => {
  it('does not throw on a verb the mapping does not know', async () => {
    // The registry restricts verbs to four, so this is unreachable today — which
    // is exactly why it is worth pinning: the fallback must stay a quiet default
    // rather than an exception on a documentation page.
    const { MethodPill } = await import('@/app/(public)/docs/_components/MethodPill');
    render(<MethodPill method="PUT" />);
    expect(screen.getAllByText('PUT').length).toBeGreaterThan(0);
  });
});

describe('the operation section’s envelope headings', () => {
  it('labels a PLAIN page’s row schema, a RANKED page’s, and a single resource’s', async () => {
    const { OperationSection } = await import('@/app/(public)/docs/_components/OperationSection');

    for (const [id, key] of [
      ['listProjectWorkItems', 'sectionRowSchema'],
      ['listWorkItemComments', 'sectionRowSchemaRanked'],
      ['getWorkItem', 'sectionResponseSchema'],
    ] as const) {
      const operation = toReferenceOperation(
        V1_OPERATIONS.find((candidate) => candidate.operationId === id)!,
      );
      render(await OperationSection({ operation }));
      expect(screen.getByText(key), `${id} → ${key}`).toBeTruthy();
      cleanup();
    }
  });
});

describe('the docs SHELL', () => {
  it('renders the shipped chrome around the content, with Docs marked current', async () => {
    vi.doMock('@/lib/services/projectTagsService', () => ({
      projectTagsService: { listCategories: async () => [{ slug: 'ai', label: 'AI' }] },
    }));
    const { default: Layout } = await import('@/app/(public)/docs/layout');
    const html = await renderPageToHtml(await Layout({ children: <p>content</p> }));

    expect(html).toContain('href="/docs/api"');
    expect(html).toContain('aria-current="page"');
    expect(html).toContain('content');
    // The footer's topic crawl links made it through.
    expect(html).toContain('/explore/topic/ai');
    vi.doUnmock('@/lib/services/projectTagsService');
  });

  it('still renders the documentation when the footer’s topic read FAILS', async () => {
    // The topic column is a nice-to-have crawl surface; the documentation is
    // not. A docs page must not 500 because a DB read for footer links did.
    vi.doMock('@/lib/services/projectTagsService', () => ({
      projectTagsService: {
        listCategories: async () => {
          throw new Error('database unavailable');
        },
      },
    }));
    const { default: Layout } = await import('@/app/(public)/docs/layout');
    const html = await renderPageToHtml(await Layout({ children: <p>content</p> }));

    expect(html).toContain('content');
    expect(html).not.toContain('/explore/topic/');
    vi.doUnmock('@/lib/services/projectTagsService');
  });

  it('titles the surface from the catalog', async () => {
    const { generateMetadata } = await import('@/app/(public)/docs/layout');
    expect(await generateMetadata()).toEqual({
      title: 'metaTitle',
      description: 'metaDescription',
    });
  });
});

describe('the guide and policy pages survive a broken registry', () => {
  it('render their own content with an empty rail rather than failing', async () => {
    vi.doMock('@/lib/apiDocs/reference', async (importOriginal) => ({
      ...(await importOriginal<typeof import('@/lib/apiDocs/reference')>()),
      buildApiReference: () => {
        throw new Error('registry unavailable');
      },
    }));

    const { default: Guide } = await import('@/app/(public)/docs/getting-started/page');
    render(await Guide());
    expect(screen.getByText('Mint a token')).toBeTruthy();
    expect(document.querySelectorAll('[data-operation-id]')).toHaveLength(0);
    cleanup();

    const { default: Policy } = await import('@/app/(public)/docs/stability/page');
    render(await Policy());
    expect(screen.getByText('A new endpoint.')).toBeTruthy();
  });
});
