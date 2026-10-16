'use client';

import { useCallback, useRef, useState } from 'react';

// THE LINK WRITE of the connect step (Story MOTIR-8245 · MOTIR-8764): MOTIR-8220's
// `POST /api/organizations/{orgId}/github/installations` with
// `{ installationId, repoIds }`, answered as one closed union.
//
// ⚠️ THE ONLY PLACE THAT KNOWS THIS WIRE SHAPE (`lib/github/linkErrorResponse.ts`
// and `lib/organizations/errorResponse.ts` are its producers):
//   409 `repository_owned_by_other_organization` + `repos[{ repoId, fullName }]`
//   403 `installation_not_accessible`   — the account, not the person
//   403 `ORG_FORBIDDEN`                 — not an organisation admin
//   422 `repo_selection_required` · `repository_not_visible`
//   400 `BAD_REQUEST`                   — an empty selection reached the route
// The two 403s are told apart by the body code, never by the status. Anything
// else — a network error, a 5xx, a code nobody mapped — is `failed`, never a
// success.

export type LinkResult =
  | { kind: 'linked' }
  | { kind: 'taken'; repos: { repoId: string; fullName: string }[] }
  | { kind: 'not_accessible' }
  | { kind: 'not_admin' }
  | { kind: 'selection_required' }
  | { kind: 'not_visible' }
  | { kind: 'failed' };

async function readJson(res: Response): Promise<Record<string, unknown>> {
  try {
    return ((await res.json()) ?? {}) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** One response of the link route as the step's closed union. */
export async function linkResultFrom(res: Response): Promise<LinkResult> {
  if (res.ok) return { kind: 'linked' };
  const body = await readJson(res);
  const code = typeof body.code === 'string' ? body.code : '';
  if (res.status === 409 && code === 'repository_owned_by_other_organization') {
    const repos = Array.isArray(body.repos)
      ? (body.repos as { repoId?: unknown; fullName?: unknown }[])
          .filter((r) => typeof r.repoId === 'string' && typeof r.fullName === 'string')
          .map((r) => ({ repoId: r.repoId as string, fullName: r.fullName as string }))
      : [];
    return { kind: 'taken', repos };
  }
  if (res.status === 403) {
    if (code === 'installation_not_accessible') return { kind: 'not_accessible' };
    if (code === 'ORG_FORBIDDEN') return { kind: 'not_admin' };
    return { kind: 'failed' };
  }
  if (code === 'repo_selection_required' || code === 'BAD_REQUEST') {
    return { kind: 'selection_required' };
  }
  if (code === 'repository_not_visible') return { kind: 'not_visible' };
  return { kind: 'failed' };
}

export function useLinkInstallation(organizationId: string | null): {
  link: (input: { installationId: string; repoIds: string[] }) => Promise<LinkResult | null>;
  pending: boolean;
} {
  const [pending, setPending] = useState(false);
  // A second press while one is out must not post twice.
  const inFlight = useRef(false);

  const link = useCallback(
    async (input: { installationId: string; repoIds: string[] }) => {
      if (!organizationId || inFlight.current) return null;
      inFlight.current = true;
      setPending(true);
      try {
        const res = await fetch(
          `/api/organizations/${encodeURIComponent(organizationId)}/github/installations`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ installationId: input.installationId, repoIds: input.repoIds }),
          },
        );
        return await linkResultFrom(res);
      } catch {
        return { kind: 'failed' } as const;
      } finally {
        inFlight.current = false;
        setPending(false);
      }
    },
    [organizationId],
  );

  return { link, pending };
}
