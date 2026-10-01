// DTOs for OAuth connections (Story MOTIR-6973 · Subtask MOTIR-6983) — what the
// Connected apps list (MOTIR-6986) and the consent page (MOTIR-6985) receive.
// A connection is an `api_token` row, but it has no secret, so there is no
// prefix here and never a hash.

import type { PermissionKey } from '@/lib/permissions/catalog';

/**
 * Who vouches for an app (Story MOTIR-7170 · Subtask MOTIR-7174). A VALUE, not a
 * flag, so a surface that switches over it is total and cannot forget a member:
 *
 * - `registered` — a signed-in Motir user registered the client, so its name was
 *   set by someone this deployment knows.
 * - `domain` — Motir DISCOVERED the client by fetching and validating the Client
 *   ID Metadata Document at its `client_id` URL (MOTIR-7173). `host` is that
 *   URL's host, and it is the verified fact: the document's `client_name` is
 *   still the app's own claim.
 * - `self` — the client registered itself (RFC 7591): nobody vouches for it.
 */
export type OAuthClientVerification =
  | { kind: 'registered' }
  | { kind: 'domain'; host: string }
  | { kind: 'self' };

/** One app a person has connected, as Settings → Account → Connected apps lists it. */
export interface OAuthConnectionDto {
  id: string;
  /** The registered client, as it named itself at registration. */
  client: {
    clientId: string;
    name: string | null;
    uri: string | null;
    icon: string | null;
    /** Who vouches for it — registered, a verified domain, or nobody. */
    verification: OAuthClientVerification;
    /** The host of its first registered redirect URI — the one fact on the row
     * the app did not choose. A loopback address reads `localhost`. */
    host: string | null;
  };
  workspace: { id: string; name: string };
  organization: { id: string; name: string };
  /** The ONE project it acts in, or null for every project the person can open. */
  project: { id: string; name: string } | null;
  /** The resolved grant — the same expansion a PAT's list row shows. */
  permissions: PermissionKey[];
  createdAt: string;
  /** Null = the app has not called the MCP since it connected. */
  lastUsedAt: string | null;
}

/** What approving consent returns: the connection, and where the browser goes
 * next — the client's redirect, carrying the authorization code. */
export interface ApproveConsentResult {
  connectionId: string;
  redirectUrl: string;
}

/** A project the consent screen's One-project picker offers, with what the
 * person may confer there (the create-token picker's offer). */
export interface ConsentProjectDto {
  id: string;
  key: string;
  name: string;
  grantable: PermissionKey[];
}

/** A workspace a connection may act in — one the person can grant something in. */
export interface ConsentWorkspaceDto {
  id: string;
  /** `org · workspace`: a workspace name alone is ambiguous across orgs. */
  label: string;
  projects: ConsentProjectDto[];
}

/**
 * A pending consent request, read SERVER-SIDE from the request the provider
 * signed — never from what the URL claims about the app. What the consent
 * screen (MOTIR-6985) renders.
 */
export interface ConsentRequestDto {
  client: {
    clientId: string;
    /** The registered `client_name` — the app's own claim, rendered as data. */
    name: string | null;
    /** Who vouches for it — registered, a verified domain, or nobody. */
    verification: OAuthClientVerification;
  };
  /** Where the code goes: the request's `redirect_uri`, already checked against
   * the client's registration. */
  redirectUri: string;
  redirectHost: string;
  /** A loopback redirect — an app on this computer. */
  loopback: boolean;
  /** The workspaces the person can grant something in. */
  workspaces: ConsentWorkspaceDto[];
  /** Labels of the workspaces they belong to but can grant nothing in — the
   * "none of your workspaces" state names them. */
  unusableWorkspaces: string[];
}

/** What declining returns: the client redirect carrying `error=access_denied`. */
export interface DenyConsentResult {
  redirectUrl: string;
}

/** The app an authorize request is waiting on, as the sign-in card's hand-off
 * banner names it. */
export interface OAuthSignInClientDto {
  /** The client's `client_name` — its own claim. Null when it gave none. */
  name: string | null;
  verification: OAuthClientVerification;
}
