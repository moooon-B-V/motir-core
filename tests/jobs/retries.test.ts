import { describe, expect, it, vi } from 'vitest';
import { inngest } from '@/lib/jobs/client';
import { defineJob } from '@/lib/jobs/defineJob';
import {
  DEFAULT_RETRY_POLICY,
  policyToRetries,
  resolveRetries,
  RETRY_POLICIES,
} from '@/lib/jobs/retries';

// Retry-policy module (Story 1.6 · Subtask 1.6.4). Pure unit tests for the
// named-policy → Inngest-retries translation, plus a wiring test that
// defineJob forwards the resolved retry count into the Inngest function config.

describe('retry policies', () => {
  it('exposes the three named policies with documented attempt budgets', () => {
    expect(RETRY_POLICIES.transient.maxAttempts).toBe(3);
    expect(RETRY_POLICIES.idempotent.maxAttempts).toBe(5);
    expect(RETRY_POLICIES.none.maxAttempts).toBe(1);
  });

  it('translates a policy to Inngest retries = maxAttempts - 1', () => {
    expect(policyToRetries('transient')).toBe(2);
    expect(policyToRetries('idempotent')).toBe(4);
    expect(policyToRetries('none')).toBe(0);
  });

  it('resolveRetries: a named policy wins', () => {
    expect(resolveRetries({ retryPolicy: 'idempotent' })).toBe(4);
  });

  it('resolveRetries: a raw retries count passes through', () => {
    expect(resolveRetries({ retries: 7 })).toBe(7);
  });

  it('resolveRetries: neither given falls back to the default policy (transient)', () => {
    expect(resolveRetries({})).toBe(policyToRetries(DEFAULT_RETRY_POLICY));
    expect(resolveRetries({})).toBe(2);
  });

  it('resolveRetries: specifying BOTH retryPolicy and retries throws (ambiguous intent)', () => {
    expect(() => resolveRetries({ retryPolicy: 'transient', retries: 3 })).toThrow(/not both/i);
  });
});

describe('defineJob forwards the resolved retry budget', () => {
  it('maps retryPolicy "none" to retries: 0 in the Inngest config', () => {
    const spy = vi.spyOn(inngest, 'createFunction');
    try {
      defineJob({ id: 'email.send', retryPolicy: 'none' }, () => undefined);
      const config = spy.mock.calls.at(-1)?.[0] as { retries?: number } | undefined;
      expect(config?.retries).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });

  it('maps retryPolicy "idempotent" to retries: 4 in the Inngest config', () => {
    const spy = vi.spyOn(inngest, 'createFunction');
    try {
      defineJob({ id: 'email.send', retryPolicy: 'idempotent' }, () => undefined);
      const config = spy.mock.calls.at(-1)?.[0] as { retries?: number } | undefined;
      expect(config?.retries).toBe(4);
    } finally {
      spy.mockRestore();
    }
  });

  it('throws at definition time when both retryPolicy and retries are given', () => {
    expect(() =>
      defineJob({ id: 'email.send', retryPolicy: 'transient', retries: 3 }, () => undefined),
    ).toThrow(/not both/i);
  });
});
