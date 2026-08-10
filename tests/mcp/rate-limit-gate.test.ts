import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { db } from '@/lib/db';
import { buildMcpServer, MCP_SERVER_INFO } from '@/lib/mcp/registry';
import { MCP_BILLABLE_TOOLS, rateLimitedServer } from '@/lib/mcp/rateLimitGate';
import { SCOPE_NOT_GRANTED_CODE } from '@/lib/mcp/scopeGate';
import { RATE_LIMITED_CODE } from '@/lib/rateLimit/guard';
import { RATE_LIMIT_DISABLE_ENV } from '@/lib/rateLimit/limiter';
import { __resetSharedRateLimitStoreForTest } from '@/lib/rateLimit/store';
import type { McpRequestExtra } from '@/lib/mcp/context';
import type { TokenScope } from '@/lib/mcp/scopes';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { truncateAuthTables, truncateRateLimitCounters } from '../helpers/db';

// The BILLABLE-TOOL gate at the MCP dispatch seam (MOTIR-2610), wired.
//
// `tests/rateLimit/surfaceGuards.test.ts` owns the DECISION (which tools draw
// `ai:generate`, which budget they share with the browser, and the filesystem
// derivation of the billable set). What only a wired server can prove is the
// three things the Proxy itself is responsible for:
//
//   1. a billable tool is actually SHORT-CIRCUITED at dispatch — the refusal
//      arrives as an MCP-legal `isError` tool result, so an SDK client parses it
//      rather than seeing a transport error;
//   2. the SCOPE gate still runs FIRST, so a token that may not call the tool
//      cannot drain its owner's generation budget by calling it anyway;
//   3. every other tool passes through the Proxy untouched.
//
// Refusals here happen BEFORE the tool's runner, so no service and no provider is
// reached — which is why these cases need no AI fixture and no motir-ai.

const ENVS = ['MOTIR_AI_GENERATE_RATE_LIMIT', 'MOTIR_AI_GENERATE_RATE_LIMIT_WINDOW_MS'];

const ctx: ServiceContext = { userId: 'gate_user', workspaceId: 'gate_ws' };

beforeEach(async () => {
  await truncateAuthTables();
  await truncateRateLimitCounters();
  __resetSharedRateLimitStoreForTest();
  for (const key of ENVS) delete process.env[key];
  // The gate must never read as "off" here — a suite that inherited the E2E
  // switch would assert nothing at all.
  delete process.env[RATE_LIMIT_DISABLE_ENV];
});

afterEach(() => {
  __resetSharedRateLimitStoreForTest();
  for (const key of ENVS) delete process.env[key];
});

afterAll(async () => {
  await db.$disconnect();
});

/** Connect an in-memory MCP client to a metered server. `scopes` mirrors what a
 *  token was granted; omitting it applies no scope narrowing. */
async function connect(scopes?: readonly TokenScope[]): Promise<Client> {
  const server = buildMcpServer(
    () => ctx,
    scopes ? () => [...scopes] : undefined,
    true, // meterBillableTools — the production wiring
  );
  const client = new Client({ name: 'test', version: '0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function textOf(result: unknown): string {
  return JSON.stringify(result);
}

describe('the billable-tool gate, wired into a real server', () => {
  it('refuses an over-budget expand_item with an isError tool result, not a transport error', async () => {
    process.env['MOTIR_AI_GENERATE_RATE_LIMIT'] = '1';
    const client = await connect();

    // The first call passes the gate and reaches the tool, which fails on the
    // missing project rather than on the limiter — proof the gate let it THROUGH.
    const first = await client
      .callTool({ name: 'expand_item', arguments: { key: 'ACME-7' } })
      .catch(() => null);
    expect(textOf(first)).not.toContain(RATE_LIMITED_CODE);

    const second = await client.callTool({ name: 'expand_item', arguments: { key: 'ACME-7' } });
    expect(second.isError).toBe(true);
    expect(textOf(second.content)).toContain(RATE_LIMITED_CODE);
    expect(textOf(second.content)).toContain('expand_item');
    await client.close();
  });

  it('the SCOPE gate runs FIRST — a denied call never spends the generation budget', async () => {
    // The ordering `registerMcpTools` composes for. `expand_item` needs
    // `work_items:write`; a read-only token is refused for SCOPE, and the budget
    // it could not reach is still whole afterwards.
    process.env['MOTIR_AI_GENERATE_RATE_LIMIT'] = '1';
    const readOnly = await connect(['read']);
    for (let i = 0; i < 3; i += 1) {
      const denied = await readOnly.callTool({ name: 'expand_item', arguments: { key: 'ACME-7' } });
      expect(denied.isError).toBe(true);
      expect(textOf(denied.content)).toContain(SCOPE_NOT_GRANTED_CODE);
      expect(textOf(denied.content)).not.toContain(RATE_LIMITED_CODE);
    }
    await readOnly.close();

    // One unspent unit left: a properly-scoped caller still gets its first call.
    const full = await connect();
    const allowed = await full
      .callTool({ name: 'expand_item', arguments: { key: 'ACME-7' } })
      .catch(() => null);
    expect(textOf(allowed)).not.toContain(RATE_LIMITED_CODE);
    await full.close();
  });

  it('leaves every NON-billable tool alone, however low the generation budget is', async () => {
    process.env['MOTIR_AI_GENERATE_RATE_LIMIT'] = '1';
    const client = await connect();
    for (let i = 0; i < 4; i += 1) {
      const result = await client.callTool({ name: 'whoami', arguments: {} });
      expect(textOf(result)).not.toContain(RATE_LIMITED_CODE);
    }
    await client.close();
  });

  it('registers the SAME tool surface metered or not — the Proxy adds no tools and drops none', async () => {
    const metered = await connect();
    const plain = new Client({ name: 'test', version: '0' });
    const bare = buildMcpServer(() => ctx);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([bare.connect(st), plain.connect(ct)]);

    const names = (list: { tools: { name: string }[] }) => list.tools.map((t) => t.name).sort();
    expect(names(await metered.listTools())).toEqual(names(await plain.listTools()));
    await Promise.all([metered.close(), plain.close()]);
  });

  it('a server built WITHOUT the flag meters nothing (the in-process tool tests)', async () => {
    process.env['MOTIR_AI_GENERATE_RATE_LIMIT'] = '1';
    const client = new Client({ name: 'test', version: '0' });
    const server = buildMcpServer(() => ctx); // meterBillableTools defaults to false
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), client.connect(ct)]);

    for (let i = 0; i < 3; i += 1) {
      const result = await client
        .callTool({ name: 'expand_item', arguments: { key: 'ACME-7' } })
        .catch(() => null);
      expect(textOf(result)).not.toContain(RATE_LIMITED_CODE);
    }
    await client.close();
  });

  it('passes every non-registerTool member of the server through untouched', () => {
    // The Proxy intercepts exactly one method; anything else it swallowed would
    // break the SDK in ways a tool round-trip would not necessarily show.
    const server = buildMcpServer(() => ctx);
    const wrapped = rateLimitedServer(server, (extra: McpRequestExtra) => {
      void extra;
      return ctx;
    });
    expect(wrapped.server.getClientVersion).toBeTypeOf('function');
    expect(typeof wrapped.connect).toBe('function');
    expect(MCP_SERVER_INFO.name).toBe('motir');
    // And the billable set is non-empty, so none of the above is vacuous.
    expect(MCP_BILLABLE_TOOLS.length).toBeGreaterThan(0);
  });
});
