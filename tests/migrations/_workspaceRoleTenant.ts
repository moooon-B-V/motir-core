import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Client } from 'pg';
import { adminDb } from '../helpers/adminDb';
import { currentWorkerAdminUrl } from '../helpers/parallelDb';

// The fixture tenant the workspace-role migrations are proven over (Story
// MOTIR-6168): the mapping (MOTIR-6458) and the never-wider check (MOTIR-6461)
// run over the SAME people, so a case added here reaches both.

/** Run a migration file exactly as `prisma migrate deploy` runs it: one script, one session. */
export async function runMigrationFile(dir: string, transform: (sql: string) => string = (s) => s) {
  const sql = readFileSync(
    path.join(process.cwd(), 'prisma/migrations', dir, 'migration.sql'),
    'utf8',
  );
  const client = new Client({ connectionString: currentWorkerAdminUrl() });
  await client.connect();
  try {
    await client.query(transform(sql));
  } finally {
    await client.end();
  }
}

// ── The fixture tenant ─────────────────────────────────────────────────────────
let seq = 0;

export async function user(label: string) {
  const n = seq++;
  return adminDb.user.create({
    data: { email: `wrm-${label}-${n}@example.com`, name: `WRM ${label}`, emailVerified: true },
  });
}

export interface Tenant {
  orgId: string;
  wsId: string;
  p1: { id: string; identifier: string };
  p2: { id: string; identifier: string };
  people: Record<string, string>;
  roles: Record<string, string>;
}

/**
 * One organization, one workspace, two projects, and one person per case:
 *
 *   orgOwner   — workspace owner who is ALREADY the org's Owner → Manager, no grant
 *   owner      — workspace owner who is an org MEMBER → Manager + org Admin
 *   admin      — workspace admin → Manager
 *   member     — plain member, no project role → Member
 *   viewer     — plain viewer → Viewer
 *   narrower   — member, project VIEWER in P1 → Viewer, narrowest_kept
 *   wider      — member, project ADMIN in P1 → Member, project_role_dropped
 *   custom     — member, custom "Contractor" in P1 (narrower than Member) → custom_role_recreated
 *   merged     — member, "Triage" in P1 and "Reviewer" in P2, incomparable → custom_role_merged
 *   sameName   — member, the P2 "Contractor" (same NAME, different set) → its own suffixed role
 */
export async function makeTenant(): Promise<Tenant> {
  const n = seq++;
  const org = await adminDb.organization.create({
    data: { name: `Org wrm${n}`, slug: `wrm-org-${n}` },
  });
  const ws = await adminDb.workspace.create({
    data: { name: `WS wrm${n}`, slug: `wrm-ws-${n}`, organizationId: org.id },
  });
  const p1 = await adminDb.project.create({
    data: { name: 'P1', slug: `wrm-p1-${n}`, identifier: `WRA${n}`, workspaceId: ws.id },
  });
  const p2 = await adminDb.project.create({
    data: { name: 'P2', slug: `wrm-p2-${n}`, identifier: `WRB${n}`, workspaceId: ws.id },
  });

  const people: Record<string, string> = {};
  for (const label of [
    'orgOwner',
    'owner',
    'admin',
    'member',
    'viewer',
    'narrower',
    'wider',
    'custom',
    'merged',
    'sameName',
  ]) {
    people[label] = (await user(label)).id;
  }
  const wsRole: Record<string, 'owner' | 'admin' | 'member' | 'viewer'> = {
    orgOwner: 'owner',
    owner: 'owner',
    admin: 'admin',
    viewer: 'viewer',
  };
  for (const [label, id] of Object.entries(people)) {
    await adminDb.workspaceMembership.create({
      data: { userId: id, workspaceId: ws.id, role: wsRole[label] ?? 'member' },
    });
    await adminDb.organizationMembership.create({
      data: {
        organizationId: org.id,
        userId: id,
        role: label === 'orgOwner' ? 'owner' : label === 'admin' ? 'admin' : 'member',
      },
    });
  }

  const def = (projectId: string, name: string, permissions: string[]) =>
    adminDb.projectRoleDefinition.create({
      data: { workspaceId: ws.id, projectId, name, permissions },
    });
  const contractorP1 = await def(p1.id, 'Contractor', [
    'project:browse',
    'comment:add',
    'report:view',
  ]);
  const contractorP2 = await def(p2.id, 'Contractor', [
    'project:browse',
    'report:view',
    'approval:view_any',
  ]);
  const triage = await def(p1.id, 'Triage', ['project:browse', 'report:view', 'work_item:triage']);
  const reviewer = await def(p2.id, 'Reviewer', [
    'project:browse',
    'report:view',
    'comment:add',
    'plan:view_any',
  ]);
  // The same key set as Contractor-P1 in the SAME workspace, under another name:
  // it must fold into Contractor-P1's workspace role, not become a second row.
  const twin = await def(p2.id, 'Commenter', ['report:view', 'comment:add', 'project:browse']);

  const pm = (
    projectId: string,
    userId: string,
    role: 'admin' | 'member' | 'viewer',
    roleDefinitionId?: string,
  ) =>
    adminDb.projectMembership.create({
      data: {
        workspaceId: ws.id,
        projectId,
        userId,
        role,
        roleDefinitionId: roleDefinitionId ?? null,
      },
    });
  await pm(p1.id, people.narrower!, 'viewer');
  await pm(p2.id, people.narrower!, 'member');
  await pm(p1.id, people.wider!, 'admin');
  await pm(p1.id, people.custom!, 'member', contractorP1.id);
  await pm(p1.id, people.merged!, 'member', triage.id);
  await pm(p2.id, people.merged!, 'member', reviewer.id);
  await pm(p2.id, people.sameName!, 'member', contractorP2.id);
  await pm(p1.id, people.admin!, 'viewer'); // ignored — a Manager's project roles do not count

  return {
    orgId: org.id,
    wsId: ws.id,
    p1: { id: p1.id, identifier: p1.identifier },
    p2: { id: p2.id, identifier: p2.identifier },
    people,
    roles: {
      contractorP1: contractorP1.id,
      contractorP2: contractorP2.id,
      triage: triage.id,
      reviewer: reviewer.id,
      twin: twin.id,
    },
  };
}
