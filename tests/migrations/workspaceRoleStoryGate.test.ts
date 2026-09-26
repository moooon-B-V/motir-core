import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import type { WorkspaceRole } from '@/generated/prisma/client';
import { resolvePermissions } from '@/lib/permissions/resolve';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { roleMigrationReportService } from '@/lib/services/roleMigrationReportService';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { makeTenant, runMigrationFile } from './_workspaceRoleTenant';

// THE STORY GATE's migration half (Story MOTIR-6168 · MOTIR-6467): the two data
// migrations run IN ORDER — the mapping, then the never-wider check — over the
// legacy-shaped fixture tenant, exactly as `prisma migrate deploy` would run
// them, and the result is read back through the SHIPPED consumers rather than
// through the rows:
//
//   * every person the report names resolves, through `projectAccessService`, to
//     the role the report says they were given — the report and the resolver
//     cannot disagree about what someone can now do;
//   * the report the Members page reads (`roleMigrationReportService`) is the one
//     the migration wrote, row for row;
//   * the check passes on the honest mapping, and a planted widening between the
//     two makes the deploy raise.
//
// Each migration's own claims are its own card's tests
// (`workspaceRoleMapping.test.ts`, `workspaceRoleNeverWider.test.ts`); this file
// holds only the joins between them and the application.

const MAPPING = '20260926100100_workspace_role_mapping';
const CHECK = '20260926100200_workspace_role_never_wider';

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('both migrations, in order, over the legacy fixture tenant', () => {
  it('the check passes, and every person resolves as the report says', async () => {
    const t = await makeTenant();
    await runMigrationFile(MAPPING);
    await expect(runMigrationFile(CHECK)).resolves.toBeUndefined();

    const rows = await adminDb.roleMigrationReport.findMany({
      where: { workspaceId: t.wsId },
      include: { afterRoleDefinition: true },
    });
    // The fixture holds every reason the mapping can give, so the report is not
    // empty by accident.
    expect(new Set(rows.map((r) => r.reason)).size).toBeGreaterThanOrEqual(4);

    // One person, one outcome: two rows for someone never disagree on the role.
    const byUser = new Map<string, { role: WorkspaceRole; defId: string | null }>();
    for (const r of rows) {
      const outcome = { role: r.afterRole, defId: r.afterRoleDefinitionId };
      const prior = byUser.get(r.userId);
      if (prior) expect(outcome).toEqual(prior);
      byUser.set(r.userId, outcome);
    }

    for (const [userId, outcome] of byUser) {
      const m = await adminDb.workspaceMembership.findUniqueOrThrow({
        where: { userId_workspaceId: { userId, workspaceId: t.wsId } },
        include: { roleDefinition: true },
      });
      expect({ role: m.workspaceRole, defId: m.roleDefinitionId }).toEqual(outcome);

      // …and the RESOLVER, reading the migrated rows, hands them what that role holds.
      for (const p of [t.p1, t.p2]) {
        const added =
          (await adminDb.projectMembership.count({ where: { projectId: p.id, userId } })) > 0;
        const held = await projectAccessService.getPermissions(p.id, {
          userId,
          workspaceId: t.wsId,
        });
        const want = resolvePermissions({
          accessLevel: 'open',
          workspaceRole: outcome.role,
          customRolePermissions: m.roleDefinition?.permissions ?? null,
          addedToProject: added,
        });
        expect([...held].sort(), `${userId} in ${p.identifier}`).toEqual([...want].sort());
      }
    }
  });

  it('the report the Members page reads is the one the migration wrote', async () => {
    const t = await makeTenant();
    await runMigrationFile(MAPPING);
    await runMigrationFile(CHECK);

    const written = await adminDb.roleMigrationReport.findMany({ where: { workspaceId: t.wsId } });
    // `admin` was a workspace admin — a Manager after the mapping, so the report is theirs to read.
    const page = await roleMigrationReportService.listOpen(t.wsId, t.people.admin!);
    const all = [...page.entries];
    let cursor = page.nextCursor;
    while (cursor) {
      const next = await roleMigrationReportService.listOpen(t.wsId, t.people.admin!, cursor);
      all.push(...next.entries);
      cursor = next.nextCursor;
    }
    expect(page.total).toBe(written.length);
    expect(all.map((e) => e.id).sort()).toEqual(written.map((r) => r.id).sort());
    for (const e of all) {
      const row = written.find((r) => r.id === e.id)!;
      expect({ userId: e.userId, afterRole: e.afterRole, reason: e.reason }).toEqual({
        userId: row.userId,
        afterRole: row.afterRole,
        reason: row.reason,
      });
    }
  });

  it('a planted widening between the two migrations makes the check raise', async () => {
    const t = await makeTenant();
    await runMigrationFile(MAPPING);
    // The former workspace VIEWER, written as a Member — wider in every project.
    await adminDb.workspaceMembership.update({
      where: { userId_workspaceId: { userId: t.people.viewer!, workspaceId: t.wsId } },
      data: { workspaceRole: 'member' },
    });
    await expect(runMigrationFile(CHECK)).rejects.toThrow(/MOTIR-6461/);
  });
});
