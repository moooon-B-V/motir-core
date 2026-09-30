import { describe, expect, it } from 'vitest';
import {
  MCP_ENDPOINT_PATH,
  MCP_EXAMPLE_ORIGIN,
  MCP_TOKEN_PLACEHOLDER,
  mcpClients,
  mcpForkRows,
  mcpScopeLegend,
  mcpToolCount,
  mcpToolFingerprint,
  mcpToolRows,
  mcpTransportFactRows,
  mcpTransportFacts,
} from '@/lib/apiDocs/mcp';
import { TOOL_PERMISSIONS } from '@/lib/mcp/toolPermissions';
import { DEFAULT_TOKEN_GRANT, GRANTABLE_PERMISSIONS } from '@/lib/tokens/grant';

// The reader-facing CONTENT helpers of `lib/apiDocs/mcp.ts` (Story MOTIR-6974 ·
// Subtask MOTIR-7003). The module joined the per-file coverage gate with this
// story — it now carries each tool's title and hints into the published
// catalogue — and these helpers had no direct test: the pages that rendered them
// left with MOTIR-3951. Each case pins a property the helper promises, not its
// prose: the facts are INTERPOLATED (a sentinel origin reaches every row), and
// every count is DERIVED from the permission map rather than written.

const SENTINEL = 'https://sentinel.invalid';

describe('the transport facts', () => {
  it('default to the example origin and the served path', () => {
    const facts = mcpTransportFacts();
    expect(facts.origin).toBe(MCP_EXAMPLE_ORIGIN);
    expect(facts.url).toBe(`${MCP_EXAMPLE_ORIGIN}${MCP_ENDPOINT_PATH}`);
    expect(facts.tokenPlaceholder).toBe(MCP_TOKEN_PLACEHOLDER);
  });

  it('carry an overridden origin into the URL', () => {
    expect(mcpTransportFacts(SENTINEL).url).toBe(`${SENTINEL}${MCP_ENDPOINT_PATH}`);
  });

  it('render as the fact table, from the defaults or from given facts', () => {
    const rows = mcpTransportFactRows();
    expect(rows[0]).toEqual({ label: 'URL', value: `\`${mcpTransportFacts().url}\`` });
    expect(JSON.stringify(mcpTransportFactRows(mcpTransportFacts(SENTINEL)))).toContain(SENTINEL);
  });
});

describe('the MCP-or-REST fork table', () => {
  it('names the served path by default and interpolates given facts', () => {
    expect(mcpForkRows()[0]).toMatchObject({
      axis: 'Endpoint',
      mcp: `\`POST ${MCP_ENDPOINT_PATH}\``,
    });
    const custom = { ...mcpTransportFacts(), path: '/sentinel' };
    expect(mcpForkRows(custom)[0]!.mcp).toBe('`POST /sentinel`');
  });
});

describe('the client blocks', () => {
  it('build from the default facts, each carrying the served URL', () => {
    for (const client of mcpClients()) {
      expect(client.config, client.id).toContain(mcpTransportFacts().url);
    }
  });
});

describe('the scope legend', () => {
  it('lists every grantable permission, in catalog order, with DERIVED counts', () => {
    const legend = mcpScopeLegend();
    expect(legend.map((row) => row.permission)).toEqual([...GRANTABLE_PERMISSIONS]);
    // Every tool is counted exactly once, under its own permission.
    expect(legend.reduce((sum, row) => sum + row.toolCount, 0)).toBe(
      Object.keys(TOOL_PERMISSIONS).length,
    );
    for (const row of legend) {
      expect(row.toolCount, row.permission).toBe(
        Object.values(TOOL_PERMISSIONS).filter((permission) => permission === row.permission)
          .length,
      );
      expect(row.grantedByDefault, row.permission).toBe(
        DEFAULT_TOKEN_GRANT.includes(row.permission),
      );
      expect(row.label.length, row.permission).toBeGreaterThan(0);
    }
  });
});

describe('the catalogue accessors', () => {
  it('count the rows and expose each stored fingerprint', () => {
    expect(mcpToolCount()).toBe(mcpToolRows().length);
    expect(mcpToolCount()).toBe(Object.keys(TOOL_PERMISSIONS).length);
    expect(mcpToolFingerprint('get_work_item')).toMatch(/^[0-9a-f]{12}$/);
  });
});
