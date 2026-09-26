import { NextResponse } from 'next/server';
import { requireCompliantSession } from '@/lib/auth/requireCompliantSession';
import { githubAgentAuthService } from '@/lib/services/githubAgentAuthService';
import { GithubAgentAppNotConfiguredError } from '@/lib/github/errors';

// POST /api/github/agent/unlink (Story MOTIR-683 · MOTIR-6519) — remove the
// signed-in member's Motir Agent link and revoke its token at GitHub. The member
// acts on their OWN link only (RLS narrows the row to them), so the session is
// the whole gate. Idempotent: `{ unlinked: false }` when there was nothing to
// remove.

export async function POST(): Promise<Response> {
  const gate = await requireCompliantSession();
  if (!gate.ok) return gate.response;
  try {
    const result = await githubAgentAuthService.unlink(gate.session.user.id);
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof GithubAgentAppNotConfiguredError) {
      return NextResponse.json({ code: err.code }, { status: 503 });
    }
    throw err;
  }
}
