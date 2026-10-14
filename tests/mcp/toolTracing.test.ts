import { AsyncLocalStorage } from 'node:async_hooks';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

// MOTIR-8551 — every MCP tool call is a span named for its tool, and the request's
// root is renamed for it. The Sentry span API is replaced by a RECORDER that keeps
// a real parent chain (AsyncLocalStorage, as the SDK's own strategy is), so the
// nesting, the names and the attributes are all observable.

interface RecordedSpan {
  id: number;
  name: string;
  op?: string;
  parent: RecordedSpan | null;
  attributes: Record<string, unknown>;
  status?: { code: number; message?: string };
  setAttribute(key: string, value: unknown): void;
}

const rec = vi.hoisted(() => ({
  spans: [] as RecordedSpan[],
  renamed: [] as Array<{ span: RecordedSpan; name: string }>,
  tags: [] as Array<[string, string]>,
}));

const active = new AsyncLocalStorage<RecordedSpan>();

vi.mock('@sentry/nextjs', () => {
  const makeSpan = (name: string, op: string | undefined, parent: RecordedSpan | null) => {
    const span: RecordedSpan = {
      id: rec.spans.length + 1,
      name,
      op,
      parent,
      attributes: {},
      setAttribute(key: string, value: unknown) {
        this.attributes[key] = value;
      },
    };
    rec.spans.push(span);
    return span;
  };
  const handle = (span: RecordedSpan) => ({
    setAttributes(attrs: Record<string, unknown>) {
      Object.assign(span.attributes, attrs);
    },
    setStatus(status: { code: number; message?: string }) {
      span.status = status;
    },
    __span: span,
  });
  return {
    startSpan: (
      opts: { name: string; op?: string; attributes?: Record<string, unknown> },
      fn: (span: unknown) => unknown,
    ) => {
      const span = makeSpan(opts.name, opts.op, active.getStore() ?? null);
      Object.assign(span.attributes, opts.attributes ?? {});
      return active.run(span, () => fn(handle(span)));
    },
    // Initialised: the wrapper only draws spans once `Sentry.init` has run.
    getClient: () => ({}),
    getActiveSpan: () => active.getStore(),
    getRootSpan: (span: RecordedSpan) => {
      let root = span;
      while (root.parent) root = root.parent;
      return root;
    },
    updateSpanName: (span: RecordedSpan, name: string) => {
      rec.renamed.push({ span, name });
      span.name = name;
    },
    setTag: (key: string, value: string) => {
      rec.tags.push([key, value]);
    },
  };
});

const Sentry = await import('@sentry/nextjs');
const { currentMcpToolName, traceMcpToolCall, tracedServer, MCP_TOOL_ATTR } =
  await import('@/lib/mcp/toolTracing');
const { ROOT_NAME_ATTR } = await import('@/lib/monitoring/transactionName');

beforeEach(() => {
  rec.spans.length = 0;
  rec.renamed.length = 0;
  rec.tags.length = 0;
});

const OK: CallToolResult = { content: [{ type: 'text', text: 'done' }] };

/** A request: an HTTP root span, as Next's instrumentation opens one. */
function inRequest<T>(fn: () => Promise<T>): Promise<T> {
  return Sentry.startSpan({ name: 'POST /api/mcp' }, fn) as Promise<T>;
}

describe('one tool call', () => {
  it('opens one `tools/call <tool>` span with the MCP attributes, and returns the result unchanged', async () => {
    const callback = vi.fn(async () => OK);
    const result = await inRequest(() => traceMcpToolCall('move_to_parent', callback));
    expect(result).toBe(OK);
    expect(callback).toHaveBeenCalledTimes(1);
    const tool = rec.spans.filter((s) => s.op === 'mcp.server');
    expect(tool).toHaveLength(1);
    expect(tool[0]!.name).toBe('tools/call move_to_parent');
    expect(tool[0]!.attributes).toMatchObject({
      [MCP_TOOL_ATTR.method]: 'tools/call',
      [MCP_TOOL_ATTR.tool]: 'move_to_parent',
      [MCP_TOOL_ATTR.outcome]: 'ok',
    });
    expect(tool[0]!.status).toBeUndefined();
  });

  it('renames the request root `MCP tools/call <tool>` and tags the scope', async () => {
    await inRequest(() => traceMcpToolCall('add_plan_items', async () => OK));
    const root = rec.spans.find((s) => s.parent === null)!;
    expect(root.name).toBe('MCP tools/call add_plan_items');
    // …and carries it as the attribute `beforeSendTransaction` restores after
    // Next's event-time rename (MOTIR-8566).
    expect(root.attributes[ROOT_NAME_ATTR]).toBe('MCP tools/call add_plan_items');
    expect(rec.tags).toContainEqual(['mcp.tool', 'add_plan_items']);
  });

  it('with no request span, the tool span IS the root and carries the tool’s name', async () => {
    await traceMcpToolCall('whoami', async () => OK);
    expect(rec.renamed).toHaveLength(0);
    expect(rec.spans).toHaveLength(1);
    expect(rec.spans[0]!.parent).toBeNull();
    expect(rec.spans[0]!.name).toBe('tools/call whoami');
  });

  it('two calls in one request name the root `MCP tools/call (batch)`, each keeping its own span', async () => {
    await inRequest(async () => {
      await traceMcpToolCall('get_work_item', async () => OK);
      await traceMcpToolCall('move_to_parent', async () => OK);
    });
    const root = rec.spans.find((s) => s.parent === null)!;
    expect(root.name).toBe('MCP tools/call (batch)');
    expect(root.attributes[ROOT_NAME_ATTR]).toBe('MCP tools/call (batch)');
    expect(rec.spans.filter((s) => s.op === 'mcp.server').map((s) => s.name)).toEqual([
      'tools/call get_work_item',
      'tools/call move_to_parent',
    ]);
  });
});

describe('the outcome', () => {
  it('an isError result — a scope or rate-limit refusal included — is tool_error, with an error status', async () => {
    const refused: CallToolResult = { isError: true, content: [{ type: 'text', text: 'no' }] };
    const result = await inRequest(() => traceMcpToolCall('expand_item', async () => refused));
    expect(result).toBe(refused);
    const tool = rec.spans.find((s) => s.op === 'mcp.server')!;
    expect(tool.attributes[MCP_TOOL_ATTR.outcome]).toBe('tool_error');
    expect(tool.status?.code).toBe(2);
  });

  it('a throw is recorded as thrown and re-thrown with the same identity', async () => {
    const boom = new Error('boom');
    await expect(
      inRequest(() =>
        traceMcpToolCall('claim_work_item', async () => {
          throw boom;
        }),
      ),
    ).rejects.toBe(boom);
    const tool = rec.spans.find((s) => s.op === 'mcp.server')!;
    expect(tool.attributes[MCP_TOOL_ATTR.outcome]).toBe('thrown');
    expect(tool.status?.code).toBe(2);
  });
});

describe('what runs inside the call', () => {
  it('a span started inside the callback is a child of the tool span', async () => {
    await inRequest(() =>
      traceMcpToolCall('move_to_parent', async () => {
        await Sentry.startSpan({ name: 'db.transaction' }, async () => {});
        return OK;
      }),
    );
    const tool = rec.spans.find((s) => s.op === 'mcp.server')!;
    const inner = rec.spans.find((s) => s.name === 'db.transaction')!;
    expect(inner.parent).toBe(tool);
  });

  it('currentMcpToolName() names the tool inside the call, across an await, and is null outside', async () => {
    const seen: Array<string | null> = [];
    expect(currentMcpToolName()).toBeNull();
    await traceMcpToolCall('get_work_item', async () => {
      seen.push(currentMcpToolName());
      await new Promise((resolve) => setTimeout(resolve, 5));
      seen.push(currentMcpToolName());
      return OK;
    });
    expect(seen).toEqual(['get_work_item', 'get_work_item']);
    expect(currentMcpToolName()).toBeNull();
  });
});

describe('tracedServer — the registerTool Proxy', () => {
  it('wraps the registered callback; nothing about the arguments is recorded', async () => {
    const SENTINEL = 'argument-sentinel-8551-must-not-be-recorded';
    let registered: ((args: unknown, extra: unknown) => Promise<CallToolResult>) | null = null;
    const fake = {
      registerTool: (_name: string, _config: unknown, cb: typeof registered) => {
        registered = cb;
      },
      other: 'passes through',
    };
    const proxied = tracedServer(fake as never) as unknown as typeof fake;
    expect(proxied.other).toBe('passes through');
    const callback = vi.fn(async () => OK);
    proxied.registerTool('create_work_item', {}, callback);
    const result = await inRequest(() =>
      registered!({ title: SENTINEL, projectKey: SENTINEL }, { authInfo: SENTINEL }),
    );
    expect(result).toBe(OK);
    expect(callback).toHaveBeenCalledWith(
      { title: SENTINEL, projectKey: SENTINEL },
      { authInfo: SENTINEL },
    );
    expect(rec.spans.find((s) => s.op === 'mcp.server')?.name).toBe('tools/call create_work_item');
    const recorded = JSON.stringify({
      spans: rec.spans.map((s) => ({ name: s.name, attributes: s.attributes })),
      renamed: rec.renamed.map((r) => r.name),
      tags: rec.tags,
    });
    expect(recorded).not.toContain(SENTINEL);
  });
});
