import type { Prisma } from '@/generated/prisma/client';

// The RETIRED project custom-role storage, reached with raw SQL (MOTIR-6567).
//
// `ProjectRoleDefinition` is `@@ignore`d and `ProjectMembership.roleDefinitionId`
// is `@ignore`d, so the generated client has no accessor for either — which is
// the point of phase 2: nothing in the application may select them. The TABLE
// and the COLUMN stay in the database until the phase-3 drop (MOTIR-6569), and
// the tests that still own them — the migrations that read the legacy rows, and
// the table's own constraint + RLS suite — seed and read them through here.
// Delete this file with the drop.

type RawClient = Pick<Prisma.TransactionClient, '$queryRaw' | '$executeRaw'>;

export interface LegacyProjectRole {
  id: string;
  workspaceId: string;
  projectId: string;
  name: string;
  permissions: string[];
  createdAt: Date;
  updatedAt: Date;
}

export async function insertLegacyProjectRole(
  client: RawClient,
  data: { workspaceId: string; projectId: string; name: string; permissions: string[] },
): Promise<LegacyProjectRole> {
  const rows = await client.$queryRaw<LegacyProjectRole[]>`
    INSERT INTO "project_role_definition"
      ("id", "workspace_id", "project_id", "name", "permissions", "created_at", "updated_at")
    VALUES (gen_random_uuid()::text, ${data.workspaceId}, ${data.projectId}, ${data.name},
            ${data.permissions}::text[], now(), now())
    RETURNING "id", "workspace_id" AS "workspaceId", "project_id" AS "projectId", "name", "permissions",
              "created_at" AS "createdAt", "updated_at" AS "updatedAt"`;
  return rows[0]!;
}

/** Every legacy project role visible to `client`, ordered by id; `id` narrows to one. */
export function listLegacyProjectRoles(
  client: RawClient,
  where: { id?: string } = {},
): Promise<LegacyProjectRole[]> {
  return where.id === undefined
    ? client.$queryRaw<LegacyProjectRole[]>`
        SELECT "id", "workspace_id" AS "workspaceId", "project_id" AS "projectId", "name", "permissions",
               "created_at" AS "createdAt", "updated_at" AS "updatedAt"
          FROM "project_role_definition" ORDER BY "id"`
    : client.$queryRaw<LegacyProjectRole[]>`
        SELECT "id", "workspace_id" AS "workspaceId", "project_id" AS "projectId", "name", "permissions",
               "created_at" AS "createdAt", "updated_at" AS "updatedAt"
          FROM "project_role_definition" WHERE "id" = ${where.id}`;
}

export async function findLegacyProjectRole(
  client: RawClient,
  id: string,
): Promise<LegacyProjectRole | null> {
  return (await listLegacyProjectRoles(client, { id }))[0] ?? null;
}

export function deleteLegacyProjectRole(client: RawClient, id: string): Promise<number> {
  return client.$executeRaw`DELETE FROM "project_role_definition" WHERE "id" = ${id}`;
}

/** Point a project membership at a legacy role — the `@ignore`d `role_definition_id`. */
export function setLegacyRoleDefinition(
  client: RawClient,
  membership: { userId: string; projectId: string },
  roleDefinitionId: string | null,
): Promise<number> {
  return client.$executeRaw`
    UPDATE "project_membership" SET "role_definition_id" = ${roleDefinitionId}
     WHERE "user_id" = ${membership.userId} AND "project_id" = ${membership.projectId}`;
}

/** A project membership's legacy `role_definition_id`, or `undefined` when there is no membership. */
export async function legacyRoleDefinitionOf(
  client: RawClient,
  membership: { userId: string; projectId: string },
): Promise<string | null | undefined> {
  const rows = await client.$queryRaw<{ roleDefinitionId: string | null }[]>`
    SELECT "role_definition_id" AS "roleDefinitionId" FROM "project_membership"
     WHERE "user_id" = ${membership.userId} AND "project_id" = ${membership.projectId}`;
  return rows.length === 0 ? undefined : rows[0]!.roleDefinitionId;
}
