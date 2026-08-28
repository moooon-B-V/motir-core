import { NextResponse } from 'next/server';
import { githubPullRequestService } from '@/lib/services/githubPullRequestService';
import { workItemsService } from '@/lib/services/workItemsService';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import { GithubRepoNotFoundError } from '@/lib/github/errors';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { notFound, productionGate, requireContext } from '../_helpers';

// `_test` transport over the EXPLICIT delivery link (Story MOTIR-3655 ·
// MOTIR-3662). See ../_helpers.ts for the WHY + the three invariants.
//
//   POST body={ workItemId, owner, name, number, headRef, baseRef }
//        → 201 + { link, created }
//
// ── Why this door exists ───────────────────────────────────────────────────
// The E2E lane can already open and merge pull requests through the REAL signed
// webhook (`_helpers/github-seed.ts`), but a delivery LINK is not something a
// webhook makes: since MOTIR-3672 a pull request belongs to a card only by an
// explicit declaration, and the only production doors for it are the MCP tool
// `link_pull_request` and the item page's link picker. A browser spec that drove
// the picker would be testing the picker; a spec that wrote the row directly
// would be asserting a shape rather than a behaviour.
//
// So this is the same transport the sibling `work-item-links` route is: the
// SHIPPED service method, reached over HTTP, gated to non-production, with the
// caller's real session context. `linkPullRequestByCoordinates` runs in full —
// its `work_item:edit` permission assertion, its tenancy checks, and the write of
// the delivery row that IS the link.
//
// ⚠️ It is NOT a shortcut past the link's rules. A card in another workspace,
// or a repository this workspace has not connected, is refused here exactly as
// it is refused at the MCP tool — which is what makes a spec written against it
// evidence about the product.

interface LinkBody {
  workItemId: string;
  owner: string;
  name: string;
  number: number;
  headRef: string;
  baseRef: string;
  title?: string | null;
}

export async function POST(req: Request): Promise<Response> {
  const gated = productionGate();
  if (gated) return gated;
  const auth = await requireContext();
  if (auth.response) return auth.response;
  const ctx: ServiceContext = auth.ctx;

  const body = (await req.json()) as LinkBody;
  try {
    // Tenancy guard on the CARD, before anything else — the same shape the
    // sibling route uses, and the reason a cross-workspace id 404s rather than
    // reaching a service that would tell it apart from a missing one.
    const item = await workItemsService.getWorkItem(body.workItemId, ctx);
    const result = await githubPullRequestService.linkPullRequestByCoordinates(
      {
        workItemId: body.workItemId,
        projectId: item.projectId,
        owner: body.owner,
        name: body.name,
        number: body.number,
        headRef: body.headRef,
        baseRef: body.baseRef,
        title: body.title ?? null,
      },
      ctx,
    );
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    if (err instanceof WorkItemNotFoundError || err instanceof GithubRepoNotFoundError) {
      return notFound();
    }
    throw err;
  }
}
