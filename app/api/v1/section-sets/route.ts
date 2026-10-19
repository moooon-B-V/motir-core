import { NextResponse } from 'next/server';
import { presentSectionSets } from '@/lib/api/v1/sectionSets/schema';
import { withV1Route } from '@/lib/api/v1/route';
import { sectionSchemaService } from '@/lib/services/sectionSchemaService';

// GET /api/v1/section-sets (Story MOTIR-9023 · MOTIR-9029) — the section registry
// as a published read: which sections a work item of a kind × type has, which are
// required and the heading each renders under in `descriptionMd`. Not under
// `/work-items/{key}`: the sets are the same for every tenant and belong to no
// item. ONE service call, shared with the MCP tool and motir-ai's internal route.
// An unknown `kind` / `type` is a 422 `UNKNOWN_SECTION_CELL` (the wrapper maps the
// service's typed error by code), never a default set.
export const GET = withV1Route({ permission: 'project:browse' }, async (ctx) => {
  const params = new URL(ctx.req.url).searchParams;
  const descriptor = sectionSchemaService.describe({
    kind: params.get('kind'),
    type: params.get('type'),
  });
  return NextResponse.json(presentSectionSets(descriptor));
});
