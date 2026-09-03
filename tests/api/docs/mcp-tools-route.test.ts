import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { auditV1RouteSource, stripComments, v1RouteFiles } from '../../helpers/v1RouteAudit';
import { TOOL_PERMISSIONS } from '@/lib/mcp/toolPermissions';
import { GRANTABLE_PERMISSIONS } from '@/lib/tokens/grant';
import { permissionSlug, type PermissionKey } from '@/lib/permissions/catalog';
import type { McpCatalogueToolName, McpToolCatalogueDocument } from '@/lib/apiDocs/mcp';
import enMessages from '@/messages/en.json';

// GET /api/docs/mcp-tools.json — the PUBLISHED MCP tool catalogue (MOTIR-4194;
// `docs/decisions/public-surface-hosts.md` AMENDMENT 5).
//
// The obligations are `contract-route.test.ts`'s, for the same route SHAPE, plus
// two this document owes that an OpenAPI document does not:
//
//   1. Fetchable with NO credential. The consumer is `motir.co`, a second
//      repository with no workspace token — a document behind a login is the
//      failure this route exists to prevent (`tools/list` is 401 anonymously).
//   2. The four properties that make an unauthenticated handler safe —
//      authenticates nothing, reads no database, takes no user input, spends no
//      rate-limit budget — asserted against the file's SOURCE, not its comment.
//   3. TOTALITY. Every key of `TOOL_PERMISSIONS` reaches the served document.
//      Typecheck holds the summary map key-equal to the permission map; it cannot
//      see whether the SERIALIZATION dropped one. The set comparison here can,
//      and it is driven over a counterfactual so it is proved to FIRE.
//   4. DERIVATION. The grouping is each tool's own permission and the labels are
//      the shipped `permissions.*` copy; the only authored thing is the ORDER,
//      and this file says which is which.

const REPO_ROOT = process.cwd();
const ROUTE = join('app', 'api', 'docs', 'mcp-tools.json', 'route.ts');
const ROUTE_URL = 'http://localhost:3000/api/docs/mcp-tools.json';

const source = stripComments(readFileSync(join(REPO_ROOT, ROUTE), 'utf8'));

async function fetchDocument(): Promise<{ res: Response; document: McpToolCatalogueDocument }> {
  const { GET } = await import('@/app/api/docs/mcp-tools.json/route');
  const res = await GET();
  return { res, document: (await res.json()) as McpToolCatalogueDocument };
}

/** Every tool name the served document carries, flat. */
function servedNames(document: McpToolCatalogueDocument): string[] {
  return document.groups.flatMap((group) => group.tools.map((tool) => tool.name));
}

/**
 * The totality predicate, as a function so the counterfactual below can drive
 * it: which of `expected` are absent from the document, and which the document
 * carries that nothing expected.
 */
function setDifference(
  expected: readonly string[],
  document: McpToolCatalogueDocument,
): { missing: string[]; unexpected: string[] } {
  const served = new Set(servedNames(document));
  const wanted = new Set(expected);
  return {
    missing: expected.filter((name) => !served.has(name)).sort(),
    unexpected: [...served].filter((name) => !wanted.has(name)).sort(),
  };
}

/** The shipped `permissions.*` copy the labels must be read from. */
const PERMISSION_COPY = enMessages.permissions as unknown as Record<
  string,
  { label: string; description: string }
>;

describe('the catalogue route is not inside any tree a guard walks', () => {
  it('is NOT among the files the v1 route audit walks — so that guard keeps its unconditional form', () => {
    expect(v1RouteFiles(REPO_ROOT)).not.toContain(ROUTE);
  });

  it('WOULD have been flagged had it been placed inside the v1 tree', () => {
    const violations = auditV1RouteSource('app/api/v1/docs/mcp-tools.json/route.ts', source);
    expect(violations.map((v) => v.rule)).toContain('bypasses-wrapper');
  });

  it('sits outside the public-projects capability and outside the MCP endpoint', () => {
    // `app/api/public/**` is the gated capability — a route there owes the cloud
    // gate. `app/api/mcp/**` is where every request must carry a token. This
    // document belongs to neither.
    expect(ROUTE.startsWith(join('app', 'api', 'public'))).toBe(false);
    expect(ROUTE.startsWith(join('app', 'api', 'mcp'))).toBe(false);
  });
});

describe('the catalogue route is safe to serve unauthenticated', () => {
  it('authenticates nothing — neither the v1 wrapper nor the MCP bearer gate', () => {
    expect(source).not.toMatch(/withV1Route/);
    expect(source).not.toMatch(/withMcpAuth|verifyMcpToken/);
    expect(source).not.toMatch(/authenticateApiToken|getSession|presentedBearerToken/);
  });

  it('reads no database', () => {
    expect(source).not.toMatch(/@\/lib\/db|\bdb\s*\.|\$transaction|Repository|Service\b/);
  });

  it('takes NO user input — the handler has no request parameter at all', () => {
    expect(source).toMatch(/export async function GET\(\)/);
    expect(source).not.toMatch(/searchParams|req\.|request\./);
  });

  it('spends no rate-limit budget', () => {
    expect(source).not.toMatch(/consumeRateLimit|rateLimitHeaders/);
  });

  it('pulls in the content module and nothing from the tool registry', () => {
    // The dependency-graph rule `lib/apiDocs/mcp.ts` keeps, applied to its
    // reader: the registry imports every tool, the services and Prisma, none of
    // which belongs behind an anonymous route.
    const imports = [...source.matchAll(/from '([^']+)'/g)].map((m) => m[1]).sort();
    expect(imports).toEqual(['@/lib/apiDocs/mcp', 'next/server']);
    expect(source).not.toMatch(/lib\/mcp\/registry|lib\/mcp\/tools/);
  });
});

describe('GET /api/docs/mcp-tools.json', () => {
  it('serves the catalogue to a caller with NO Authorization header — a document, not a 401', async () => {
    // The handler takes no request, so there is nothing an Authorization header
    // could reach; the request below is the consumer's shape, made explicit.
    const anonymous = new Request(ROUTE_URL);
    expect(anonymous.headers.has('authorization')).toBe(false);

    const { res, document } = await fetchDocument();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(document.endpoint).toBe('/api/mcp');
    expect(document.groups.length).toBeGreaterThan(0);
    expect(document.toolCount).toBeGreaterThan(0);
  });

  it('is cacheable, because it changes only when the code does', async () => {
    const { res } = await fetchDocument();
    expect(res.headers.get('cache-control')).toMatch(/public/);
    expect(res.headers.get('cache-control')).toMatch(/must-revalidate/);
  });

  it('serves the same bytes on every request — a consumer can cache it', async () => {
    const { GET } = await import('@/app/api/docs/mcp-tools.json/route');
    const [first, second] = await Promise.all([GET(), GET()]);
    expect(await first.text()).toBe(await second.text());
  });

  it('is reachable at the URL the ADR pins', () => {
    // The route file's location IS the URL, so asserting the file is asserting
    // the address a consumer hard-codes.
    expect(new URL(ROUTE_URL).pathname).toBe('/api/docs/mcp-tools.json');
    expect(() => readFileSync(join(REPO_ROOT, ROUTE), 'utf8')).not.toThrow();
  });
});

describe('TOTALITY — every TOOL_PERMISSIONS key reaches the served document', () => {
  const expected = Object.keys(TOOL_PERMISSIONS).sort();

  it('the two SETS are equal, in both directions', async () => {
    const { document } = await fetchDocument();
    expect(setDifference(expected, document)).toEqual({ missing: [], unexpected: [] });
    expect(servedNames(document).sort()).toEqual(expected);
  });

  it('the count is the length of what was derived, never a literal', async () => {
    const { document } = await fetchDocument();
    expect(document.toolCount).toBe(servedNames(document).length);
    expect(document.toolCount).toBe(expected.length);
  });

  it('the predicate FIRES — proved by removing one entry from a served document', async () => {
    // A guard proved only to pass is a comment. Take the real document, drop one
    // tool from the group that carries it, and the comparison must name it.
    const { document } = await fetchDocument();
    const victim = document.groups[0]!.tools[0]!.name;
    const truncated: McpToolCatalogueDocument = {
      ...document,
      groups: document.groups.map((group) => ({
        ...group,
        tools: group.tools.filter((tool) => tool.name !== victim),
      })),
    };
    expect(setDifference(expected, truncated)).toEqual({ missing: [victim], unexpected: [] });
  });

  it('…and fires the other way, on a tool the registry does not have', async () => {
    const { document } = await fetchDocument();
    const [head, ...rest] = document.groups;
    const inflated: McpToolCatalogueDocument = {
      ...document,
      groups: [
        {
          ...head!,
          tools: [
            ...head!.tools,
            {
              name: 'not_a_tool' as McpCatalogueToolName,
              permission: head!.permission,
              summary: '',
            },
          ],
        },
        ...rest,
      ],
    };
    expect(setDifference(expected, inflated)).toEqual({ missing: [], unexpected: ['not_a_tool'] });
  });
});

describe('DERIVATION — what is derived, and the one thing that is authored', () => {
  it('DERIVED: every tool sits in the group of its own TOOL_PERMISSIONS entry', async () => {
    const { document } = await fetchDocument();
    for (const group of document.groups) {
      for (const tool of group.tools) {
        expect(tool.permission, tool.name).toBe(TOOL_PERMISSIONS[tool.name]);
        expect(group.permission, tool.name).toBe(tool.permission);
      }
    }
  });

  it('DERIVED: every group label and description is the shipped `permissions.*` copy', async () => {
    const { document } = await fetchDocument();
    for (const group of document.groups) {
      const copy = PERMISSION_COPY[permissionSlug(group.permission as PermissionKey)];
      expect(copy, group.permission).toBeDefined();
      expect(group.label).toBe(copy!.label);
      expect(group.gates).toBe(copy!.description);
    }
  });

  it('DERIVED: no group is empty, and no permission that gates a tool is missing', async () => {
    const { document } = await fetchDocument();
    const gating = new Set(Object.values(TOOL_PERMISSIONS));
    expect(document.groups.every((group) => group.tools.length > 0)).toBe(true);
    expect(new Set(document.groups.map((group) => group.permission))).toEqual(gating);
  });

  it('AUTHORED: the group ORDER is the permission catalog’s own, and nothing else is', async () => {
    // `GRANTABLE_PERMISSIONS` is declared in catalog order; the document keeps
    // that order and drops the permissions that gate no tool. That order is the
    // single authored fact in the document.
    const { document } = await fetchDocument();
    const gating = new Set(Object.values(TOOL_PERMISSIONS));
    expect(document.groups.map((group) => group.permission)).toEqual(
      GRANTABLE_PERMISSIONS.filter((permission) => gating.has(permission)),
    );
  });

  it('no group label is authored as a free string in the route', () => {
    // The route imports the document and serializes it; every label reaches it
    // through `lib/apiDocs/mcp.ts`'s read of the shipped copy. A `label:` or
    // `gates:` literal here would be a second, unchecked home for one.
    expect(source).not.toMatch(/label\s*:|gates\s*:|permissions\./);
  });
});
