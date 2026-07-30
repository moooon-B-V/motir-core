import type { User, Workspace } from '@prisma/client';
import type { ApiTokenDto } from '@/lib/dto/apiTokens';
import type { DeviceGrantStartDTO, DeviceGrantTokenDTO } from '@/lib/dto/cliDevice';

// Prisma/plugin → DTO conversion for the CLI device-authorization surface (Story
// MOTIR-1863 · Subtask MOTIR-1865). Pure functions; the service calls them just
// before returning (CLAUDE.md 4-layer split).

/** What Better-Auth's `deviceCode` endpoint hands back. Declared structurally
 * rather than imported: it is the plugin's internal response type, and pinning our
 * dependency to the five fields we actually forward means a plugin upgrade that
 * ADDS a field cannot silently change Motir's contract with the CLI. */
export interface IssuedDeviceCode {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

/** The RFC 8628 §3.2 grant response, forwarded field-for-field. */
export function toDeviceGrantStartDTO(issued: IssuedDeviceCode): DeviceGrantStartDTO {
  return {
    device_code: issued.device_code,
    user_code: issued.user_code,
    verification_uri: issued.verification_uri,
    verification_uri_complete: issued.verification_uri_complete,
    expires_in: issued.expires_in,
    interval: issued.interval,
  };
}

/**
 * The successful poll (RFC 8628 §3.4 + Motir's `user` / `workspace` additions).
 *
 * `expires_in` is derived from the minted token's own `expiresAt` rather than from
 * the 90-day constant, so the number the CLI stores can never disagree with the
 * number the DB will enforce.
 */
export function toDeviceGrantTokenDTO(input: {
  token: string;
  dto: ApiTokenDto;
  user: User;
  workspace: Workspace;
}): DeviceGrantTokenDTO {
  const expiresAtMs = input.dto.expiresAt ? new Date(input.dto.expiresAt).getTime() : null;
  return {
    access_token: input.token,
    token_type: 'Bearer',
    scope: input.dto.scopes.join(' '),
    expires_in:
      expiresAtMs === null ? 0 : Math.max(0, Math.floor((expiresAtMs - Date.now()) / 1000)),
    user: { id: input.user.id, name: input.user.name, email: input.user.email },
    workspace: {
      id: input.workspace.id,
      name: input.workspace.name,
      slug: input.workspace.slug,
    },
  };
}
