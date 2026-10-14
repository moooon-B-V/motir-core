import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { db } from '@/lib/db';
import { buildMcpServer, MCP_TOOL_NAMES } from '@/lib/mcp/registry';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { makeWorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// MOTIR-8551 — EVERY registered tool goes through the trace. A tool added later
// that is registered on a server the chain does not cover fails here, because
// the test reads `MCP_TOOL_NAMES` and invokes every handler the SDK holds.

const rec = vi.hoisted(() => ({ spans: [] as string[], passThrough: true }));

vi.mock('@sentry/nextjs', () => {
  const span = { setAttributes() {}, setStatus() {}, end() {} };
  return {
    getClient: () => ({}),
    getActiveSpan: () => undefined,
    getRootSpan: () => span,
    updateSpanName: () => {},
    setTag: () => {},
    startInactiveSpan: () => span,
    withActiveSpan: (_span: unknown, fn: () => unknown) => fn(),
    startSpan: (opts: { name: string }, fn: (span: unknown) => unknown) => {
      rec.spans.push(opts.name);
      // While `passThrough` is false, the tool body does not run at all: what is
      // proven is that the call reached the trace, not what the tool does with an
      // empty argument object.
      if (!rec.passThrough && opts.name.startsWith('tools/call ')) {
        return Promise.resolve({ content: [] } satisfies CallToolResult);
      }
      return fn(span);
    },
  };
});

beforeEach(async () => {
  rec.spans.length = 0;
  rec.passThrough = true;
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

type Registered = Record<
  string,
  { handler: (args: unknown, extra: unknown) => Promise<CallToolResult> }
>;

describe('the registry chain', () => {
  it('every name in MCP_TOOL_NAMES opens exactly one `tools/call <name>` span', async () => {
    const ctx: ServiceContext = { userId: 'trace_user', workspaceId: 'trace_ws' };
    const server = buildMcpServer(() => ctx);
    const registered = (server as unknown as { _registeredTools: Registered })._registeredTools;
    expect(Object.keys(registered).sort()).toEqual([...MCP_TOOL_NAMES].sort());

    rec.passThrough = false;
    for (const name of MCP_TOOL_NAMES) {
      rec.spans.length = 0;
      await registered[name]!.handler({}, {});
      expect(
        rec.spans.filter((s) => s === `tools/call ${name}`),
        name,
      ).toHaveLength(1);
    }
  });

  it('an in-memory client round trip of whoami is traced as `tools/call whoami`', async () => {
    const fx = await makeWorkItemFixture();
    const server = buildMcpServer(() => fx.ctx);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'trace-test', version: '0.0.0' });
    await client.connect(clientTransport);

    const res = await client.callTool({ name: 'whoami', arguments: {} });
    expect(res.isError).toBeFalsy();
    expect(rec.spans.filter((s) => s.startsWith('tools/call '))).toEqual(['tools/call whoami']);
    await client.close();
  });
});
