import { adminDb } from './adminDb';

/**
 * The ORGANISATION that owns a workspace — resolved the way production resolves
 * it (MOTIR-4649's `lib/github/resolveOrganizationId`), for fixtures that hold a
 * workspace id and no organisation.
 *
 * ⚠️ WHY A FIXTURE NEEDS THIS AT ALL (MOTIR-4700). `github_repo.organization_id`
 * is NOT NULL, so a mirror row cannot be created without naming its owning
 * organisation — which is the point: a fixture that wrote a repository with no
 * organisation was not describing the system, it was describing the state the
 * column's nullability temporarily permitted. Where the fixture already has the
 * organisation in hand (`fx.workspace.organizationId`), use that directly; this
 * is for the helpers that are handed only a workspace id.
 *
 * `findUniqueOrThrow`, deliberately: an unknown workspace is a broken fixture,
 * and returning null here would let a test re-create the exact state the
 * constraint exists to forbid.
 */
export async function organizationIdOf(workspaceId: string): Promise<string> {
  const workspace = await adminDb.workspace.findUniqueOrThrow({
    where: { id: workspaceId },
    select: { organizationId: true },
  });
  return workspace.organizationId;
}
