import {
  GithubAppNotConfiguredError,
  GithubAppTokenError,
  mintInstallationToken,
  type GithubAppRole,
} from '@/lib/github/appAuth';
import { provisioningAuth } from '@/lib/github/repoProvisioning';

// WHICH ORG, THROUGH WHICH INSTALLATION (Story MOTIR-8699 · MOTIR-8702) — the one
// reader the fleet's three org-scoped GitHub clients (`actionsVariables.ts`,
// `runnerGroups.ts`, `runnerJitConfig.ts`) authenticate through.
//
// With NO target it IS `provisioningAuth()`: the provisioning org, the Motir
// Studio installation on it and a `provisioning`-role token, with the same
// errors. Every shipped caller passes no target, so `motir-projects` is exactly
// as it was.
//
// With a target the CALLER has already decided which org, which installation and
// which App — this module never derives one, and never guesses an App from an
// owner login (the posture `runGitCredential.ts` holds: one App per repository,
// picked from state). The role travels WITH the target because installation ids
// are per-App, and the token cache in `appAuth.ts` is keyed on both.

/** An org a fleet client acts on, and the installation that grants it. */
export interface GithubOrgTarget {
  /** The org login every `/orgs/{org}/…` path is built from. */
  org: string;
  /** The installation of `role`'s App on that org. */
  installationId: string;
  /** Which App registration the installation belongs to. */
  role: GithubAppRole;
}

/** What a client needs to make one call. */
export interface ResolvedOrgAuth {
  org: string;
  installationId: string;
  token: string;
}

/**
 * Minting a token for a NAMED target failed. `status` is the token endpoint's
 * HTTP status when it answered (401/403/404: the App is gone or suspended on that
 * org), or null when GitHub could not be reached or the App is not configured on
 * this deployment. Never carries a token or a raw body.
 */
export class OrgTargetAuthError extends Error {
  readonly code = 'ORG_TARGET_AUTH_FAILED' as const;
  constructor(
    readonly org: string,
    readonly installationId: string,
    readonly role: GithubAppRole,
    readonly status: number | null,
    detail: string,
  ) {
    super(
      `Could not authenticate as installation ${installationId} (${role}) on ${org}` +
        `${status === null ? '' : ` (HTTP ${status})`}: ${detail}`,
    );
    this.name = 'OrgTargetAuthError';
  }
}

/**
 * Resolve the org and token a fleet client acts with. No target → the
 * provisioning org via `provisioningAuth()`, unchanged. A target → a token minted
 * from that installation under that role.
 */
export async function resolveOrgAuth(target?: GithubOrgTarget): Promise<ResolvedOrgAuth> {
  if (!target) return provisioningAuth();
  try {
    const { token } = await mintInstallationToken(target.installationId, target.role);
    return { org: target.org, installationId: target.installationId, token };
  } catch (err) {
    if (err instanceof GithubAppTokenError) {
      throw new OrgTargetAuthError(
        target.org,
        target.installationId,
        target.role,
        err.status ?? null,
        err.message,
      );
    }
    if (err instanceof GithubAppNotConfiguredError) {
      throw new OrgTargetAuthError(
        target.org,
        target.installationId,
        target.role,
        null,
        err.message,
      );
    }
    throw err;
  }
}
