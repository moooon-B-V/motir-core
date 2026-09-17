import { NextResponse } from 'next/server';
import { withV1Route } from '@/lib/api/v1/route';
import { presentDesignVerdict } from '@/lib/api/v1/workItems/designPresenter';
import { designAccessService } from '@/lib/services/designAccessService';

// GET /api/v1/work-items/{key}/design (Story MOTIR-5553 · Subtask MOTIR-5560) —
// ONE DESIGN CARD'S approved design.
//
// The singular sibling of `…/designs`, addressed by the DESIGN card's own key.
// Two callers want it: an agent following a design a `…/designs` verdict named,
// and an agent finding a delta mock's amended BASE by its `sourcePath` through
// the project list and then reading that one design for its links
// (AMENDMENT 5 Q6).
//
// The same verdict rules, the same link terms, and the same 404-not-403 answer
// for a card the caller cannot see — all of them `designAccessService`'s, none
// of them re-stated here.
export const GET = withV1Route<{ key: string }>({ permission: 'project:browse' }, async (ctx) => {
  const verdict = await designAccessService.getApprovedDesign(ctx.params.key, ctx.service);
  return NextResponse.json(await presentDesignVerdict(verdict, ctx.service));
});
