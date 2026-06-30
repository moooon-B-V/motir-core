import { verifyServiceBearer } from './serviceBearer';
import { MOTIR_SYSTEM_USER_EMAIL } from './systemPrincipal';
import { userRepository } from '@/lib/repositories/userRepository';
import { workspaceMembershipRepository } from '@/lib/repositories/workspaceMembershipRepository';
import { withUserContext } from '@/lib/workspaces/context';
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
 * Resolve the well-known Motir system principal to the context every
 * downstream service expects: its `userId` (the create's reporter) and the
 * `workspaceId` of the META workspace it is a member of.
 *
 * The workspace is read from the principal's OWN membership (the seed enrols it
 * in exactly the meta workspace), NOT from any hardcoded id — so the resolution
 * is environment-independent and unit-testable against a throwaway fixture. The
 * membership read runs inside `withUserContext`: the workspace id isn't known
 * yet (it is what we are resolving), so only the `app.user_id` GUC can be bound,
 * and the membership-scoped RLS policy still gates the read to the principal's
 * own rows under the non-bypass app role.
 *
 * Throws `SystemPrincipalNotProvisionedError` (500) when the user or its
 * membership is absent — a seeding invariant, surfaced loudly.
 */
export async function resolveSystemPrincipal(): Promise<ServiceContext> {
  const user = await userRepository.findByEmail(MOTIR_SYSTEM_USER_EMAIL);
  if (!user) throw new SystemPrincipalNotProvisionedError();
  const membership = await withUserContext(user.id, (tx) =>
    workspaceMembershipRepository.findFirstByUserWithWorkspace(user.id, tx),
  );
  if (!membership) throw new SystemPrincipalNotProvisionedError();
  return { userId: user.id, workspaceId: membership.workspaceId };
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
