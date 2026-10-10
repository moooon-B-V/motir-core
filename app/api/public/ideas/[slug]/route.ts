import { NextResponse } from 'next/server';
import { IdeaNotFoundError } from '@/lib/ideas/errors';
import { PUBLIC_IDEAS_CACHE_CONTROL } from '@/lib/ideas/publicCache';
import { resolvePublicIdeaLocale } from '@/lib/ideas/publicLocale';
import { publicSurfaceUnavailable } from '@/lib/publicProjects/cloudGate';
import { ideasPublicService } from '@/lib/services/ideasPublicService';

// GET /api/public/ideas/{slug} (Story MOTIR-7662 · MOTIR-7676) — one ACTIVE idea,
// for motir.co's in-page detail. An unknown slug and a RETIRED one answer the
// same bare 404, so a public reader cannot tell a retired idea ever existed.
// Anonymous (no session call), cacheable, pure transport. `?locale=` from the
// query only (MOTIR-7775); an unsupported value is answered in English.

export async function GET(
  req: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  const absent = publicSurfaceUnavailable();
  if (absent) return absent;

  const { slug } = await params;
  try {
    const locale = resolvePublicIdeaLocale(new URL(req.url).searchParams.get('locale'));
    const idea = await ideasPublicService.getBySlug(slug, locale);
    return NextResponse.json(idea, { headers: { 'Cache-Control': PUBLIC_IDEAS_CACHE_CONTROL } });
  } catch (err) {
    if (err instanceof IdeaNotFoundError) {
      return NextResponse.json({ code: err.code }, { status: 404 });
    }
    throw err;
  }
}
