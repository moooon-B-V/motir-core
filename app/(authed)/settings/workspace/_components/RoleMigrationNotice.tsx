'use client';

import { useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { ArrowRight, Lock, UserRoundCog } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Pill } from '@/components/ui/Pill';
import { useToast } from '@/components/ui/Toast';
import type { RoleMigrationReason, WorkspaceRole } from '@/generated/prisma/client';
import type {
  RoleMigrationBeforeDTO,
  RoleMigrationEntryDTO,
  RoleMigrationPageDTO,
} from '@/lib/dto/workspaces';
import { dismissRoleMigrationEntryAction, loadRoleMigrationPageAction } from '../actions';

// The migration notice (Story MOTIR-6168 · MOTIR-6465; design panel 1g–1h): the
// people the move to workspace roles did NOT move by the plain mapping, each with
// what they held before, the role they hold now and why. Managers only — the
// server hands a non-Manager no page at all, so this renders only when there is
// something open. Dismissing a row removes it locally (it is this island's own
// state, the page-state contract's case 3) and revalidates the server surfaces.

/** Every reason the migrations write — the notice is TOTAL over the enum. */
export const ROLE_MIGRATION_REASONS = [
  'narrowest_kept',
  'project_role_dropped',
  'custom_role_recreated',
  'custom_role_merged',
  'org_admin_granted',
  'mapped_narrower',
] as const satisfies readonly RoleMigrationReason[];

/** The Pill hue each workspace role carries — the member-role tints moved up a tier. */
const ROLE_HUE: Record<WorkspaceRole, 'admin' | 'member' | 'viewer'> = {
  manager: 'admin',
  member: 'member',
  viewer: 'viewer',
};

export function RoleMigrationNotice({ initial }: { initial: RoleMigrationPageDTO }) {
  const t = useTranslations('settings');
  const { toast } = useToast();
  const [entries, setEntries] = useState<RoleMigrationEntryDTO[]>(initial.entries);
  const [total, setTotal] = useState(initial.total);
  const [cursor, setCursor] = useState<string | null>(initial.nextCursor);
  const [loadingMore, startLoadMore] = useTransition();
  const [pendingId, setPendingId] = useState<string | null>(null);

  if (total <= 0 || entries.length === 0) return null;

  function dismiss(entry: RoleMigrationEntryDTO) {
    setPendingId(entry.id);
    void dismissRoleMigrationEntryAction(entry.id).then((result) => {
      setPendingId(null);
      if (result.ok) {
        setEntries((current) => current.filter((e) => e.id !== entry.id));
        setTotal((n) => Math.max(0, n - 1));
        toast({ variant: 'success', title: t('members.migration.dismissed') });
      } else {
        toast({
          variant: 'error',
          title: t('members.migration.dismissError'),
          description: result.error,
        });
      }
    });
  }

  function showMore() {
    if (!cursor) return;
    startLoadMore(async () => {
      const result = await loadRoleMigrationPageAction(cursor);
      if (!result.ok) return;
      setEntries((current) => [
        ...current,
        ...result.page.entries.filter((e) => !current.some((c) => c.id === e.id)),
      ]);
      setTotal(result.page.total);
      setCursor(result.page.nextCursor);
    });
  }

  return (
    <Card
      id="role-migration"
      className="border-(--el-border-strong)"
      header={
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <UserRoundCog className="text-(--el-text-secondary) h-4 w-4 shrink-0" aria-hidden />
            <h2 className="font-sans text-base font-semibold text-(--el-text)">
              {t('members.migration.title')}
            </h2>
            <Pill tone="neutral">{t('members.migration.count', { count: total })}</Pill>
          </div>
          <Pill tone="neutral">
            <Lock className="h-3 w-3" aria-hidden />
            {t('members.migration.managersOnly')}
          </Pill>
        </div>
      }
    >
      <p className="text-(--el-text-secondary) mb-3 font-sans text-sm">
        {t('members.migration.body')}
      </p>
      <ul role="list" className="flex flex-col" aria-label={t('members.migration.title')}>
        {entries.map((entry) => (
          <li
            key={entry.id}
            className="border-(--el-border-soft) flex items-start gap-3 border-b py-3 last:border-b-0"
          >
            <span
              className="bg-(--el-text) text-(--el-text-inverted) inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full font-sans text-xs font-semibold"
              aria-hidden
            >
              {(entry.name || entry.email).charAt(0).toUpperCase()}
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <p className="truncate font-sans text-sm font-medium text-(--el-text)">
                {entry.name}
              </p>
              <p className="flex flex-wrap items-center gap-1.5 font-sans text-xs">
                <span className="sr-only">{t('members.migration.before')}: </span>
                <span className="text-(--el-text-secondary)">
                  {describeBefore(entry.before, t)}
                </span>
                <ArrowRight className="text-(--el-text-secondary) h-3.5 w-3.5" aria-hidden />
                <span className="sr-only">{t('members.migration.after')}: </span>
                {entry.afterCustomRoleName ? (
                  <Pill memberRole="custom">{entry.afterCustomRoleName}</Pill>
                ) : (
                  <Pill memberRole={ROLE_HUE[entry.afterRole]}>
                    {t(`members.role.${entry.afterRole}`)}
                  </Pill>
                )}
              </p>
              <p className="text-(--el-text-secondary) font-sans text-xs">
                {t(`members.migration.reason.${entry.reason}`)}
              </p>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => dismiss(entry)}
              loading={pendingId === entry.id}
              aria-label={t('members.migration.dismissLabel', { name: entry.name })}
            >
              {t('members.migration.dismiss')}
            </Button>
          </li>
        ))}
      </ul>
      {cursor ? (
        <div className="mt-2 flex justify-center">
          <Button variant="ghost" size="sm" onClick={showMore} loading={loadingMore}>
            {t('members.migration.showMore')}
          </Button>
        </div>
      ) : null}
    </Card>
  );
}

/**
 * The BEFORE column in words: the legacy workspace role, then every project role
 * (`Viewer in PROD`), or where the keys narrowed. A custom role's name is its
 * author's text and is not translated.
 */
export function describeBefore(
  before: RoleMigrationBeforeDTO,
  t: (key: string, values?: Record<string, string | number>) => string,
): string {
  const parts: string[] = [];
  if (before.workspaceRole) {
    parts.push(t(`members.migration.legacyRole.${legacyKey(before.workspaceRole)}`));
  }
  for (const p of before.projects) {
    const role =
      p.customRoleName ??
      (p.role ? t(`members.migration.projectRoleName.${legacyKey(p.role)}`) : null);
    if (role) parts.push(t('members.migration.projectRole', { role, project: p.projectKey }));
  }
  if (before.narrowedIn.length > 0) {
    parts.push(
      t('members.migration.narrowedIn', {
        projects: before.narrowedIn.map((n) => n.projectKey).join(', '),
      }),
    );
  }
  return parts.join(' · ');
}

function legacyKey(role: string): 'owner' | 'admin' | 'member' | 'viewer' {
  return role === 'owner' || role === 'admin' || role === 'viewer' ? role : 'member';
}
