import { NextResponse } from 'next/server';
import { withV1Route } from '@/lib/api/v1/route';
import { presentDesignVerdict } from '@/lib/api/v1/workItems/designPresenter';
import { designAccessService } from '@/lib/services/designAccessService';

// GET /api/v1/work-items/{key}/designs (Story MOTIR-5553 · Subtask MOTIR-5560)
// — THE APPROVED DESIGNS A WORK ITEM WAITS ON.
//
// `docs/decisions/design-result.md` AMENDMENT 5 Q4: for each work item this one
// is `blocked_by` whose type is `design`, the version an APPROVAL named, with
// every asset. This is the read the dispatched prompt's DESIGN REFERENCE and the
// CLI's `$MOTIR_DESIGN_DIR` are both built on, which is why it lives on the
// PUBLIC surface rather than only on the MCP one: the CLI speaks `/api/v1` and
// nothing else.
//
// ── `project:browse`, and deliberately nothing new ─────────────────────────
// Reading the design of the work you are about to do is browsing the project.
// The key is one `CLI_TOKEN_GRANT` already carries, so a dispatched agent can
// call this without the grant being widened — which is the property that keeps
// the whole feature inside the credential a sandboxed run already holds.
//
// ── ONE service call, and the links are part of the answer ─────────────────
// The verdict rules are `designAccessService`'s and are not re-derived here (the
// route layer decides nothing). The one thing this layer adds is the LINK: an
// `available` asset of an `approved` verdict gets a short-lived URL, because a
// caller reading a single item's designs is about to fetch them. The project
// LIST deliberately does not — see that route.
export const GET = withV1Route<{ key: string }>({ permission: 'project:browse' }, async (ctx) => {
  const verdicts = await designAccessService.designsForWorkItem(ctx.params.key, ctx.service);
  const designs = await Promise.all(
    verdicts.map((verdict) => presentDesignVerdict(verdict, ctx.service)),
  );
  return NextResponse.json({ designs });
});
