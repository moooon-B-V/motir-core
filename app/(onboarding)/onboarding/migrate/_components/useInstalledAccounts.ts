'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { MigrateConnectExistingAccountDto } from '@/lib/dto/migrateOnboarding';

// THE ACCOUNTS READ of the connect step (Story MOTIR-8245 · MOTIR-8762): the
// GitHub accounts the Motir App is already installed on that the person can
// reach, from MOTIR-8220's `GET /api/organizations/{orgId}/github/accounts`.
//
// ⚠️ THE ONLY PLACE THAT KNOWS THE WIRE SHAPE. Everything above this hook reads
// the closed union below. The list is GitHub's view of the PERSON, built by the
// route; nothing here derives an account, or admin-ness, from the connect read
// or from stored installation rows.
//
// ⚠️ THE TWO 403s ARE TOLD APART BY THE BODY CODE, NEVER BY THE STATUS
// (design Revision 8, behaviour 8). On this route a 403 is the organisation's
// admin refusal (`ORG_FORBIDDEN`, `lib/organizations/errorResponse.ts`); a body
// saying `installation_not_accessible` is the link route's refusal about one
// account, and it is never read as "not an admin".

export type InstalledAccountsState =
  | { kind: 'loading' }
  | { kind: 'ok'; accounts: MigrateConnectExistingAccountDto[] }
  | { kind: 'identity_required' }
  | { kind: 'not_admin' }
  | { kind: 'failed' };

async function readJson(res: Response): Promise<Record<string, unknown>> {
  try {
    return ((await res.json()) ?? {}) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** One response of the accounts route as the step's closed union. Pure, so the
 *  mapping is testable without a component. */
export async function installedAccountsFrom(res: Response): Promise<InstalledAccountsState> {
  const body = await readJson(res);
  if (res.status === 403) {
    return body.code === 'installation_not_accessible' ? { kind: 'failed' } : { kind: 'not_admin' };
  }
  if (!res.ok) return { kind: 'failed' };
  if (body.state === 'identity_required') return { kind: 'identity_required' };
  if (body.state !== 'ok' || !Array.isArray(body.accounts)) return { kind: 'failed' };
  const accounts = (body.accounts as MigrateConnectExistingAccountDto[]).map((a) => ({
    installationId: a.installationId,
    accountLogin: a.accountLogin,
    accountType: a.accountType,
    avatarUrl: a.avatarUrl ?? null,
    linkState: a.linkState,
  }));
  accounts.sort((x, y) => x.accountLogin.localeCompare(y.accountLogin));
  return { kind: 'ok', accounts };
}

/**
 * Reads the accounts once `organizationId` is known (the connect read carries
 * it), and again on `reload()` — the connect read's `retry`, and the could-not-
 * read block's own Try again. The OAuth round trip returns to a fresh mount of
 * the step, so its arrival read is the re-read after a sign-in.
 */
export function useInstalledAccounts(organizationId: string | null): {
  state: InstalledAccountsState;
  reload: () => void;
  /** Remove one account from a listed answer — the link route said the person
   *  can no longer reach it (MOTIR-8764 calls this; nothing here does). */
  dropAccount: (installationId: string) => void;
} {
  const [state, setState] = useState<InstalledAccountsState>({ kind: 'loading' });
  // A slow answer must not paint over a newer one.
  const seq = useRef(0);

  const request = useCallback(async () => {
    if (!organizationId) return;
    const mine = ++seq.current;
    let next: InstalledAccountsState;
    try {
      const res = await fetch(
        `/api/organizations/${encodeURIComponent(organizationId)}/github/accounts`,
        { cache: 'no-store' },
      );
      next = await installedAccountsFrom(res);
    } catch {
      next = { kind: 'failed' };
    }
    if (mine === seq.current) setState(next);
  }, [organizationId]);

  useEffect(() => {
    // `request` writes state only after its await, so this is no synchronous
    // set-state-in-effect; the read starts with the effect that learnt the id.
    void request();
  }, [request]);

  const reload = useCallback(() => {
    if (!organizationId) return;
    setState({ kind: 'loading' });
    void request();
  }, [organizationId, request]);

  const dropAccount = useCallback((installationId: string) => {
    setState((prev) =>
      prev.kind === 'ok'
        ? { kind: 'ok', accounts: prev.accounts.filter((a) => a.installationId !== installationId) }
        : prev,
    );
  }, []);

  return { state, reload, dropAccount };
}
