import { NextResponse } from 'next/server';
import { getWorkspaceContext } from '@/lib/workspaces';
import { projectsService } from '@/lib/services/projectsService';
import { projectRepoProvisioningService } from '@/lib/services/projectRepoProvisioningService';
import { mapProjectRepoError } from '@/lib/projectRepos/errorResponse';

// ESTABLISH the project's repository set (Story MOTIR-1775 · MOTIR-1782) — the
// endpoint behind **Continue** on the default path, **Set up N repositories** on
// the technical one, **Try again**, and a single row's **Retry**.
//
// POST { rowId? } → 200 EstablishSetResult
//
// ⚠️ THE RESPONSE IS NOT HOW THE UI LEARNS WHAT HAPPENED. The primitive persists
// each row's outcome AS IT RESOLVES (never one transaction across the set), so the
// step renders per-row progress by POLLING `GET ../repositories` and reads this
// response only as the run's final settle. That is deliberate and is what makes
// the spike's unverified-latency answer (§4.2: a `201` is not a ready repository,
// and how long seeding takes is unmeasured) harmless in both directions — the user
// sees a row go `creating → created` when it does, and a request that outlives the
// platform's limit costs nothing, because the run is RESUMABLE: only `proposed`
// and `failed` rows are attempted, so re-POSTing completes exactly what is left
// and never creates a second repository.
//
// `rowId` narrows the run to ONE row — the per-row **Retry**, which must not
// silently re-attempt a sibling the user has not asked about again (rows are
// independent, ADR §4.2). Omit it for the whole set.

export async function POST(
  req: Request,
  { params }: { params: Promise<{ key: string }> },
): Promise<Response> {
  const ctx = await getWorkspaceContext();
  if (!ctx) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  const { key } = await params;
  const body = (await req.json().catch(() => null)) as { rowId?: unknown } | null;
  const rowId = typeof body?.rowId === 'string' && body.rowId.length > 0 ? body.rowId : undefined;

  try {
    const project = await projectsService.getByKey(key, ctx);
    const result = await projectRepoProvisioningService.establishSet(
      project.id,
      ctx,
      rowId !== undefined ? { rowId } : {},
    );
    return NextResponse.json(result);
  } catch (err) {
    const mapped = mapProjectRepoError(err);
    if (mapped) return mapped;
    throw err;
  }
}
