import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildMcpServer } from '@/lib/mcp/registry';
import { TOOL_SCOPES } from '@/lib/mcp/scopes';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { fingerprintToolText } from '@/lib/apiDocs/mcpFingerprint';
import {
  MCP_ENDPOINT_PATH,
  MCP_EXAMPLE_ORIGIN,
  mcpClients,
  mcpToolCount,
  mcpToolFingerprint,
  mcpToolRows,
  mcpTransportFacts,
  type McpCatalogueToolName,
} from '@/lib/apiDocs/mcp';

// THE STORY'S TRUTH GATE (Story MOTIR-2309 · Subtask MOTIR-2330 · ADR
// `public-api-conventions.md` Amendment 12 Q2 and Q3a).
//
// The published catalogue is half derived and half authored. The derived half
// cannot drift — it IS `TOOL_SCOPES`. This file stands over the half that can:
//
//   1. SET EQUALITY   the tools `tools/list` returns are exactly the ones the
//                     page carries. Belt and braces over the compile-time
//                     totality, and the arm that catches a tool REMOVED.
//   2. SCOPE          every row's scope equals `TOOL_SCOPES[name]` — the page
//                     reads the map the gate enforces, not a copy of it.
//   3. FINGERPRINT    each authored summary was written against the `title` +
//                     `description` the server ships TODAY. It does not prove a
//                     summary is good — no test can. It proves nobody reworded
//                     the tool underneath it, which is the failure that has
//                     actually happened to this project's documentation twice.
//
// Plus Amendment 12 Q3a's containment for the client matrix, and the
// dependency-graph boundary that keeps Prisma out of a public page.
//
// It reads the tool set from a LIVE handshake — never a fixture, never a
// snapshot, never a second hand-written list. Importing the registry costs
// nothing here; that is exactly why the pinning lives in a test file and not in
// the module the page imports.

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (file: string) => readFileSync(join(REPO_ROOT, file), 'utf8');

/** `tools/list` needs no actor — no handler runs — so a stub context is honest here. */
const STUB_CONTEXT = { userId: 'gate', workspaceId: 'gate' } as unknown as ServiceContext;

interface ListedTool {
  name: string;
  title?: string;
  description?: string;
}

async function listShippedTools(): Promise<ListedTool[]> {
  const server = buildMcpServer(() => STUB_CONTEXT);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'mcp-docs-truth', version: '0.0.0' });
  await client.connect(clientTransport);
  const listed = await client.listTools();
  await client.close();
  return listed.tools as ListedTool[];
}

describe('the published catalogue against the SHIPPED tools/list', () => {
  it('carries exactly the tools the server exposes — none missing, none invented', async () => {
    const shipped = (await listShippedTools()).map((tool) => tool.name).sort();
    const published = mcpToolRows()
      .map((row) => row.name)
      .sort();

    expect(published).toEqual(shipped);
    expect(mcpToolCount()).toBe(shipped.length);
  });

  it('gates every published row with the scope the server gates it with', async () => {
    const shipped = await listShippedTools();
    for (const tool of shipped) {
      const row = mcpToolRows().find((entry) => entry.name === tool.name);
      expect(row, `no published row for shipped tool ${tool.name}`).toBeDefined();
      expect(row?.scope).toBe(TOOL_SCOPES[tool.name as McpCatalogueToolName]);
    }
  });

  // ⚠️ THE PIN. When this fails it is not flaky and it is not a formatting
  // change: some tool's title or description moved, and the one-line summary the
  // page publishes for it was written against the older text. Re-read the tool,
  // re-write the summary if it now says something different, and update the
  // fingerprint in `lib/apiDocs/mcp.ts`. Do not just update the fingerprint.
  it('pins every authored summary to the tool text it was written against', async () => {
    const shipped = await listShippedTools();
    const drifted: string[] = [];

    for (const tool of shipped) {
      const expected = fingerprintToolText(tool.title ?? '', tool.description ?? '');
      const stored = mcpToolFingerprint(tool.name as McpCatalogueToolName);
      if (stored !== expected) drifted.push(`${tool.name}: stored ${stored}, shipped ${expected}`);
    }

    expect(
      drifted,
      `these tools' shipped text changed since their published summary was written:\n  ${drifted.join('\n  ')}`,
    ).toEqual([]);
  });

  it('detects a reworded description — the pin is not vacuous', async () => {
    const shipped = await listShippedTools();
    const first = shipped[0];
    expect(first).toBeDefined();
    const asShipped = fingerprintToolText(first?.title ?? '', first?.description ?? '');
    const reworded = fingerprintToolText(
      first?.title ?? '',
      `${first?.description ?? ''} And more.`,
    );
    expect(reworded).not.toBe(asShipped);
  });

  it('ignores a pure re-wrap — Prettier reflowing a literal is not drift', () => {
    const a = fingerprintToolText('Read a work item', 'One   item\n  in full.');
    const b = fingerprintToolText('Read a work item', 'One item in full.');
    expect(a).toBe(b);
  });
});

describe('the client matrix containment (Amendment 12 Q3a)', () => {
  it('gives every block a checked date and a vendor documentation link', () => {
    for (const client of mcpClients()) {
      expect(client.checkedOn, `${client.id} has no checkedOn`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(client.docsUrl, `${client.id} has no docsUrl`).toMatch(/^https:\/\//);
    }
  });

  // The negative case Amendment 12 Q3a names: build the matrix with a sentinel
  // origin. A block that INTERPOLATES the single source carries the sentinel; a
  // block that hard-codes its own URL does not, and fails here.
  it('makes a block that hard-codes its own endpoint a RED BUILD', () => {
    const sentinel = 'https://sentinel.invalid';
    const offenders = mcpClients(mcpTransportFacts(sentinel)).filter(
      (client) =>
        !client.config.includes(`${sentinel}${MCP_ENDPOINT_PATH}`) ||
        client.config.includes(MCP_EXAMPLE_ORIGIN),
    );
    expect(
      offenders.map((client) => client.id),
      'these client blocks do not interpolate the shared endpoint',
    ).toEqual([]);
  });

  it('never publishes a plausible-looking credential in any block', () => {
    for (const client of mcpClients()) {
      expect(client.config).not.toMatch(/motir_pat_[A-Za-z0-9]{10,}/);
    }
  });
});

describe('the dependency-graph boundary (Amendment 12 Q2)', () => {
  it('imports nothing from lib/mcp except the scope map', () => {
    const source = read('lib/apiDocs/mcp.ts');
    const mcpImports = [...source.matchAll(/from '(@\/lib\/mcp\/[^']+)'/g)].map((m) => m[1]);
    expect([...new Set(mcpImports)]).toEqual(['@/lib/mcp/scopes']);
  });

  it('never reaches the registry — the module that drags the services and Prisma', () => {
    expect(read('lib/apiDocs/mcp.ts')).not.toContain('lib/mcp/registry');
  });

  it('keeps node: builtins out of the module a public page imports', () => {
    // `fingerprintToolText` needs node:crypto, which is why it lives in its own
    // module that only this gate imports.
    expect(read('lib/apiDocs/mcp.ts')).not.toMatch(/from 'node:/);
    expect(read('lib/apiDocs/mcpFingerprint.ts')).toContain("from 'node:crypto'");
  });

  it('keeps the registry out of every public page', () => {
    for (const file of ['app/(public)/docs/mcp/page.tsx', 'app/(public)/docs/mcp/tools/page.tsx']) {
      expect(read(file), `${file} must not import the MCP registry`).not.toContain(
        'lib/mcp/registry',
      );
    }
  });

  it('writes no tool COUNT as a literal in the content module', () => {
    const source = read('lib/apiDocs/mcp.ts');
    const body = source.slice(source.indexOf('export type McpCatalogueToolName'));
    expect(body).not.toMatch(new RegExp(`\\b${mcpToolCount()}\\b`));
  });
});
