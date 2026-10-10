import { NextResponse } from 'next/server';
import type { PublicIdeaTagListDto } from '@/lib/dto/ideas';
import { PUBLIC_IDEAS_CACHE_CONTROL } from '@/lib/ideas/publicCache';
import { resolvePublicIdeaLocale } from '@/lib/ideas/publicLocale';
import { publicSurfaceUnavailable } from '@/lib/publicProjects/cloudGate';
import { ideasPublicService } from '@/lib/services/ideasPublicService';

// GET /api/public/ideas/tags (Story MOTIR-7662 · MOTIR-7676) — every tag carried
// by at least one ACTIVE idea, with that count: the facet behind motir.co's tag
// filter. Anonymous (no session call), cacheable, pure transport. `?locale=`
// from the query only (MOTIR-7775); an unsupported value is answered in English.

export async function GET(req: Request): Promise<NextResponse> {
  const absent = publicSurfaceUnavailable();
  if (absent) return absent;

  const locale = resolvePublicIdeaLocale(new URL(req.url).searchParams.get('locale'));
  const tags = await ideasPublicService.listTags(locale);
  const body: PublicIdeaTagListDto = { tags, locale };
  return NextResponse.json(body, { headers: { 'Cache-Control': PUBLIC_IDEAS_CACHE_CONTROL } });
}
