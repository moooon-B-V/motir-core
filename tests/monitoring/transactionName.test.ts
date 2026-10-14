import { describe, expect, it } from 'vitest';
import type { Event } from '@sentry/nextjs';
import { ROOT_NAME_ATTR, restoreChosenRootName } from '@/lib/monitoring/transactionName';
import { serverBeforeSendTransaction, serverSentryInitOptions } from '@/lib/monitoring/serverInit';

// MOTIR-8566 — a root name request code chose survives Next's event-time rename.
// The event below is the shape `@sentry/nextjs`'s `preprocessEvent` leaves an MCP
// call's transaction in: renamed back to `POST /api/mcp`, its trace data still
// carrying the name `lib/mcp/toolTracing.ts` chose.

function renamedByNext(data: Record<string, unknown>): Event {
  return {
    type: 'transaction',
    transaction: 'POST /api/mcp',
    transaction_info: { source: 'route' },
    contexts: { trace: { trace_id: 't', span_id: 's', op: 'http.server', data } },
  };
}

describe('restoreChosenRootName', () => {
  it('puts the chosen name back, as a custom-sourced name', () => {
    const event = restoreChosenRootName(
      renamedByNext({ [ROOT_NAME_ATTR]: 'MCP tools/call move_to_parent' }),
    );
    expect(event.transaction).toBe('MCP tools/call move_to_parent');
    expect(event.transaction_info?.source).toBe('custom');
  });

  it('leaves a transaction with no chosen name exactly as Next named it', () => {
    const event = restoreChosenRootName(renamedByNext({ 'http.route': '/api/plans/[id]' }));
    expect(event.transaction).toBe('POST /api/mcp');
    expect(event.transaction_info?.source).toBe('route');
  });

  it('ignores a non-string attribute', () => {
    expect(restoreChosenRootName(renamedByNext({ [ROOT_NAME_ATTR]: 7 })).transaction).toBe(
      'POST /api/mcp',
    );
  });

  it('is the Node runtimes’ beforeSendTransaction', () => {
    process.env['SENTRY_DSN'] = 'http://k@127.0.0.1:9/1';
    try {
      expect(serverSentryInitOptions()?.beforeSendTransaction).toBe(serverBeforeSendTransaction);
    } finally {
      delete process.env['SENTRY_DSN'];
    }
    const event = serverBeforeSendTransaction(
      renamedByNext({ [ROOT_NAME_ATTR]: 'MCP tools/call whoami' }),
    );
    expect(event?.transaction).toBe('MCP tools/call whoami');
  });
});
