import type { OAuthConnectionDto } from '@/lib/dto/oauthConnections';

// Thin fetch layer over the Connected apps routes (Story MOTIR-6973 · Subtask
// MOTIR-6986) for the section's client island. The island owns its list and
// splices a revoked row out itself (the page-state-after-mutation contract), so
// the only read here is the list the section loads on mount and on Try again.

export type { OAuthConnectionDto };

const BASE = '/api/account/oauth-connections';

export class ConnectedAppsError extends Error {
  constructor(readonly status: number) {
    super(`connected apps request failed (${status})`);
    this.name = 'ConnectedAppsError';
  }
}

/** The signed-in person's connections, newest first. */
export async function listConnections(): Promise<OAuthConnectionDto[]> {
  const res = await fetch(BASE, { cache: 'no-store' });
  if (!res.ok) throw new ConnectedAppsError(res.status);
  const body = (await res.json()) as { connections: OAuthConnectionDto[] };
  return body.connections;
}

/**
 * Revoke one connection. A `404` is SUCCESS here: the connection is already gone
 * (revoked from another tab, or the membership was removed), and the person's
 * intent — that app cannot act — holds either way (design Panel 8).
 */
export async function revokeConnection(id: string): Promise<void> {
  const res = await fetch(`${BASE}/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (res.ok || res.status === 404) return;
  throw new ConnectedAppsError(res.status);
}
