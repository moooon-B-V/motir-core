import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import type { Prisma } from '@/generated/prisma/client';
import { adminDb } from '../helpers/adminDb';

/**
 * The run-model list's PUBLIC read arm (Story MOTIR-7521 · MOTIR-7526) — the
 * evidence `singleton-read-guard.test.ts`'s `public` verdict cites.
 *
 * The hosted-run offer reads the list on CUSTOMER paths, with no platform flag
 * and no tenant bound, so it relies on both tables' SELECT policy admitting a
 * row with nothing set. And the arm must be read-only: a write with nothing
 * bound is refused, because `app.platform_staff` is what the write arm needs.
 */

async function asAppRole<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return db.$transaction(async (tx) => {
    // RLS is inert under the superuser (BYPASSRLS); the role switch is what
    // makes these assertions mean anything.
    await tx.$executeRawUnsafe('SET LOCAL ROLE motir_app');
    return fn(tx);
  });
}

async function clear() {
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "platform_run_model", "platform_run_model_list" CASCADE',
  );
}

beforeEach(clear);

afterAll(async () => {
  await clear();
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('the offer read', () => {
  it('ADMITS the marker and every listed model with nothing bound', async () => {
    await adminDb.platformRunModelList.create({ data: { id: 'platform' } });
    await adminDb.platformRunModel.createMany({
      data: [{ model: 'claude-opus-5-5' }, { model: 'deepseek-v4-pro' }],
    });
    const rows = await asAppRole(
      (tx) =>
        tx.$queryRaw<{ model: string | null }[]>`
        SELECT r."model"
        FROM "platform_run_model_list" m
        LEFT JOIN "platform_run_model" r ON true
        WHERE m."id" = 'platform'
        ORDER BY r."model"`,
    );
    expect(rows.map((r) => r.model)).toEqual(['claude-opus-5-5', 'deepseek-v4-pro']);
  });

  it('REFUSES a write with nothing bound — the arm is read-only', async () => {
    await expect(
      asAppRole(
        (tx) => tx.$executeRaw`INSERT INTO "platform_run_model" ("model") VALUES ('glm-5.2')`,
      ),
    ).rejects.toThrow();
    expect(await adminDb.platformRunModel.count()).toBe(0);
  });
});
