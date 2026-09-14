import { NextResponse } from 'next/server';
import { withV1Route } from '@/lib/api/v1/route';
import { resolveWorkItemKey } from '@/lib/api/v1/workItems/resolveKey';
import { presentCurrentTestInstructions } from '@/lib/api/v1/workLoop/schema';
import { testInstructionsService } from '@/lib/services/testInstructionsService';

// GET /api/v1/work-items/{key}/how-to-test (Story MOTIR-4906 · MOTIR-5358) — the
// run target's CURRENT How-to-test record, the one the newest run published, with
// each repository section named `owner/name`. A CLI reads it after its close-out
// step to render the `## How to test` section of each session pull request body,
// so the body and the item page render ONE record and cannot disagree.
//
// A READ. `record: null` when no run has written one — an answer, not a 404.
export const GET = withV1Route<{ key: string }>({ permission: 'project:browse' }, async (ctx) => {
  const { projectId, identifier } = await resolveWorkItemKey(ctx.params.key, ctx.service);
  const dto = await testInstructionsService.getCurrentByIdentifier(
    projectId,
    identifier,
    ctx.service,
  );
  return NextResponse.json(presentCurrentTestInstructions(dto));
});
