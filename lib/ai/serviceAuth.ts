import { verifyServiceBearer } from './serviceBearer';
import { metaProjectKey, MOTIR_SYSTEM_USER_EMAIL } from './systemPrincipal';
import { userRepository } from '@/lib/repositories/userRepository';
import { workspaceMembershipRepository } from '@/lib/repositories/workspaceMembershipRepository';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { withSystemContext, withUserContext } from '@/lib/workspaces/context';
import { projectsService } from '@/lib/services/projectsService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { ProjectDTO } from '@/lib/dto/projects';

// The TENANT-LESS service-auth path the AI uses to write AS the Motir system
// principal (MOTIR-1451 — the foundation MOTIR-1450's `POST
// /api/internal/ai/work-items` route consumes).
//
// Contrast `authenticateJobRequest` (lib/ai/jobAuth.ts): that path proves §4a
// (is this motir-ai?) AND §4b (a job-scoped token: acting as WHICH user, for
// WHICH project, for 15 min) — so it is bound to the ONE tenant that triggered
// the job and can never target a different named project. The bug-filing loop
// needs the opposite: write a `kind: bug` into the Motir META project
// (MOTIR/PROD) REGARDLESS of which tenant triggered it. So this path verifies
// ONLY the §4a service bearer and acts as a fixed, well-known SYSTEM PRINCIPAL
// (a real workspace member, so every downstream guard — `assertReporterMember`,
// the 6.4 project gate, the work_item reporter FK — is satisfied with no
// bypass), NOT a per-request user. The narrower credential is deliberate: this
// path can target a project outside any caller's tenant, so it must NOT carry a
// caller-supplied identity.

export class ServiceAuthError extends Error {
  readonly httpStatus = 401;
  readonly code = 'service_unauthorized' as const;
  constructor(detail: string) {
    super(detail);
    this.name = 'ServiceAuthError';
  }
}

// The system principal row/membership is missing — a SERVER INVARIANT, not a
// caller error (the seed provisions it; see scripts/plan-seed/systemPrincipal.ts).
// Surfaced as 500 so a mis-seeded environment is loud, never a silent 401/404
// that would read like an auth/scope problem.
export class SystemPrincipalNotProvisionedError extends Error {
  readonly httpStatus = 500;
  readonly code = 'system_principal_not_provisioned' as const;
  constructor() {
    super(
      'The Motir system principal is not provisioned: no system user is a member of any workspace. Run the seed (scripts/plan-seed).',
    );
    this.name = 'SystemPrincipalNotProvisionedError';
  }
}

export interface ServiceRequestAuth {
  /** The system principal's context — its user id + the META workspace it
   *  belongs to. Usable directly as a `WorkspaceContext` (project-by-key
   *  resolution) and a `ServiceContext` (the work-items create path). */
  ctx: ServiceContext;
}

/**
 * The Motir system account's id, or `SystemPrincipalNotProvisionedError` when the
 * environment has no such row.
 */
export async function motirSystemUserId(): Promise<string> {
  const user = await userRepository.findByEmail(MOTIR_SYSTEM_USER_EMAIL);
  if (!user) throw new SystemPrincipalNotProvisionedError();
  return user.id;
}

/**
 * A context for the Motir system account BOUND TO `workspaceId` (MOTIR-9329) — the
 * writer of everything Motir AI writes into a tenant's tree. Built from the account's
 * id and the given workspace with NO membership read: the gates admit the account by
 * identity (`isMotirSystemUser`), and `withWorkspaceContext` binds the workspace's
 * GUCs for every read and write the services make with it.
 *
 * ⚠️ `workspaceId` must come from a TRUSTED resolution — a stored row the caller has
 * already authorised (the person's own conversation, the project their write targets)
 * — never from request input, exactly as `withWorkspaceServiceContext` requires.
 */
export async function motirSystemContext(workspaceId: string): Promise<ServiceContext> {
  return { userId: await motirSystemUserId(), workspaceId };
}

/**
 * Resolve the well-known Motir system principal to the context every
 * downstream service expects: its `userId` (the create's reporter) and the
 * `workspaceId` of the META workspace.
 *
 * The META workspace is the one holding the project keyed `metaProjectKey()` in an
 * organisation flagged `isMeta` (MOTIR-9329) — read under `withSystemContext`, whose
 * `system_admin` arm `project`, `workspace` and `organization` all carry. The isMeta
 * filter is what keeps a CUSTOMER project that happens to be keyed `MOTIR` out of
 * it. An environment with no flagged organisation (dev, test, preview) falls back to
 * the principal's OWN membership, which the seed provisions — the shipped resolution,
 * read inside `withUserContext` so the membership-scoped RLS policy still gates it to
 * the principal's own rows.
 *
 * Throws `SystemPrincipalNotProvisionedError` (500) when the user is absent, or when
 * neither the meta project nor a membership names its workspace — a seeding
 * invariant, surfaced loudly.
 */
export async function resolveSystemPrincipal(): Promise<ServiceContext> {
  const userId = await motirSystemUserId();
  const key = metaProjectKey();
  const meta = await withSystemContext(async (tx) =>
    (await projectRepository.listInMetaOrganizations(tx)).find((p) => p.identifier === key),
  );
  if (meta) return { userId, workspaceId: meta.workspaceId };
  const membership = await withUserContext(userId, (tx) =>
    workspaceMembershipRepository.findFirstByUserWithWorkspace(userId, tx),
  );
  if (!membership) throw new SystemPrincipalNotProvisionedError();
  return { userId, workspaceId: membership.workspaceId };
}

/**
 * Authenticate an ai→core service-write request: verify the §4a service bearer
 * (NO job token) and resolve the system principal. Throws `ServiceAuthError`
 * (401) when the bearer is missing/wrong/unset (fails closed via
 * `verifyServiceBearer`), or `SystemPrincipalNotProvisionedError` (500) when
 * the principal isn't seeded.
 */
export async function authenticateServiceRequest(req: Request): Promise<ServiceRequestAuth> {
  if (!verifyServiceBearer(req)) {
    throw new ServiceAuthError('A valid service bearer is required.');
  }
  const ctx = await resolveSystemPrincipal();
  return { ctx };
}

/**
 * Resolve the TARGET project for a service write by its `PROD`-style key,
 * scoped to the system principal's (meta) workspace. Thin seam over the
 * existing `projectsService.getByKey`, which already enforces the
 * **404-not-403** no-existence-leak contract: a key that doesn't exist in the
 * principal's workspace — or that exists only in some OTHER workspace — throws
 * the same `ProjectNotFoundError` (→ 404), never a 403 that would confirm a
 * cross-tenant key. The consuming route maps that error to 404.
 */
export async function resolveServiceProjectByKey(
  projectKey: string,
  ctx: ServiceContext,
): Promise<ProjectDTO> {
  return projectsService.getByKey(projectKey, ctx);
}
