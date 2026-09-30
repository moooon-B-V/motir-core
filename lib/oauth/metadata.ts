import { authorizationServerIssuer, mcpResourceUrl, OAUTH_SCOPES } from './config';

// The OAuth 2.0 Protected Resource Metadata document (RFC 9728) for Motir's MCP
// (MOTIR-6982). An MCP client that gets a 401 from `/api/mcp` reads this to learn
// which authorization server to talk to (MCP authorization spec, 2025-06-18).

export interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers: string[];
  scopes_supported: string[];
  bearer_methods_supported: string[];
  resource_name: string;
}

export function protectedResourceMetadata(): ProtectedResourceMetadata {
  return {
    resource: mcpResourceUrl(),
    authorization_servers: [authorizationServerIssuer()],
    scopes_supported: [...OAUTH_SCOPES],
    bearer_methods_supported: ['header'],
    resource_name: 'Motir',
  };
}
