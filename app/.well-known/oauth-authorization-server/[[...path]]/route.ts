import { NextResponse } from 'next/server';
import { oauthProviderAuthServerMetadata } from '@better-auth/oauth-provider';
import { auth } from '@/lib/auth';
import { isAuthorizationServerMetadataPath } from '@/lib/oauth/wellKnownPaths';

// RFC 8414 Authorization Server Metadata for Motir's OAuth server (MOTIR-6982).
//
// Served at BOTH `/.well-known/oauth-authorization-server` and the
// path-inserted form `/.well-known/oauth-authorization-server/api/auth` — the
// latter is where RFC 8414 §3.1 says a client finds the metadata of the issuer
// `<base>/api/auth`, which is the issuer the protected-resource document names
// (`lib/oauth/config.ts` says why). The document itself is the provider's, so it
// can never disagree with the endpoints it describes. CORS comes from `proxy.ts`.

const metadata = oauthProviderAuthServerMetadata(auth);

export async function GET(
  request: Request,
  { params }: { params: Promise<{ path?: string[] }> },
): Promise<Response> {
  const { path } = await params;
  if (!isAuthorizationServerMetadataPath(path)) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  return metadata(request);
}
