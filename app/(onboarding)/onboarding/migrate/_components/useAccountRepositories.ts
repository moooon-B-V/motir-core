'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { MigrateConnectExistingRepositoryDto } from '@/lib/dto/migrateOnboarding';

// THE REPOSITORIES READ of the connect step's picker (Story MOTIR-8245 ·
// MOTIR-8763): one already-installed account's repositories, each marked by
// MOTIR-8220's `GET …/github/accounts/{installationId}/repositories` as
// `available`, `connected_here` or `connected_elsewhere`.
//
// ⚠️ THE ONLY PLACE THAT KNOWS THIS WIRE SHAPE, and the availability is the
// route's. The one local override is `markTaken`: a repository the link route
// says another organisation took meanwhile flips to the locked kind in place
// (MOTIR-8764 calls it), exactly as Settings' picker does with its 409.
//
// The selection lives here so the confirm card can keep it across a re-read:
// only `available` ids are ever selected, and a re-read drops any id that is
// no longer available.

export type AccountRepositoriesState =
  | { kind: 'loading' }
  | {
      kind: 'ok';
      rows: MigrateConnectExistingRepositoryDto[];
      counts: { available: number; connectedHere: number; connectedElsewhere: number };
    }
  | { kind: 'not_accessible' }
  | { kind: 'failed' };

const AVAILABILITY = new Set(['available', 'connected_here', 'connected_elsewhere']);

async function readJson(res: Response): Promise<Record<string, unknown>> {
  try {
    return ((await res.json()) ?? {}) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** One response of the repositories route as the picker's closed union. */
export async function accountRepositoriesFrom(res: Response): Promise<AccountRepositoriesState> {
  const body = await readJson(res);
  if (res.status === 403 && body.code === 'installation_not_accessible') {
    return { kind: 'not_accessible' };
  }
  if (!res.ok || !Array.isArray(body.repos)) return { kind: 'failed' };
  // Only the three fields are kept: anything else a response carried is not
  // rendered, so a `connected_elsewhere` row can never name its owner.
  const rows = (body.repos as MigrateConnectExistingRepositoryDto[])
    .filter((r) => AVAILABILITY.has(r.availability))
    .map((r) => ({ repoId: r.repoId, fullName: r.fullName, availability: r.availability }))
    .sort((a, b) => a.fullName.localeCompare(b.fullName));
  return { kind: 'ok', rows, counts: countsOf(rows) };
}

function countsOf(rows: MigrateConnectExistingRepositoryDto[]) {
  return {
    available: rows.filter((r) => r.availability === 'available').length,
    connectedHere: rows.filter((r) => r.availability === 'connected_here').length,
    connectedElsewhere: rows.filter((r) => r.availability === 'connected_elsewhere').length,
  };
}

interface Held {
  installationId: string | null;
  state: AccountRepositoriesState;
  selected: ReadonlySet<string>;
  /** Ids the link route said were taken meanwhile — marked in place. */
  taken: ReadonlySet<string>;
}

const EMPTY: ReadonlySet<string> = new Set();

export function useAccountRepositories(
  organizationId: string | null,
  installationId: string | null,
): {
  state: AccountRepositoriesState;
  selected: ReadonlySet<string>;
  taken: ReadonlySet<string>;
  toggle: (repoId: string, next: boolean) => void;
  toggleAll: (next: boolean) => void;
  refresh: () => void;
  markTaken: (repoIds: string[]) => void;
} {
  const [held, setHeld] = useState<Held>({
    installationId: null,
    state: { kind: 'loading' },
    selected: EMPTY,
    taken: EMPTY,
  });
  const seq = useRef(0);

  const request = useCallback(
    async (opts: { keepSelection: boolean }) => {
      if (!organizationId || !installationId) return;
      const mine = ++seq.current;
      let next: AccountRepositoriesState;
      try {
        const res = await fetch(
          `/api/organizations/${encodeURIComponent(organizationId)}/github/accounts/${encodeURIComponent(installationId)}/repositories`,
          { cache: 'no-store' },
        );
        next = await accountRepositoriesFrom(res);
      } catch {
        next = { kind: 'failed' };
      }
      if (mine !== seq.current) return;
      setHeld((prev) => {
        const sameAccount = prev.installationId === installationId;
        const available = new Set(
          next.kind === 'ok'
            ? next.rows.filter((r) => r.availability === 'available').map((r) => r.repoId)
            : [],
        );
        const kept =
          opts.keepSelection && sameAccount
            ? new Set([...prev.selected].filter((id) => available.has(id)))
            : EMPTY;
        return {
          installationId,
          state: next,
          selected: kept,
          taken: opts.keepSelection && sameAccount ? prev.taken : EMPTY,
        };
      });
    },
    [organizationId, installationId],
  );

  // A new account is a fresh picker; the answer lands from the request's own
  // callback (no synchronous set-state in the effect).
  useEffect(() => {
    void request({ keepSelection: false });
  }, [request]);

  const current: Held =
    held.installationId === installationId
      ? held
      : { installationId, state: { kind: 'loading' }, selected: EMPTY, taken: EMPTY };

  const toggle = useCallback((repoId: string, next: boolean) => {
    setHeld((prev) => {
      if (prev.state.kind !== 'ok') return prev;
      const row = prev.state.rows.find((r) => r.repoId === repoId);
      if (!row || row.availability !== 'available' || prev.taken.has(repoId)) return prev;
      const selected = new Set(prev.selected);
      if (next) selected.add(repoId);
      else selected.delete(repoId);
      return { ...prev, selected };
    });
  }, []);

  const toggleAll = useCallback((next: boolean) => {
    setHeld((prev) => {
      if (prev.state.kind !== 'ok') return prev;
      const selected = next
        ? new Set(
            prev.state.rows
              .filter((r) => r.availability === 'available' && !prev.taken.has(r.repoId))
              .map((r) => r.repoId),
          )
        : EMPTY;
      return { ...prev, selected };
    });
  }, []);

  const refresh = useCallback(() => {
    void request({ keepSelection: true });
  }, [request]);

  const markTaken = useCallback((repoIds: string[]) => {
    setHeld((prev) => {
      if (prev.state.kind !== 'ok') return prev;
      const ids = new Set(repoIds);
      const rows = prev.state.rows.map((r) =>
        ids.has(r.repoId) ? { ...r, availability: 'connected_elsewhere' as const } : r,
      );
      return {
        ...prev,
        state: { kind: 'ok', rows, counts: countsOf(rows) },
        selected: new Set([...prev.selected].filter((id) => !ids.has(id))),
        taken: new Set([...prev.taken, ...ids]),
      };
    });
  }, []);

  return {
    state: current.state,
    selected: current.selected,
    taken: current.taken,
    toggle,
    toggleAll,
    refresh,
    markTaken,
  };
}
