import { describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@/generated/prisma/client';
import { pageWorkItemLinkRepository } from '@/lib/repositories/pageWorkItemLinkRepository';

// The hand-link operations of `pageWorkItemLinkRepository` (Story MOTIR-7567 ·
// MOTIR-9197 · MOTIR-9198) against a fake transaction handle: each export is ONE
// Prisma call, and its `where` / `data` name `manual` so a derived row of the
// same pair is never matched or written. The real-table behaviour (the unique
// key, the same-project trigger) is the story gate's.

function fakeTx() {
  const createMany = vi.fn().mockResolvedValue({ count: 1 });
  const deleteMany = vi.fn().mockResolvedValue({ count: 1 });
  const findMany = vi.fn().mockResolvedValue([]);
  const tx = { pageWorkItemLink: { createMany, deleteMany, findMany } };
  return { tx: tx as unknown as Prisma.TransactionClient, createMany, deleteMany, findMany };
}

describe('pageWorkItemLinkRepository hand-link operations', () => {
  it('createManual writes a `manual` row with skipDuplicates and returns the count', async () => {
    const { tx, createMany } = fakeTx();
    const input = {
      workspaceId: 'w',
      projectId: 'pr',
      pageId: 'p',
      workItemId: 'i',
      createdById: 'u',
    };
    expect(await pageWorkItemLinkRepository.createManual(input, tx)).toBe(1);
    expect(createMany).toHaveBeenCalledWith({
      data: [{ ...input, source: 'manual' }],
      skipDuplicates: true,
    });
  });

  it('deleteManual matches only the `manual` row of the pair', async () => {
    const { tx, deleteMany } = fakeTx();
    expect(await pageWorkItemLinkRepository.deleteManual('p', 'i', tx)).toBe(1);
    expect(deleteMany).toHaveBeenCalledWith({
      where: { pageId: 'p', workItemId: 'i', source: 'manual' },
    });
  });

  it('listManualByPage reads newest first, with no seek on the first page', async () => {
    const { tx, findMany } = fakeTx();
    await pageWorkItemLinkRepository.listManualByPage('p', null, 6, tx);
    expect(findMany).toHaveBeenCalledWith({
      where: { pageId: 'p', source: 'manual' },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 6,
      select: { id: true, workItemId: true, createdAt: true },
    });
  });

  it('listManualByPage seeks strictly after the (created_at, id) it was handed', async () => {
    const { tx, findMany } = fakeTx();
    const createdAt = new Date('2026-10-01T00:00:00Z');
    await pageWorkItemLinkRepository.listManualByPage('p', { createdAt, id: 'l1' }, 6, tx);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          pageId: 'p',
          source: 'manual',
          OR: [{ createdAt: { lt: createdAt } }, { createdAt, id: { lt: 'l1' } }],
        },
      }),
    );
  });
});
