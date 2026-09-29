import { NextResponse } from 'next/server';
import { requireCompliantWorkspaceContext } from '@/lib/auth/requireCompliantSession';
import { mapAgentInstanceError } from '@/lib/agentInstances/errorResponse';
import { agentInstanceLifecycleService } from '@/lib/services/agentInstanceLifecycleService';

// `/api/projects/:key/instances` — the caller's OWN agent instances on a project
// (Story MOTIR-6860 · MOTIR-6872, `docs/decisions/agent-instances.md`). HTTP only:
// parse, one service call, map the typed error.

const DEFAULT_TAKE = 25;
const MAX_TAKE = 100;

/** GET — one page of the caller's live instances, with the total. */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ key: string }> },
): Promise<Response> {
  const gate = await requireCompliantWorkspaceContext();
  if (!gate.ok) return gate.response;
  const { key } = await params;
  const url = new URL(req.url);
  const rawTake = Number(url.searchParams.get('limit'));
  const take =
    Number.isInteger(rawTake) && rawTake > 0 ? Math.min(rawTake, MAX_TAKE) : DEFAULT_TAKE;
  const rawPage = Number(url.searchParams.get('page'));
  const page = Number.isInteger(rawPage) && rawPage > 0 ? rawPage : 1;
  try {
    const result = await agentInstanceLifecycleService.list(
      key,
      { take, skip: (page - 1) * take },
      gate.ctx,
    );
    return NextResponse.json({ ...result, page, pageSize: take });
  } catch (err) {
    const mapped = mapAgentInstanceError(err);
    if (mapped) return mapped;
    throw err;
  }
}

/** POST `{ name, profileId }` — create an instance. */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ key: string }> },
): Promise<Response> {
  const gate = await requireCompliantWorkspaceContext();
  if (!gate.ok) return gate.response;
  const { key } = await params;
  const body = (await req.json().catch(() => null)) as {
    name?: unknown;
    profileId?: unknown;
  } | null;
  if (!body || typeof body.name !== 'string' || typeof body.profileId !== 'string') {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: 'Send a `name` and a `profileId`.' },
      { status: 400 },
    );
  }
  try {
    const instance = await agentInstanceLifecycleService.create(
      key,
      { name: body.name, profileId: body.profileId },
      gate.ctx,
    );
    return NextResponse.json({ instance }, { status: 201 });
  } catch (err) {
    const mapped = mapAgentInstanceError(err);
    if (mapped) return mapped;
    throw err;
  }
}
