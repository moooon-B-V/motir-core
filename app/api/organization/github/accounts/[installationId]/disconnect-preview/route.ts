import { NextResponse } from 'next/server';
import { requireCompliantWorkspaceContext } from '@/lib/auth/requireCompliantSession';
import { mapOrgError } from '@/lib/organizations/errorResponse';
import { InstallationNotLinkedError } from '@/lib/github/errors';
import { githubAccountDisconnectService } from '@/lib/services/githubAccountDisconnectService';

// WHAT DISCONNECTING FROM ONE GITHUB ACCOUNT WILL DO (Story MOTIR-8216 ·
// MOTIR-8222) — the confirmation dialog's facts: the account, this
// organisation's repositories on it, the live projects that use them, and the
// code-graph retention window. Names no other organisation.
//
//   GET → 200 { accountLogin, accountType, repos, projects, retentionWindowDays }
//         403 not an org admin · 404 installation_not_linked

type Params = { params: Promise<{ installationId: string }> };

export async function GET(_req: Request, { params }: Params): Promise<Response> {
  const gate = await requireCompliantWorkspaceContext();
  if (!gate.ok) return gate.response;
  const { installationId } = await params;
  try {
    return NextResponse.json(
      await githubAccountDisconnectService.previewAccountDisconnect({
        ...gate.ctx,
        installationId,
      }),
    );
  } catch (err) {
    if (err instanceof InstallationNotLinkedError) {
      return NextResponse.json(
        { code: 'installation_not_linked', error: err.message },
        { status: 404 },
      );
    }
    const mapped = mapOrgError(err);
    if (mapped) return mapped;
    throw err;
  }
}
