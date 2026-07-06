import { describe, expect, it } from 'vitest';
import { classifyByHash, computeSourceHash } from '@/lib/import/engine/importIdempotency';
import type { ResolvedWorkItemPayload } from '@/lib/import/engine/types';

// Unit tests for the idempotency classifier + source hash (MOTIR-1504). Pure.

function payload(overrides: Partial<ResolvedWorkItemPayload> = {}): ResolvedWorkItemPayload {
  return {
    kind: 'task',
    title: 'A',
    descriptionMd: 'body',
    priority: 'medium',
    statusKey: 'todo',
    assigneeId: 'u1',
    reporterId: 'u2',
    reporterEmail: 'r@x.com',
    labels: ['b', 'a'],
    comments: [
      {
        authorId: 'u1',
        authorEmail: 'c@x.com',
        authorName: 'C',
        body: 'hi',
        createdAt: '2026-01-01T00:00:00Z',
      },
    ],
    attachments: [],
    parentExternalId: null,
    links: [],
    createdAt: '2026-01-01T00:00:00Z',
    closedAt: null,
    ...overrides,
  };
}

describe('computeSourceHash', () => {
  it('is stable for the same payload and label order', () => {
    expect(computeSourceHash(payload())).toBe(computeSourceHash(payload({ labels: ['a', 'b'] })));
  });

  it('changes when a source-owned field changes', () => {
    expect(computeSourceHash(payload())).not.toBe(computeSourceHash(payload({ title: 'B' })));
    expect(computeSourceHash(payload())).not.toBe(
      computeSourceHash(payload({ statusKey: 'done' })),
    );
  });

  it('ignores Motir-local-only fields (links / attachments)', () => {
    expect(computeSourceHash(payload())).toBe(
      computeSourceHash(payload({ links: [{ type: 'blocks', targetExternalId: 'X-1' }] })),
    );
  });
});

describe('classifyByHash', () => {
  const h = 'abc';
  it('CREATE when no existing mapping', () => {
    expect(classifyByHash(null, h)).toEqual({ plan: 'create', existingWorkItemId: null });
  });
  it('SKIP when the hash is unchanged', () => {
    expect(classifyByHash({ workItemId: 'wi', sourceHash: h }, h)).toEqual({
      plan: 'skip',
      existingWorkItemId: 'wi',
    });
  });
  it('UPDATE when the hash changed', () => {
    expect(classifyByHash({ workItemId: 'wi', sourceHash: 'old' }, h)).toEqual({
      plan: 'update',
      existingWorkItemId: 'wi',
    });
  });
  it('UPDATE when the existing mapping has no stored hash', () => {
    expect(classifyByHash({ workItemId: 'wi', sourceHash: null }, h)).toEqual({
      plan: 'update',
      existingWorkItemId: 'wi',
    });
  });
});
