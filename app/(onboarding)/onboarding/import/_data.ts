import 'server-only';
import type { ImportSource } from '@prisma/client';
import { getWorkspaceContext } from '@/lib/workspaces';
import { projectsService } from '@/lib/services/projectsService';
import { workflowsService } from '@/lib/services/workflowsService';
import { importService } from '@/lib/services/importService';
import { importSourceIdentityService } from '@/lib/services/importSourceIdentityService';
import { githubIdentityService } from '@/lib/services/githubIdentityService';
import type { ImportDto } from '@/lib/dto/import';

// Server-side data for the import wizard (Story 7.16 · MOTIR-942). Read via the
// service layer only (4-layer): the page is a Server Component, so it never
// touches Prisma directly. Aggregates the four things the wizard needs BEFORE it
// hands off to the client interactions: which sources the acting member has
// connected, the destination project + its workflow statuses (the status-mapping
// targets), and any in-flight Import to resume.

/** The live (credentialed) sources — CSV is credential-free, so it is never in
 *  the connected map. */
export const LIVE_SOURCES = ['jira', 'linear', 'github', 'plane'] as const;
export type LiveSource = (typeof LIVE_SOURCES)[number];

/** Token-free connection presence for one live source, for the Connect step. */
export interface SourceConnection {
  connected: boolean;
  /** Jira site / Plane base URL, surfaced so the user sees WHICH instance. */
  siteUrl?: string;
  baseUrl?: string;
  workspaceSlug?: string;
}

export interface StatusOption {
  key: string;
  label: string;
  category: string;
}

export interface ImportWizardData {
  userId: string;
  workspaceId: string;
  project: { id: string; name: string };
  statuses: StatusOption[];
  connected: Record<LiveSource, SourceConnection>;
  existingImport: ImportDto | null;
}

/** The project-picker fallback payload (no project resolved yet). */
export interface ImportWizardProjectChoice {
  projects: { id: string; name: string }[];
}

export type LoadResult =
  | { kind: 'wizard'; data: ImportWizardData }
  | { kind: 'chooseProject'; data: ImportWizardProjectChoice }
  | { kind: 'unauthenticated' };

/**
 * Resolve the wizard's server data. Project resolution order: an explicit
 * `?projectId=` (validated), else the active project. With no project at all,
 * return the project-choice fallback so the page can render a picker rather than
 * dead-end.
 */
export async function loadImportWizard(opts: {
  projectId?: string;
  importId?: string;
}): Promise<LoadResult> {
  const ctx = await getWorkspaceContext();
  if (!ctx) return { kind: 'unauthenticated' };

  const projects = await projectsService.listProjects(ctx.workspaceId, ctx.userId);
  const requested = opts.projectId ? projects.find((p) => p.id === opts.projectId) : undefined;
  const active = requested ?? projects.find(() => true);

  if (!active) {
    return { kind: 'chooseProject', data: { projects: [] } };
  }
  // If a projectId was requested but not found (foreign / bad id), fall back to
  // the picker rather than silently importing into the wrong project.
  if (opts.projectId && !requested) {
    return {
      kind: 'chooseProject',
      data: { projects: projects.map((p) => ({ id: p.id, name: p.name })) },
    };
  }

  const [statuses, jira, linear, github, plane, existingImport] = await Promise.all([
    workflowsService.listStatusesByProject(active.id, ctx.workspaceId),
    identity(ctx.userId, ctx.workspaceId, 'jira'),
    identity(ctx.userId, ctx.workspaceId, 'linear'),
    githubConnection(ctx.userId),
    identity(ctx.userId, ctx.workspaceId, 'plane'),
    opts.importId
      ? importService.getImport(opts.importId, ctx).catch(() => null)
      : Promise.resolve(null),
  ]);

  return {
    kind: 'wizard',
    data: {
      userId: ctx.userId,
      workspaceId: ctx.workspaceId,
      project: { id: active.id, name: active.name },
      statuses: statuses.map((s) => ({ key: s.key, label: s.label, category: s.category })),
      connected: { jira, linear, github, plane },
      existingImport,
    },
  };
}

async function identity(
  userId: string,
  workspaceId: string,
  source: Extract<ImportSource, 'jira' | 'linear' | 'plane'>,
): Promise<SourceConnection> {
  const dto = await importSourceIdentityService.getIdentity({ userId, workspaceId, source });
  if (!dto) return { connected: false };
  return {
    connected: true,
    siteUrl: dto.metadata?.siteUrl,
    baseUrl: dto.metadata?.baseUrl,
    workspaceSlug: dto.metadata?.workspaceSlug,
  };
}

/** GitHub reuses the existing 7.10 per-user connection (`GithubIdentity`), not
 *  an import-specific identity — the design's "reuses your existing GitHub
 *  connection". */
async function githubConnection(userId: string): Promise<SourceConnection> {
  const dto = await githubIdentityService.getIdentityForUser(userId);
  return { connected: Boolean(dto) };
}
