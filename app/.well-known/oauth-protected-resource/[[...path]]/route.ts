import { NextResponse } from 'next/server';
import { protectedResourceMetadata } from '@/lib/oauth/metadata';
import { isProtectedResourceMetadataPath } from '@/lib/oauth/wellKnownPaths';

// RFC 9728 Protected Resource Metadata for Motir's MCP (MOTIR-6982).
//
// Served at `/.well-known/oauth-protected-resource` and at the path-suffixed
// form `/.well-known/oauth-protected-resource/api/mcp` (RFC 9728 §3.1), which is
// the one an MCP client derives from the resource URL. No session and no
// database: it is derived from the app's own origin. CORS comes from `proxy.ts`.

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ path?: string[] }> },
): Promise<Response> {
  const { path } = await params;
  if (!isProtectedResourceMetadataPath(path)) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  return NextResponse.json(protectedResourceMetadata(), {
    headers: { 'Cache-Control': 'public, max-age=300' },
  });
}
