import type {
  AddProjectRepoInput,
  PatchProjectRepoInput,
  ProjectRepoDto,
  ProjectRepoEstablishViewDto,
} from '@/lib/dto/projectRepos';
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

/** Append a row — "the plan needs a part Motir didn't infer". */
export function addRepositoryRow(
  projectKey: string,
  input: AddProjectRepoInput,
): Promise<ProjectRepoDto> {
  return send(base(projectKey), { method: 'POST', body: JSON.stringify(input) });
}

/** Rename a row (or change its role / seed source) — persisted, so the edit
 *  survives a refresh mid-flow. */
export function patchRepositoryRow(
  projectKey: string,
  rowId: string,
  input: PatchProjectRepoInput,
): Promise<ProjectRepoDto> {
  return send(`${base(projectKey)}/${encodeURIComponent(rowId)}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

/** Drop a row the derivation invented. Never touches a repository. */
export function removeRepositoryRow(projectKey: string, rowId: string): Promise<void> {
  return send(`${base(projectKey)}/${encodeURIComponent(rowId)}`, { method: 'DELETE' });
}

/** Point a row at a repository the user already has ("Use one of mine"). */
export function connectRepositoryRow(
  projectKey: string,
  rowId: string,
  githubRepoId: string,
): Promise<ProjectRepoDto> {
  return send(`${base(projectKey)}/${encodeURIComponent(rowId)}/state`, {
    method: 'POST',
    body: JSON.stringify({ to: 'connected', githubRepoId }),
  });
}

/** Settle a row deliberately WITHOUT a repository ("Skip this one"). */
export function skipRepositoryRow(projectKey: string, rowId: string): Promise<ProjectRepoDto> {
  return send(`${base(projectKey)}/${encodeURIComponent(rowId)}/state`, {
    method: 'POST',
    body: JSON.stringify({ to: 'skipped' }),
  });
}

/** Put a settled-but-empty-handed row back in play — "Create it after all" on a
 *  skipped row, "Let Motir host it" on a connected one. Returns the FRESH row
 *  (a new id: the old decision is over). */
export function replanRepositoryRow(projectKey: string, rowId: string): Promise<ProjectRepoDto> {
  return send(`${base(projectKey)}/${encodeURIComponent(rowId)}/state`, {
    method: 'POST',
    body: JSON.stringify({ to: 'proposed' }),
  });
}

/** Move a row one place up or down — which repository is PRIMARY is a decision. */
export function moveRepositoryRow(
  projectKey: string,
  rowId: string,
  direction: 'up' | 'down',
): Promise<ProjectRepoDto> {
  return send(`${base(projectKey)}/${encodeURIComponent(rowId)}/move`, {
    method: 'POST',
    body: JSON.stringify({ direction }),
  });
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
