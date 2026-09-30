import { createHash, randomBytes } from 'node:crypto';
import { constantTimeEqual, makeSignature } from 'better-auth/crypto';
import type { OauthClient, User } from '@/generated/prisma/client';
import { auth } from '@/lib/auth';
import { withSystemContext, withUserContext } from '@/lib/workspaces/context';
import { apiTokenRepository } from '@/lib/repositories/apiTokenRepository';
import { oauthAccessTokenRepository } from '@/lib/repositories/oauthAccessTokenRepository';
import { oauthClientRepository } from '@/lib/repositories/oauthClientRepository';
import { organizationsService } from '@/lib/services/organizationsService';
import { apiTokensService } from '@/lib/services/apiTokensService';
import { toOAuthConnectionDto } from '@/lib/mappers/oauthConnectionMappers';
import { withConsentConnection } from '@/lib/oauth/consentContext';
import { AUTH_BASE_PATH } from '@/lib/oauth/config';
import { isLoopbackHostname, matchesRegisteredRedirect } from '@/lib/oauth/redirectPolicy';
import { resolveBaseUrlTrimmed } from '@/lib/baseUrl';
import {
  OAuthAccessTokenRejectedError,
  OAuthConnectionNotFoundError,
  OAuthConsentRequestInvalidError,
} from '@/lib/oauth/errors';
import { InvalidTokenGrantError } from '@/lib/apiTokens/errors';
import { WorkspaceNotFoundError } from '@/lib/workspaces/errors';
import {
  DEFAULT_TOKEN_GRANT,
  GRANT_OFFERED_ROOM_VIEW_KEYS_MARKER,
  IRREVERSIBLE_PERMISSIONS,
  expandStoredGrant,
} from '@/lib/tokens/grant';
import type { PermissionKey } from '@/lib/permissions/catalog';
import type {
  ApproveConsentResult,
  ConsentRequestDto,
  DenyConsentResult,
  OAuthConnectionDto,
} from '@/lib/dto/oauthConnections';

// OAuth connections (Story MOTIR-6973 · Subtask MOTIR-6983) — what an app a
// person connected through "Sign in with Motir" may DO.
//
// ⚠️ A CONNECTION IS A TOKEN. The consent decision is recorded as an `api_token`
// row carrying the client it was approved for, and an OAuth access token
// resolves, through the `reference_id` the provider stamps on it, to that row.
// From there the MCP gate yields the SAME `AuthInfo` a PAT does — workspace,
// project-or-none, grant — so every tool, permission gate and rate limiter is the
// one a PAT already goes through. This is a second way to ARRIVE at a token, not
// a second authorizer: two reach models would drift, and the drift would widen
// what an app can reach without anything failing.
//
// The GRANT follows the token's one-arm rule (`docs/decisions/token-permissions.md`
// Amendment 1): with no project the grant is FIXED — `DEFAULT_TOKEN_GRANT`,
// whatever the request asked — and with a project it is CHOSEN from what the
// person can confer there, validated by the same read and refused with the same
// error the create-token path uses.
//
// Scoping contexts, as `apiTokensService`: approve / list / revoke run under the
// person's `withUserContext` (the `api_token` RLS policy admits only the owner);
// `resolveAccessToken` runs under `withSystemContext`, because the gate resolves
// a bearer before any person is known.

/** Same window as a PAT (`apiTokensService`): a chatty client does not write on
 * every call. */
const LAST_USED_THROTTLE_MS = 5 * 60 * 1000;

/** What a connection row's `tokenPrefix` shows. A connection has no secret; the
 * PAT surface never lists it, so this is only ever read in a database. */
const CONNECTION_TOKEN_PREFIX = 'oauth';

/** The label a connection gets when its client registered no name. */
const UNNAMED_CLIENT_LABEL = 'OAuth app';

const MAX_LABEL_LENGTH = 100;

export interface ApproveConsentInput {
  /** The signed-in person approving. */
  userId: string;
  /** The request's headers — the provider reads the person's session from them. */
  headers: Headers;
  /** The consent page's query string exactly as the provider signed it. */
  oauthQuery: string;
  /** The workspace the connection acts in. */
  workspaceId: string;
  /** One project, or null/omitted for every project the person can open. */
  projectId?: string | null;
  /** With a project: the chosen grant, or omitted for that project's default.
   * Without one: IGNORED — the grant is `DEFAULT_TOKEN_GRANT`. */
  permissions?: string[];
}

/** The provider's hash of a stored token (`storeTokens: "hashed"`): SHA-256,
 * base64url without padding. Mirrored here because the lookup is Motir's. */
function providerTokenHash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('base64url');
}

function parseUrl(uri: string): URL | null {
  try {
    return new URL(uri);
  } catch {
    return null;
  }
}

/** Resolve the grant a connection is recorded with — the one-arm rule. */
async function resolveConnectionGrant(input: ApproveConsentInput): Promise<PermissionKey[]> {
  if (!input.projectId) return [...DEFAULT_TOKEN_GRANT];
  // The same read the create-token path validates against, so the consent
  // screen's offer and this check cannot disagree. A project the person cannot
  // browse throws `ProjectNotFoundError` (404) from here.
  const conferrable = await apiTokensService.listGrantablePermissions(
    input.userId,
    input.workspaceId,
    input.projectId,
  );
  if (input.permissions === undefined) {
    return conferrable.filter((key) => !IRREVERSIBLE_PERMISSIONS.includes(key));
  }
  const allowed = new Set<string>(conferrable);
  const invalid = input.permissions.filter((key) => !allowed.has(key));
  if (invalid.length > 0) throw new InvalidTokenGrantError(invalid);
  return [...new Set(input.permissions as PermissionKey[])];
}

/**
 * Check the consent request is one the provider signed and has not expired, and
 * return its parameters. The provider checks the same signature again when it
 * records the consent; checking first means a forged or stale request records
 * no connection at all rather than one that has to be taken back — and it is
 * what lets the consent page trust the app and redirect it DESCRIBES.
 */
async function verifiedConsentQuery(oauthQuery: string): Promise<URLSearchParams> {
  const params = new URLSearchParams(oauthQuery);
  const sig = params.get('sig');
  const exp = Number(params.get('exp'));
  params.delete('sig');
  const { secret } = await auth.$context;
  const expected = await makeSignature(params.toString(), secret);
  if (!sig || !constantTimeEqual(sig, expected)) {
    throw new OAuthConsentRequestInvalidError('it was not issued by Motir', 'not_issued');
  }
  if (!Number.isFinite(exp) || exp * 1000 < Date.now()) {
    throw new OAuthConsentRequestInvalidError('it has expired', 'expired');
  }
  if (!params.get('client_id')) {
    throw new OAuthConsentRequestInvalidError('it names no app', 'invalid_client');
  }
  return params;
}

/** The client a verified request names, refused when unknown or disabled. */
async function consentClient(clientId: string): Promise<OauthClient> {
  const client = await oauthClientRepository.findByClientId(clientId);
  if (!client || client.disabled) {
    throw new OAuthConsentRequestInvalidError('the app is not registered', 'invalid_client');
  }
  return client;
}

/**
 * Answer the provider's consent step and get the client redirect back — with the
 * code on accept, with `error=access_denied` on decline. Sent as a REQUEST
 * through Better-Auth's handler rather than an `auth.api` call: the provider
 * continues into its authorize step, which refuses to run without the
 * originating request. The person's session rides in the forwarded headers; the
 * origin is the app's own, which the handler's CSRF check requires.
 */
async function answerProviderConsent(
  headers: Headers,
  oauthQuery: string,
  accept: boolean,
): Promise<string> {
  const base = resolveBaseUrlTrimmed();
  const forwarded = new Headers(headers);
  forwarded.set('content-type', 'application/json');
  forwarded.set('accept', 'application/json');
  forwarded.set('origin', base);
  const res = await auth.handler(
    new Request(`${base}${AUTH_BASE_PATH}/oauth2/consent`, {
      method: 'POST',
      headers: forwarded,
      body: JSON.stringify({ accept, oauth_query: oauthQuery }),
    }),
  );
  const body = (await res.json().catch(() => null)) as {
    url?: string;
    error?: string;
    error_description?: string;
    message?: string;
  } | null;
  if (!res.ok || !body?.url) {
    throw new OAuthConsentRequestInvalidError(
      body?.error_description ||
        body?.error ||
        body?.message ||
        `the provider answered ${res.status}`,
      'rejected',
    );
  }
  return body.url;
}

export const oauthConnectionsService = {
  /**
   * Describe a pending consent request for the consent screen (MOTIR-6985): the
   * app, where the code will go, and the workspaces the person can connect it to.
   *
   * Everything shown is read from the request the PROVIDER SIGNED and from the
   * client's own registration — never from what the URL claims — so a hand-edited
   * query cannot put another app's name or another redirect on the screen. The
   * workspaces are the create-token picker's (`listScopeOptions`), narrowed to
   * those with a project the person can grant something in: a workspace where
   * nothing can be granted cannot hold a connection that does anything.
   *
   * Refused with `OAuthConsentRequestInvalidError` (its `reason` says which) for
   * a request Motir did not sign, an expired one, an unknown or disabled client,
   * or a redirect the client did not register.
   */
  async describeConsentRequest(userId: string, oauthQuery: string): Promise<ConsentRequestDto> {
    const params = await verifiedConsentQuery(oauthQuery);
    const client = await consentClient(params.get('client_id')!);
    const redirectUri = params.get('redirect_uri') ?? '';
    // The provider matched it before signing; checked again because the screen
    // is about to SAY where the code goes, and must not say it about a redirect
    // the client never registered.
    const redirect = parseUrl(redirectUri);
    if (!redirect || !matchesRegisteredRedirect(client.redirectUris, redirectUri)) {
      throw new OAuthConsentRequestInvalidError(
        'it names a redirect the app did not register',
        'invalid_redirect',
      );
    }
    const orgs = await apiTokensService.listScopeOptions(userId);
    const workspaces: ConsentRequestDto['workspaces'] = [];
    const unusableWorkspaces: string[] = [];
    for (const org of orgs) {
      for (const workspace of org.workspaces) {
        const label = `${org.name} · ${workspace.name}`;
        if (workspace.projects.some((p) => p.grantable.length > 0)) {
          workspaces.push({ id: workspace.id, label, projects: workspace.projects });
        } else {
          unusableWorkspaces.push(label);
        }
      }
    }
    return {
      client: {
        clientId: client.clientId,
        name: client.name?.trim() || null,
        // A client a signed-in person registered was put there by someone this
        // Motir knows; one that registered itself (RFC 7591, unauthenticated —
        // every MCP client) is only its own claim.
        unverified: client.userId === null,
      },
      redirectUri,
      redirectHost: redirect.host,
      loopback: redirect.protocol === 'http:' && isLoopbackHostname(redirect.hostname),
      workspaces,
      unusableWorkspaces,
    };
  },

  /**
   * The name a registered client gave itself, for the sign-in card's "connecting
   * an app" banner (design Panel 5). Null for an unknown or disabled client, or
   * one that registered no name — the card then says "This app". Display only.
   */
  async clientDisplayName(clientId: string): Promise<string | null> {
    const client = await oauthClientRepository.findByClientId(clientId);
    if (!client || client.disabled) return null;
    return client.name?.trim() || null;
  },

  /**
   * Decline a consent request: the client is sent back with
   * `error=access_denied` and its `state`. Writes NOTHING — no connection, no
   * consent row; the provider's decline path stores nothing either. Refuses a
   * request Motir did not sign or that has expired, so a decline can never be
   * turned into a redirect to an address nobody checked.
   */
  async denyConsent(input: { headers: Headers; oauthQuery: string }): Promise<DenyConsentResult> {
    await verifiedConsentQuery(input.oauthQuery);
    const redirectUrl = await answerProviderConsent(input.headers, input.oauthQuery, false);
    return { redirectUrl };
  },

  /**
   * Approve an app's consent request: record the CONNECTION (person, client,
   * workspace, project-or-none, grant), then complete the provider's
   * authorization bound to it. Returns the connection and the client redirect
   * carrying the authorization code.
   *
   * Refuses, before writing anything: a request Motir did not sign or that has
   * expired, or an unknown or disabled client (400); a workspace the person is
   * not in (404, never 403); a project they cannot browse (404); a grant outside
   * what they can confer in that project (the create-token path's 422).
   *
   * Approving the same (person, client, workspace, project) again REPLACES that
   * connection's grant and keeps its id — including when two approvals race: the
   * write is one `INSERT … ON CONFLICT`, so the loser returns the winner's row.
   * When the provider then fails, a connection THIS call created is deleted; one
   * that already existed is left alone.
   */
  async approveConsent(input: ApproveConsentInput): Promise<ApproveConsentResult> {
    const params = await verifiedConsentQuery(input.oauthQuery);
    const client = await consentClient(params.get('client_id')!);
    const access = await organizationsService.resolveWorkspaceAccess(
      input.userId,
      input.workspaceId,
    );
    if (!access) throw new WorkspaceNotFoundError(input.workspaceId);
    const grant = await resolveConnectionGrant(input);

    const label = (client.name?.trim() || UNNAMED_CLIENT_LABEL).slice(0, MAX_LABEL_LENGTH);
    const connection = await withUserContext(input.userId, (tx) =>
      apiTokenRepository.upsertOAuthConnection(
        {
          userId: input.userId,
          workspaceId: input.workspaceId,
          projectId: input.projectId ?? null,
          oauthClientId: client.clientId,
          label,
          // The hash of bytes nobody holds: the column is unique and required,
          // and no presented PAT can ever resolve to a connection.
          tokenHash: createHash('sha256').update(randomBytes(32)).digest('hex'),
          tokenPrefix: CONNECTION_TOKEN_PREFIX,
          // The mint path's marker rides as it does on every token (MOTIR-6329).
          scopes: [...grant, GRANT_OFFERED_ROOM_VIEW_KEYS_MARKER],
        },
        tx,
      ),
    );

    try {
      const redirectUrl = await withConsentConnection(connection.id, () =>
        answerProviderConsent(input.headers, input.oauthQuery, true),
      );
      return { connectionId: connection.id, redirectUrl };
    } catch (err) {
      if (connection.inserted) {
        await withUserContext(input.userId, (tx) =>
          apiTokenRepository.remove(connection.id, tx),
        ).catch(() => undefined);
      }
      throw err;
    }
  },

  /** The person's connected apps, newest first — the Connected apps list. */
  async listForUser(userId: string): Promise<OAuthConnectionDto[]> {
    const rows = await withUserContext(userId, (tx) =>
      apiTokenRepository.findOAuthConnectionsByUser(userId, tx),
    );
    return rows.map(toOAuthConnectionDto);
  },

  /**
   * Disconnect an app: DELETE the connection. Its access tokens, refresh tokens
   * and consent go in the same statement (every reference cascades), so this is
   * one transaction and the app's next MCP call is a 401. A connection that is
   * missing, another person's, or a PAT's id is a 404 (no existence leak).
   */
  async revoke(userId: string, connectionId: string): Promise<void> {
    await withUserContext(userId, async (tx) => {
      const existing = await apiTokenRepository.findOAuthConnectionForUser(
        connectionId,
        userId,
        tx,
      );
      if (!existing) throw new OAuthConnectionNotFoundError(connectionId);
      await apiTokenRepository.remove(connectionId, tx);
    });
  },

  /**
   * Resolve an OAuth access token to the connection it acts through — the MCP
   * gate's OAuth arm. Returns the SAME shape `apiTokensService.verify` does, so
   * the gate builds the same `AuthInfo`; plus `expiresAt`, which the transport
   * re-checks.
   *
   * Refused (`OAuthAccessTokenRejectedError`), every case a 401 at the gate:
   * a hash no row carries (never issued, revoked, rotated); a token past its
   * expiry; a token that carries no connection or whose client or person
   * disagrees with it; a person no longer in the connection's workspace.
   *
   * ⚠️ There is no per-token `resource` to compare, and none is needed: the
   * provider's only valid audience is the MCP (`validAudiences`), the policy
   * plugin refuses an authorization naming any other `resource`, and the token
   * endpoint refuses one too — so an opaque token for another resource is never
   * minted, and every row here was issued for `<base>/api/mcp`.
   */
  async resolveAccessToken(bearer: string): Promise<{
    user: User;
    workspaceId: string;
    grant: PermissionKey[];
    projectId: string | null;
    dispatchRunId: null;
    scopes: string[];
    expiresAt: Date;
  }> {
    const tokenHash = providerTokenHash(bearer);
    return withSystemContext(async (tx) => {
      const row = await oauthAccessTokenRepository.findByTokenHash(tokenHash, tx);
      if (!row) throw new OAuthAccessTokenRejectedError('unknown');
      const now = new Date();
      if (row.expiresAt.getTime() <= now.getTime()) {
        throw new OAuthAccessTokenRejectedError('expired');
      }
      const connection = row.connection;
      if (
        !connection ||
        connection.oauthClientId !== row.clientId ||
        connection.userId !== row.userId
      ) {
        throw new OAuthAccessTokenRejectedError('unbound');
      }
      // A PAT stops working through the tools' own 404s when its person leaves;
      // a connection is refused at the door instead, so the app is told to
      // reconnect rather than seeing every project vanish.
      const access = await organizationsService.resolveWorkspaceAccess(
        connection.userId,
        connection.workspaceId,
      );
      if (!access) throw new OAuthAccessTokenRejectedError('left_workspace');

      const lastUsed = connection.lastUsedAt?.getTime();
      if (lastUsed === undefined || now.getTime() - lastUsed >= LAST_USED_THROTTLE_MS) {
        await apiTokenRepository.touchLastUsed(connection.id, now, tx);
      }
      const { grant, unrecognised } = expandStoredGrant(connection.scopes, {
        projectId: connection.projectId,
      });
      if (unrecognised.length > 0) {
        console.warn(
          `[oauthConnections] connection ${connection.id} carries ${unrecognised.length} unrecognised grant value(s); ignoring them`,
        );
      }
      return {
        user: connection.user,
        workspaceId: connection.workspaceId,
        projectId: connection.projectId,
        dispatchRunId: null,
        grant,
        scopes: connection.scopes.filter((value) => value !== GRANT_OFFERED_ROOM_VIEW_KEYS_MARKER),
        expiresAt: row.expiresAt,
      };
    });
  },
};
