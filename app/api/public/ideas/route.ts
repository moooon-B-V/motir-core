import { NextResponse } from 'next/server';
import { InvalidIdeaFilterError } from '@/lib/ideas/errors';
import { PUBLIC_IDEAS_CACHE_CONTROL } from '@/lib/ideas/publicCache';
import { publicSurfaceUnavailable } from '@/lib/publicProjects/cloudGate';
import { ideasPublicService } from '@/lib/services/ideasPublicService';

// GET /api/public/ideas (Story MOTIR-7662 · MOTIR-7676) — the idea store's
// active ideas, narrowed by `?category=`, repeated `?tag=` (all must match),
// `?q=` and `?kind=`, with per-category counts. What motir.co's server reads.
//
// NOT session-gated, like `/api/public/explore`: an anonymous visitor and a
// crawler are served, so there is deliberately no session call. The
// `status = 'active'` filter lives in the repository, so a retired idea cannot
// reach this handler. Pure transport: capability gate, one service call, map
// errors. Cacheable for about an hour at the CDN, matching motir.co's hourly
// revalidate.

export async function GET(req: Request): Promise<NextResponse> {
  const absent = publicSurfaceUnavailable();
  if (absent) return absent;

  const params = new URL(req.url).searchParams;
  try {
    const list = await ideasPublicService.listActive({
      category: params.get('category') ?? undefined,
      tags: params.getAll('tag'),
      q: params.get('q') ?? undefined,
      kind: params.get('kind') ?? undefined,
    });
    return NextResponse.json(list, { headers: { 'Cache-Control': PUBLIC_IDEAS_CACHE_CONTROL } });
  } catch (err) {
    if (err instanceof InvalidIdeaFilterError) {
      return NextResponse.json({ code: err.code }, { status: 400 });
    }
    // Anything else — including `IdeaListCapExceededError`, the loud failure the
    // read service throws the day the store outgrows an unpaginated read — is a
    // 500, never a truncated list.
    throw err;
  }
}
