import { describe, expect, it } from 'vitest';
import type { Event } from '@sentry/nextjs';
import {
  dropOrphanedSpanTransactions,
  PARENT_ALREADY_SENT_ATTR,
} from '@/lib/monitoring/orphanedSpans';
import { serverBeforeSendTransaction } from '@/lib/monitoring/serverInit';

// MOTIR-8567 — a span that outlived its already-sent request is not sent as a
// transaction of its own. The flagged event is the shape `@sentry/opentelemetry`'s
// exporter builds for a streaming route's post-response poll.

function transaction(name: string, data: Record<string, unknown>): Event {
  return {
    type: 'transaction',
    transaction: name,
    contexts: { trace: { trace_id: 't', span_id: 's', parent_span_id: 'p', data } },
  };
}

describe('dropOrphanedSpanTransactions', () => {
  it('drops a transaction the exporter flagged as sent after its parent', () => {
    expect(
      dropOrphanedSpanTransactions(
        transaction('prisma:client:operation', { [PARENT_ALREADY_SENT_ATTR]: true }),
      ),
    ).toBeNull();
  });

  it('keeps a request transaction, including one continuing a browser trace', () => {
    const request = transaction('GET /api/workbench/stream', {
      'http.route': '/api/workbench/stream',
    });
    expect(dropOrphanedSpanTransactions(request)).toBe(request);
  });

  it('is applied by the Node runtimes’ beforeSendTransaction', () => {
    expect(
      serverBeforeSendTransaction(
        transaction('db.transaction.wait', { [PARENT_ALREADY_SENT_ATTR]: true }),
      ),
    ).toBeNull();
    expect(serverBeforeSendTransaction(transaction('GET /api/plans/[id]', {}))?.transaction).toBe(
      'GET /api/plans/[id]',
    );
  });
});
