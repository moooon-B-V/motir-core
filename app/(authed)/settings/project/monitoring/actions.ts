'use server';

import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { AUTHED_LANDING_PATH } from '@/lib/navigation/landing';
import { monitorConnectionService } from '@/lib/services/monitorConnectionService';
import { monitorCredentialService } from '@/lib/services/monitorCredentialService';

// The Monitoring room's RE-CHECK (Story MOTIR-4928 · MOTIR-5262).
//
// `monitorCredentialService.probeHealth` shipped with no HTTP door by
// MOTIR-5261's own decision, so the room reaches it through a page-local Server
// Action — the route-layer equivalent CLAUDE.md allows, and the convention
// `settings/project/actions.ts` already follows. Transport only: resolve the
// session and the active project, call the service, return a result.
//
// ⚠️ THE GRANT IS RESOLVED HERE, NEVER TAKEN FROM THE CLIENT. `probeHealth`
// accepts an installation row id, and an action argument is whatever a POST
// says it is — so this reads the project's own view (which asserts
// `integration:manage` and is scoped to the active workspace) and probes THAT
// grant. A crafted call cannot aim the probe at another workspace's credential.
//
// A failed probe is not an error result: it writes a `degraded` verdict, which
// the page renders after `router.refresh()`. `error` is for a probe that could
// not run at all.

export type RecheckMonitorHealthResult = { ok: true } | { ok: false; code: 'no_grant' | 'failed' };

export async function recheckMonitorHealthAction(): Promise<RecheckMonitorHealthResult> {
  const session = await getSession();
  if (!session) redirect('/sign-in');
  const ctx = await getActiveProject();
  if (!ctx) redirect(AUTHED_LANDING_PATH);
  const serviceCtx = { userId: ctx.userId, workspaceId: ctx.workspaceId };

  try {
    const view = await monitorConnectionService.getView(ctx.projectId, serviceCtx);
    if (!view.installationId) return { ok: false, code: 'no_grant' };
    await monitorCredentialService.probeHealth(ctx.projectId, view.installationId, serviceCtx);
    return { ok: true };
  } catch (err) {
    console.error('[monitoring] re-check failed', err);
    return { ok: false, code: 'failed' };
  }
}
