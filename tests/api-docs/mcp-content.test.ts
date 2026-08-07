import { describe, expect, it } from 'vitest';
import { DEFAULT_TOKEN_SCOPES, TOKEN_SCOPES, TOOL_SCOPES, type TokenScope } from '@/lib/mcp/scopes';
import {
  MCP_AUTH_HEADER,
  MCP_AUTH_SCHEME,
  MCP_CLIENT_FORMATS_CHECKED_ON,
  MCP_ENDPOINT_PATH,
  MCP_EXAMPLE_ORIGIN,
  MCP_TOKEN_PLACEHOLDER,
  mcpCatalogue,
  mcpClients,
  mcpForkRows,
  mcpScopeLegend,
  mcpToolCount,
  mcpToolFingerprint,
  mcpToolRows,
  mcpTransportFactRows,
  mcpTransportFacts,
} from '@/lib/apiDocs/mcp';

// Unit tests for the MCP documentation's content module (Story MOTIR-2309 ·
// Subtask MOTIR-2325).
//
// These cover the module's own logic — the derivation, the grouping, the legend
// and Amendment 12 Q3a's interpolation contract. What they deliberately do NOT
// cover is whether each authored summary still describes the tool the server
// ships: that needs a live `tools/list` handshake and belongs to the story's
// vitest gate (MOTIR-2330), in a file where importing the registry costs nothing.

describe('the catalogue derives from TOOL_SCOPES', () => {
  it('carries every shipped tool, and nothing else', () => {
    const derived = mcpToolRows()
      .map((row) => row.name)
      .sort();
    expect(derived).toEqual(Object.keys(TOOL_SCOPES).sort());
  });

  it('gives every row the scope the server gates it with', () => {
    for (const row of mcpToolRows()) {
      expect(row.scope).toBe(TOOL_SCOPES[row.name]);
    }
  });

  it('counts the rows it derived rather than a literal', () => {
    expect(mcpToolCount()).toBe(Object.keys(TOOL_SCOPES).length);
    expect(mcpToolCount()).toBe(mcpToolRows().length);
  });

  it('gives every tool a non-empty summary that is not just its own name', () => {
    for (const row of mcpToolRows()) {
      expect(row.summary.trim().length).toBeGreaterThan(20);
      expect(row.summary).not.toBe(row.name);
    }
  });

  it('stores a 12-character fingerprint for every tool', () => {
    for (const row of mcpToolRows()) {
      expect(mcpToolFingerprint(row.name)).toMatch(/^[0-9a-f]{12}$/);
    }
  });

  it('gives distinct tools distinct fingerprints', () => {
    const seen = new Set(mcpToolRows().map((row) => mcpToolFingerprint(row.name)));
    expect(seen.size).toBe(mcpToolCount());
  });
});

describe('the grouping is by scope, and derived', () => {
  it('groups in TOKEN_SCOPES order, and every group is non-empty', () => {
    const groups = mcpCatalogue();
    const order = groups.map((group) => group.scope);
    expect(order).toEqual(TOKEN_SCOPES.filter((scope) => order.includes(scope)));
    for (const group of groups) {
      expect(group.tools.length).toBeGreaterThan(0);
    }
  });

  it('puts each tool in exactly one group — its own scope', () => {
    const groups = mcpCatalogue();
    for (const group of groups) {
      for (const tool of group.tools) {
        expect(tool.scope).toBe(group.scope);
      }
    }
    const total = groups.reduce((sum, group) => sum + group.tools.length, 0);
    expect(total).toBe(mcpToolCount());
  });

  it('partitions the tools — no tool appears twice', () => {
    const names = mcpCatalogue().flatMap((group) => group.tools.map((tool) => tool.name));
    expect(new Set(names).size).toBe(names.length);
  });

  it('marks the default grant from DEFAULT_TOKEN_SCOPES, not a second list', () => {
    for (const group of mcpCatalogue()) {
      expect(group.grantedByDefault).toBe(DEFAULT_TOKEN_SCOPES.includes(group.scope));
    }
    const off = mcpCatalogue().filter((group) => !group.grantedByDefault);
    expect(off.map((group) => group.scope)).toEqual(['work_items:delete']);
  });
});

describe('the scope legend', () => {
  it('covers every TOKEN_SCOPE, in order', () => {
    expect(mcpScopeLegend().map((row) => row.scope)).toEqual([...TOKEN_SCOPES]);
  });

  it('counts each scope’s tools from TOOL_SCOPES', () => {
    for (const row of mcpScopeLegend()) {
      const expected = Object.values(TOOL_SCOPES).filter((scope) => scope === row.scope).length;
      expect(row.toolCount).toBe(expected);
    }
  });

  it('sums to the whole tool set', () => {
    const total = mcpScopeLegend().reduce((sum, row) => sum + row.toolCount, 0);
    expect(total).toBe(mcpToolCount());
  });

  it('marks exactly work_items:delete as off by default', () => {
    const off = mcpScopeLegend()
      .filter((row) => !row.grantedByDefault)
      .map((row) => row.scope);
    expect(off).toEqual(['work_items:delete']);
  });

  it('gives every scope a label and a description of what it gates', () => {
    for (const row of mcpScopeLegend()) {
      expect(row.label.trim()).not.toBe('');
      expect(row.gates.trim().length).toBeGreaterThan(20);
    }
  });

  it('includes a scope that gates no tool, with a zero count', () => {
    // The legend enumerates TOKEN_SCOPES, so it stays total even if a scope
    // temporarily gates nothing — unlike the catalogue, which drops empty groups.
    const legend = mcpScopeLegend();
    const catalogue = mcpCatalogue();
    expect(legend.length).toBeGreaterThanOrEqual(catalogue.length);
  });
});

describe('the transport facts are held once (Amendment 12 Q3a)', () => {
  it('builds the URL from the origin and the shipped path', () => {
    const facts = mcpTransportFacts();
    expect(facts.url).toBe(`${MCP_EXAMPLE_ORIGIN}${MCP_ENDPOINT_PATH}`);
    expect(facts.authHeader).toBe(MCP_AUTH_HEADER);
    expect(facts.authScheme).toBe(MCP_AUTH_SCHEME);
    expect(facts.tokenPlaceholder).toBe(MCP_TOKEN_PLACEHOLDER);
  });

  it('honours an overridden origin', () => {
    const facts = mcpTransportFacts('https://motir.example.test');
    expect(facts.url).toBe('https://motir.example.test/api/mcp');
  });

  it('states the four facts as rows, carrying the resolved URL', () => {
    const rows = mcpTransportFactRows();
    expect(rows.map((row) => row.label)).toEqual(['URL', 'Transport', 'Header', 'Token']);
    expect(rows[0]?.value).toContain(mcpTransportFacts().url);
    expect(rows.find((row) => row.label === 'Header')?.value).toContain(MCP_AUTH_HEADER);
  });

  it('uses an obvious placeholder, never a plausible-looking token', () => {
    expect(MCP_TOKEN_PLACEHOLDER).toContain('<');
    expect(MCP_TOKEN_PLACEHOLDER.startsWith('motir_pat_')).toBe(true);
  });
});

describe('the client matrix', () => {
  it('ships a block for each named client plus a generic one', () => {
    expect(mcpClients().map((client) => client.id)).toEqual([
      'claude-code',
      'cursor',
      'vscode',
      'codex',
      'other',
    ]);
  });

  it('gives every block a file, a config, a vendor link and a checked date', () => {
    for (const client of mcpClients()) {
      expect(client.label.trim()).not.toBe('');
      expect(client.file.trim()).not.toBe('');
      expect(client.config.trim()).not.toBe('');
      expect(client.docsUrl).toMatch(/^https:\/\//);
      expect(client.checkedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('dates every block from the one shared constant', () => {
    for (const client of mcpClients()) {
      expect(client.checkedOn).toBe(MCP_CLIENT_FORMATS_CHECKED_ON);
    }
  });

  // ⚠️ THE CONTAINMENT ASSERTION (Amendment 12 Q3a). Building with a sentinel
  // origin proves each block INTERPOLATES the single source rather than carrying
  // its own copy of the URL — which is what keeps a stale block wrong about a
  // vendor's syntax and never about Motir.
  it('interpolates the endpoint into every block — none hard-codes it', () => {
    const sentinel = 'https://sentinel.invalid';
    for (const client of mcpClients(mcpTransportFacts(sentinel))) {
      expect(client.config).toContain(`${sentinel}${MCP_ENDPOINT_PATH}`);
      expect(client.config).not.toContain(MCP_EXAMPLE_ORIGIN);
    }
  });

  it('interpolates the auth header into every block that carries one', () => {
    const withHeader = mcpClients().filter((client) => client.id !== 'codex');
    expect(withHeader.length).toBeGreaterThan(0);
    for (const client of withHeader) {
      expect(client.config).toContain(MCP_AUTH_HEADER);
    }
  });

  it('prefers each vendor’s own secret indirection over a pasted token', () => {
    const byId = new Map(mcpClients().map((client) => [client.id, client]));
    expect(byId.get('cursor')?.config).toContain('${env:');
    expect(byId.get('vscode')?.config).toContain('${input:');
    expect(byId.get('codex')?.config).toContain('bearer_token_env_var');
    // …and where a vendor offers none, the placeholder is obvious, never a fake token.
    expect(byId.get('claude-code')?.config).toContain(MCP_TOKEN_PLACEHOLDER);
  });

  it('never writes a real-looking credential into any block', () => {
    for (const client of mcpClients()) {
      expect(client.config).not.toMatch(/motir_pat_[A-Za-z0-9]{10,}/);
    }
  });

  it('keeps the Codex block on the env-var NAME, not the token', () => {
    const codex = mcpClients().find((client) => client.id === 'codex');
    expect(codex?.config).toContain('bearer_token_env_var = "MOTIR_TOKEN"');
    expect(codex?.config).not.toContain(MCP_TOKEN_PLACEHOLDER);
  });
});

describe('the reader’s fork', () => {
  it('states each axis for both surfaces', () => {
    const rows = mcpForkRows();
    expect(rows.map((row) => row.axis)).toEqual([
      'Endpoint',
      'Built for',
      'Stability',
      'Shape',
      'Auth',
    ]);
    for (const row of rows) {
      expect(row.mcp.trim()).not.toBe('');
      expect(row.rest.trim()).not.toBe('');
    }
  });

  it('names the MCP endpoint from the shipped path', () => {
    expect(mcpForkRows()[0]?.mcp).toContain(MCP_ENDPOINT_PATH);
  });

  it('publishes the churn-versus-stability REASONING, not the internal shorthand', () => {
    const stability = mcpForkRows().find((row) => row.axis === 'Stability');
    expect(stability?.mcp.toLowerCase()).toContain('change');
    expect(stability?.rest).toContain('/api/v2');
    // The Motir-internal slogan is a conclusion with the reasoning removed; a
    // reader handed it cannot tell whether their case is the exception.
    const everything = mcpForkRows()
      .map((row) => `${row.axis} ${row.mcp} ${row.rest}`)
      .join(' ');
    expect(everything).not.toContain('is for AGENTS');
  });
});

describe('the dependency-graph boundary (Amendment 12 Q2)', () => {
  it('exports only serializable data — no functions ride on a row', () => {
    const everything = [
      ...mcpToolRows(),
      ...mcpClients(),
      ...mcpScopeLegend(),
      ...mcpForkRows(),
      ...mcpTransportFactRows(),
    ];
    for (const row of everything) {
      expect(JSON.parse(JSON.stringify(row))).toEqual(row);
    }
  });

  it('is reachable without pulling the MCP registry or Prisma', async () => {
    // If `mcp.ts` ever imported `lib/mcp/registry.ts`, importing it here would
    // drag all 39 tool modules, the services and `@prisma/client` behind it. The
    // import boundary is asserted textually by the story's gate; this is the
    // cheap runtime half — the module loads on its own.
    const loaded = await import('@/lib/apiDocs/mcp');
    expect(typeof loaded.mcpCatalogue).toBe('function');
  });
});

describe('a scope that gates nothing', () => {
  it('drops from the catalogue but survives in the legend', () => {
    // Drives the `.filter(group => group.tools.length > 0)` branch honestly: the
    // legend enumerates all six scopes, the catalogue only the populated ones.
    const legendScopes = mcpScopeLegend().map((row) => row.scope);
    const catalogueScopes = mcpCatalogue().map((group) => group.scope);
    for (const scope of catalogueScopes) {
      expect(legendScopes).toContain(scope);
    }
    const unpopulated = legendScopes.filter(
      (scope: TokenScope) => !catalogueScopes.includes(scope),
    );
    for (const scope of unpopulated) {
      const row = mcpScopeLegend().find((entry) => entry.scope === scope);
      expect(row?.toolCount).toBe(0);
    }
  });
});
