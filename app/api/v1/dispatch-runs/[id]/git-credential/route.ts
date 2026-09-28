import { NextResponse } from 'next/server';
import { withV1Route } from '@/lib/api/v1/route';
import { hostedRunGitCredentialService } from '@/lib/services/hostedRunGitCredentialService';

// POST /api/v1/dispatch-runs/{id}/git-credential (MOTIR-6538,
// `docs/decisions/hosted-run-runs-the-cli-as-the-app.md` §5) — a running hosted
// run's git credentials, one entry per repository of the run, minted fresh as
// Motir's GitHub App. The CLI's credential helper calls it for the clone, every
// push and every pull request; GitHub's one-hour token life is why it is asked
// again rather than held.
//
// ⚠️ `acceptsRunToken` — and ONLY a run token. The service refuses any caller
// that is not the run's own credential (`DISPATCH_RUN_TOKEN_OUT_OF_SCOPE`, 403),
// a person's PAT included, before it reads the run. A run outside the caller's
// workspace is 404; a run that has ended is 409; a repository the App can no
// longer write is 409 `hosted_repository_not_writable`; GitHub or an App
// unavailable is 503.
export const POST = withV1Route<{ id: string }>(
  { permission: 'work_item:edit', acceptsRunToken: true },
  async (ctx) => {
    const result = await hostedRunGitCredentialService.issue(ctx.params.id, ctx.service);
    return NextResponse.json(result);
  },
);
