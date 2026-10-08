import { NextResponse } from 'next/server';
import { PUBLIC_IDEAS_CACHE_CONTROL } from '@/lib/ideas/publicCache';
import { publicSurfaceUnavailable } from '@/lib/publicProjects/cloudGate';
import { ideasPublicService } from '@/lib/services/ideasPublicService';

// GET /api/public/ideas/tags (Story MOTIR-7662 · MOTIR-7676) — every tag carried
// by at least one ACTIVE idea, with that count: the facet behind motir.co's tag
// filter. Anonymous (no session call), cacheable, pure transport.

export async function GET(): Promise<NextResponse> {
  const absent = publicSurfaceUnavailable();
  if (absent) return absent;

  const tags = await ideasPublicService.listTags();
  return NextResponse.json({ tags }, { headers: { 'Cache-Control': PUBLIC_IDEAS_CACHE_CONTROL } });
}
