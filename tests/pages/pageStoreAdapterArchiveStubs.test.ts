import { describe, expect, it } from 'vitest';
import type { Prisma } from '@/generated/prisma/client';
import { createPageStore } from '@/lib/pages/pageStoreAdapter';

// MOTIR-7418 adds four archive methods to the `PageStore` port; their Postgres
// half is MOTIR-7420's. Until it lands, each adapter method refuses loudly — a
// call before then is a wiring defect, never a silent no-op. MOTIR-7420 replaces
// this file with the real adapter tests.

describe('PageStore adapter — archive methods before MOTIR-7420', () => {
  const store = createPageStore({} as Prisma.TransactionClient);

  it.each([
    ['setArchived', () => store.setArchived(['p'], null, null, null)],
    ['findArchiveSet', () => store.findArchiveSet('p')],
    ['deletePages', () => store.deletePages(['p'])],
    ['positionTaken', () => store.positionTaken('proj', { kind: 'root' }, 'a0')],
  ] as const)('%s refuses as not wired yet', async (method, call) => {
    await expect(call()).rejects.toThrow(`PageStore.${method} is not wired to Postgres yet`);
  });
});
