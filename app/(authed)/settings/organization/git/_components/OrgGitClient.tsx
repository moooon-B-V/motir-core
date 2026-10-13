'use client';

import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { OrgRepoInventoryRowDto } from '@/lib/dto/organizationRepos';
import { RepositoryInventory } from './RepositoryInventory';

// The ONE client island on Settings → Organisation → Git (Story MOTIR-4669 ·
// MOTIR-4680).
//
// ⚠️ THE PAGE-STATE CONTRACT, ROUTED PER SURFACE (`CLAUDE.md`). The page has two
// kinds of surface and they do NOT refresh the same way:
//
//   THE HEADER + THE CONNECTION CARD — server-rendered from the page's own reads.
//     `router.refresh()` re-runs them and is what updates them.
//   THIS LIST — seeded from server props via `useState`, so `router.refresh()`
//     provably CANNOT reach it (the initializer runs once at mount). It owns its
//     own optimistic removal.
//
// A disconnect changes both, so it does both: the row leaves this island
// immediately, and `router.refresh()` re-reads the server half. Assuming the
// refresh covers the island is the recurring bug the contract exists to stop.
//
// ⚠️ A CHANGE MADE ABOVE IT — a GitHub account linked or disconnected in the
// connection card (MOTIR-8223) — reaches it through its `key`: the page keys
// this island by the set of repository ids it was seeded with, so a refresh
// that changes the set remounts it with the new rows.
export function OrgGitClient({
  initialRows,
  organizationName,
  canDisconnect,
  manageOnGithubHrefs,
  retentionDays,
}: {
  initialRows: OrgRepoInventoryRowDto[];
  organizationName: string;
  canDisconnect: boolean;
  manageOnGithubHrefs: Readonly<Record<string, string>>;
  retentionDays: number;
}) {
  const router = useRouter();
  const [rows, setRows] = useState(initialRows);

  const onDisconnect = useCallback(
    async (row: OrgRepoInventoryRowDto) => {
      const res = await fetch(`/api/organization/repositories/${encodeURIComponent(row.repo.id)}`, {
        method: 'DELETE',
      });
      if (!res.ok) return;
      setRows((prev) => prev.filter((r) => r.repo.id !== row.repo.id));
      router.refresh();
    },
    [router],
  );

  return (
    <RepositoryInventory
      rows={rows}
      organizationName={organizationName}
      canDisconnect={canDisconnect}
      manageOnGithubHrefs={manageOnGithubHrefs}
      onDisconnect={onDisconnect}
      retentionDays={retentionDays}
    />
  );
}
