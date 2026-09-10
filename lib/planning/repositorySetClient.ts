import type { ProjectRepoDto, ProjectRepoEstablishViewDto } from '@/lib/dto/projectRepos';
import type { EstablishSetResult } from '@/lib/services/projectRepoProvisioningService';

// Client reads/writes of the repository-SET API (Story MOTIR-1775 · MOTIR-1782) —
// the seam the establish step at plan approval goes through, so no client
// component touches the service layer directly (the same shape
// `planReviewClient.ts` gives the plan-detail island).
//
// Every call is project-scoped by KEY, matching the route tree.

export class RepositorySetRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
  ) {
    super(`Repository set request failed (${status})`);
    this.name = 'RepositorySetRequestError';
  }
}

async function readError(res: Response): Promise<string | null> {
  try {
    const body = (await res.json()) as { code?: string };
    return body.code ?? null;
  } catch {
    return null;
  }
}

function base(projectKey: string): string {
  return `/api/projects/${encodeURIComponent(projectKey)}/repositories`;
}

async function send<T>(url: string, init: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...init.headers },
  });
  if (!res.ok) throw new RepositorySetRequestError(res.status, await readError(res));
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

/**
 * The establish step's whole read model. This is also the POLL: each row commits
 * its own outcome as the primitive resolves it, so re-reading this is what makes
 * per-row progress real rather than a spinner that guesses.
 */
export async function fetchRepositorySet(
  projectKey: string,
  signal?: AbortSignal,
): Promise<ProjectRepoEstablishViewDto> {
  const res = await fetch(base(projectKey), { headers: { Accept: 'application/json' }, signal });
  if (!res.ok) throw new RepositorySetRequestError(res.status, await readError(res));
  return (await res.json()) as ProjectRepoEstablishViewDto;
}

/**
 * Establish the set — or, with `rowId`, exactly one row (the per-row Retry).
 *
 * The caller renders progress from the POLL, not from this promise: the run
 * persists per row and is resumable, so a slow or interrupted request costs
 * nothing but a repeat.
 */
export function establishRepositorySet(
  projectKey: string,
  rowId?: string,
): Promise<EstablishSetResult> {
  return send(`${base(projectKey)}/establish`, {
    method: 'POST',
    body: JSON.stringify(rowId ? { rowId } : {}),
  });
}

/**
 * ⚠️ `grantRepositoryAccess` WAS HERE, AND IT WAS DELETED RATHER THAN KEPT
 * (MOTIR-5015 · Story MOTIR-5010).
 *
 * It POSTed `../repositories/access` for the access step's **Connect GitHub** and
 * a row's **Resend invitation**. The invitation is now sent SERVER-SIDE by
 * `projectRepoProvisioningService.establishSet`, in the same run that creates the
 * repositories, so no client asks for it any more — and after MOTIR-5014 removed
 * the technical path, the per-row resend had no surface either.
 *
 * ⚠️ THE ROUTE IS UNTOUCHED and is not dead: `/settings/project/code-access`
 * fetches `../repositories/access` and `../repositories/access/team` DIRECTLY
 * (`CodeAccessSettings.tsx`), which is where resending lives now. What went is
 * this client's way of reaching it, not the capability.
 */

/** Re-read GitHub for the PENDING invitations and settle the accepted ones.
 *  Its own call, never folded into the poll — see the route's header. */
export async function refreshRepositoryAccess(
  projectKey: string,
  signal?: AbortSignal,
): Promise<ProjectRepoDto[]> {
  const res = await fetch(`${base(projectKey)}/access`, {
    headers: { Accept: 'application/json' },
    signal,
  });
  if (!res.ok) throw new RepositorySetRequestError(res.status, await readError(res));
  return (await res.json()) as ProjectRepoDto[];
}
