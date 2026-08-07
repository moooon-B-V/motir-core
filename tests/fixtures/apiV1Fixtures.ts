import type { User, Workspace } from '@/lib/generated/prisma/client';
import { apiTokensService } from '@/lib/services/apiTokensService';
import type { TokenScope } from '@/lib/mcp/scopes';
import { createTestWorkspace } from './workspaceFixtures';
import { makeWorkItemFixture, type WorkItemFixture } from './workItemFixtures';

// Shared fixtures for the `/api/v1` suites (Story 11.1 · Subtask 11.1.2 —
// MOTIR-1858), reused by the pagination, rate-limit, story-gate and
// conformance suites.
//
// A "caller" is what an external client actually holds: a REAL PAT minted
// through the shipped service (so it is hashed, scoped and workspace-bound
// exactly as production mints it) plus the workspace it is bound to. No test
// ever hand-builds a token row — the point of these suites is that the shipped
// credential path works.

export interface V1Caller {
  user: User;
  workspace: Workspace;
  /** The plaintext secret — returned ONCE by the service, as in production. */
  token: string;
  /** The token row's id, for `apiTokensService.revoke`. */
  tokenId: string;
  /** `Authorization: Bearer …` ready to spread into a fetch/Request init. */
  headers: Record<string, string>;
}

/**
 * A fresh user + workspace + a PAT bound to that workspace with `scopes`.
 * Defaults to a read-only token, the narrowest credential v1's GETs need.
 */
export async function createV1Caller(
  opts: { scopes?: TokenScope[]; label?: string; workspaceName?: string } = {},
): Promise<V1Caller> {
  const { workspace, owner } = await createTestWorkspace(
    opts.workspaceName ? { name: opts.workspaceName } : {},
  );
  return withTokenFor(owner, workspace, opts);
}

/**
 * A SECOND token for an existing user + workspace — the fixture the
 * per-token rate-limit assertion needs (same owner, same workspace,
 * independent budgets).
 */
export async function withTokenFor(
  user: User,
  workspace: Workspace,
  opts: { scopes?: TokenScope[]; label?: string } = {},
): Promise<V1Caller> {
  const { token, dto } = await apiTokensService.create(user.id, workspace.id, {
    label: opts.label ?? 'v1 test token',
    scopes: opts.scopes ?? ['read'],
  });
  return { user, workspace, token, tokenId: dto.id, headers: bearer(token) };
}

/** The `Authorization` header for a plaintext PAT. */
export function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

/** A caller whose token is bound to a workspace that CONTAINS a project. */
export interface V1ProjectCaller extends V1Caller {
  fixture: WorkItemFixture;
  /** The project key every resource path is scoped by (`PROD`). */
  projectKey: string;
  /** The owner's `ServiceContext`, for seeding rows through the real services. */
  ctx: WorkItemFixture['ctx'];
}

/**
 * The substrate every Story 11.2 suite starts from (MOTIR-2040): a user +
 * workspace + project, plus a REAL PAT bound to THAT workspace.
 *
 * `createV1Caller` alone is not enough for a resource endpoint — it mints a
 * token against a workspace with nothing in it, so every read would answer 404
 * for the honest reason and prove nothing. Building the two separately is worse:
 * a token bound to workspace A reading a project in workspace B is the
 * cross-tenant case, not the happy path, and getting that wrong silently turns a
 * whole suite green against 404s.
 */
export async function createV1ProjectCaller(
  opts: {
    scopes?: TokenScope[];
    /** Workspace name — pass a second one to build an independent tenant. */
    workspaceName?: string;
    /** Project key prefix (default `PROD` → items read as `PROD-1`). */
    identifier?: string;
  } = {},
): Promise<V1ProjectCaller> {
  const fixture = await makeWorkItemFixture({
    ...(opts.workspaceName ? { name: opts.workspaceName } : {}),
    ...(opts.identifier ? { identifier: opts.identifier } : {}),
  });
  const caller = await withTokenFor(fixture.owner, fixture.workspace, {
    ...(opts.scopes ? { scopes: opts.scopes } : {}),
  });
  return {
    ...caller,
    fixture,
    projectKey: fixture.projectIdentifier,
    ctx: fixture.ctx,
  };
}
