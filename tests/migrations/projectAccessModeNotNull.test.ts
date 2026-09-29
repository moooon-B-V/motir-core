import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Prisma } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import {
  ACCESS_MODE_NOT_NULL_MIGRATION,
  nullAccessMode,
  relaxProjectAccessModeNotNull,
  restoreProjectAccessModeNotNull,
} from './_projectAccessModeNotNull';
import { runMigrationFile } from './_workspaceRoleTenant';
import { writeLegacyAccessLevel } from '../helpers/legacyProjectAccess';

// The contract migration of `project.access_mode` (Story MOTIR-6554 · Subtask
// MOTIR-6686), run exactly as `prisma migrate deploy` runs it: one script, one
// session, over the schema as it stood before it — `access_mode` NULLABLE with no
// default (`_projectAccessModeNotNull.ts` rebuilds that state per test). It sets
// DEFAULT `workspace`, refuses a project whose two columns disagree, fills every
// NULL from the legacy level, and makes the column NOT NULL.

beforeEach(async () => {
  await truncateAuthTables();
  await relaxProjectAccessModeNotNull();
});

afterEach(async () => {
  // Truncate first: the refusal case leaves a deliberately disagreeing row, which
  // the restore (this same migration) would refuse.
  await truncateAuthTables();
  await restoreProjectAccessModeNotNull();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

let seq = 0;

async function workspace() {
  const n = seq++;
  const org = await adminDb.organization.create({
    data: { name: `Org pamn${n}`, slug: `pamn-org-${n}` },
  });
  return adminDb.workspace.create({
    data: { name: `WS pamn${n}`, slug: `pamn-ws-${n}`, organizationId: org.id },
  });
}

/** A project as the pre-contract schema holds it: a legacy level, and a mode that may be NULL. */
async function legacyProject(
  workspaceId: string,
  level: 'open' | 'limited' | 'private' | 'public',
  mode: 'workspace' | 'members' | 'public' | null = null,
) {
  const n = seq++;
  const project = await adminDb.project.create({
    data: {
      name: `${level}`,
      slug: `pamn-${level}-${n}`,
      identifier: `PAMN${n}`,
      workspaceId,
      ...(mode ? { accessMode: mode } : {}),
    },
  });
  // legacy-access-level: the NULL-mode rows this migration fills are what it tests.
  await writeLegacyAccessLevel(adminDb, project.id, level);
  if (!mode) await nullAccessMode(project.id);
  return project;
}

async function modeOf(id: string): Promise<string | null> {
  const [row] = await adminDb.$queryRaw<{ access_mode: string | null }[]>(
    Prisma.sql`SELECT "access_mode"::text AS access_mode FROM "project" WHERE "id" = ${id}`,
  );
  return row!.access_mode;
}

describe('the backfill', () => {
  it('fills every NULL mode from its level: open / limited / private / public → workspace / members / members / public', async () => {
    const ws = await workspace();
    const open = await legacyProject(ws.id, 'open');
    const limited = await legacyProject(ws.id, 'limited');
    const priv = await legacyProject(ws.id, 'private');
    const pub = await legacyProject(ws.id, 'public');
    for (const p of [open, limited, priv, pub]) expect(await modeOf(p.id)).toBeNull();

    await runMigrationFile(ACCESS_MODE_NOT_NULL_MIGRATION);

    expect(await modeOf(open.id)).toBe('workspace');
    expect(await modeOf(limited.id)).toBe('members');
    expect(await modeOf(priv.id)).toBe('members');
    expect(await modeOf(pub.id)).toBe('public');
  });

  it('leaves a mode that is already set — and agrees — exactly as it was, and re-runs as a no-op', async () => {
    const ws = await workspace();
    // `limited` and `private` both agree with `members`; the mode is not rewritten.
    const set = await legacyProject(ws.id, 'limited', 'members');
    await runMigrationFile(ACCESS_MODE_NOT_NULL_MIGRATION);
    expect(await modeOf(set.id)).toBe('members');
    await runMigrationFile(ACCESS_MODE_NOT_NULL_MIGRATION);
    expect(await modeOf(set.id)).toBe('members');
  });
});

describe('the agreement check', () => {
  it('RAISES and names the project when a set mode disagrees with its level, and fills nothing', async () => {
    const ws = await workspace();
    const disagreeing = await legacyProject(ws.id, 'public', 'members');
    const untouched = await legacyProject(ws.id, 'open');
    let message: string | null = null;
    try {
      await runMigrationFile(ACCESS_MODE_NOT_NULL_MIGRATION);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('MOTIR-6686');
    expect(message).toContain(disagreeing.id);
    expect(message).not.toContain(untouched.id);
    // The failed migration rolled back: the NULL was not filled.
    expect(await modeOf(untouched.id)).toBeNull();
  });
});

describe('the constraint and the default', () => {
  it('stores `workspace` for an INSERT that names no mode, and refuses an explicit NULL', async () => {
    const ws = await workspace();
    await runMigrationFile(ACCESS_MODE_NOT_NULL_MIGRATION);

    await adminDb.$executeRaw`
      INSERT INTO "project" ("id", "workspaceId", "name", "slug", "identifier", "createdAt", "updatedAt")
      VALUES ('pamn-default', ${ws.id}, 'Defaulted', 'pamn-default', 'PAMNDEF', now(), now())
    `;
    expect(await modeOf('pamn-default')).toBe('workspace');

    await expect(
      adminDb.$executeRaw`
        INSERT INTO "project" ("id", "workspaceId", "name", "slug", "identifier", "access_mode", "createdAt", "updatedAt")
        VALUES ('pamn-null', ${ws.id}, 'Null', 'pamn-null', 'PAMNNUL', NULL, now(), now())
      `,
    ).rejects.toThrow(/null value in column "access_mode"/);
  });
});
