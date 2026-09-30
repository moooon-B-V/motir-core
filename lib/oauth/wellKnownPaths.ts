import { AUTH_BASE_PATH, MCP_RESOURCE_PATH } from './config';

// Which suffixes the two `.well-known` catch-alls answer (MOTIR-6982). Each
// serves its bare form and exactly one path-inserted form; anything else is a
// 404, so a typo is not answered with a document about some other resource.

function segmentsOf(path: string): string[] {
  return path.split('/').filter(Boolean);
}

function isBareOr(path: string[] | undefined, suffix: string): boolean {
  if (!path || path.length === 0) return true;
  const want = segmentsOf(suffix);
  return path.length === want.length && path.every((segment, i) => segment === want[i]);
}

/** `/.well-known/oauth-protected-resource[/api/mcp]` */
export function isProtectedResourceMetadataPath(path: string[] | undefined): boolean {
  return isBareOr(path, MCP_RESOURCE_PATH);
}

/** `/.well-known/oauth-authorization-server[/api/auth]` */
export function isAuthorizationServerMetadataPath(path: string[] | undefined): boolean {
  return isBareOr(path, AUTH_BASE_PATH);
}
