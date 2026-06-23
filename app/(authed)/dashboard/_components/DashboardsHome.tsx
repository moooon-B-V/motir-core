'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Ellipsis, LayoutDashboard, Lock, Plus, Trash2, Users } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Modal } from '@/components/ui/Modal';
import { Pill } from '@/components/ui/Pill';
import { Popover } from '@/components/ui/Popover';
import { useToast } from '@/components/ui/Toast';
import type { DashboardSummaryDto } from '@/lib/dto/dashboards';
import { CreateDashboardModal } from './CreateDashboardModal';

// The dashboards home (6.3.5, design panel 1) — the workspace-scoped list
// grouped My dashboards (full edit) vs Shared with the workspace (a View-only
// chip, overflow hidden), the create flow, and the first-run empty state.
// Private dashboards owned by others never reach this list (route + UI gate).
// Clicking a row opens its grid; this same list is the in-grid switcher.

export function DashboardsHome({ dashboards }: { dashboards: DashboardSummaryDto[] }) {
  const t = useTranslations('dashboards');
  const [createOpen, setCreateOpen] = useState(false);
  const [rows, setRows] = useState(dashboards);
  const [deleting, setDeleting] = useState<DashboardSummaryDto | null>(null);

  const mine = rows.filter((d) => d.isOwner);
  const shared = rows.filter((d) => !d.isOwner);

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 font-serif text-2xl font-semibold text-(--el-text)">
            <LayoutDashboard className="size-5 text-(--el-text-secondary)" aria-hidden />
            {t('title')}
          </h1>
          <p className="mt-1 text-sm text-(--el-text-muted)">{t('subtitle')}</p>
        </div>
        <Button
          variant="primary"
          leftIcon={<Plus className="size-4" />}
          onClick={() => setCreateOpen(true)}
          data-testid="new-dashboard"
        >
          {t('newDashboard')}
        </Button>
      </header>

      {rows.length === 0 ? (
        <EmptyState
          icon={<LayoutDashboard className="size-6" aria-hidden />}
          title={t('empty.title')}
          description={t('empty.body')}
          action={
            <Button
              variant="primary"
              leftIcon={<Plus className="size-4" />}
              onClick={() => setCreateOpen(true)}
            >
              {t('newDashboard')}
            </Button>
          }
        />
      ) : (
        <div className="flex flex-col gap-5">
          {mine.length > 0 ? (
            <Group title={t('groupMine')}>
              {mine.map((d) => (
                <Row key={d.id} dashboard={d} onDelete={() => setDeleting(d)} />
              ))}
            </Group>
          ) : null}
          {shared.length > 0 ? (
            <Group title={t('groupShared')}>
              {shared.map((d) => (
                <Row key={d.id} dashboard={d} />
              ))}
            </Group>
          ) : null}
        </div>
      )}

      <CreateDashboardModal open={createOpen} onOpenChange={setCreateOpen} />
      {deleting ? (
        <DeleteRowModal
          dashboard={deleting}
          onCancel={() => setDeleting(null)}
          onDeleted={() => {
            setRows((r) => r.filter((x) => x.id !== deleting.id));
            setDeleting(null);
          }}
        />
      ) : null}
    </div>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="mb-2 text-xs font-semibold tracking-wide text-(--el-text-muted) uppercase">
        {title}
      </h2>
      {/* `data-surface="card"` opts this list into the surface-MATERIAL layer
          (neumorphism mould, glassmorphism frost, aurora glow) — like the board
          / widget cards. Without it the /dashboard list stayed flat under those
          styles (MOTIR-1314). Inert under non-material styles. */}
      <div
        data-surface="card"
        className="overflow-hidden rounded-(--radius-card) border border-(--el-border)"
      >
        {children}
      </div>
    </section>
  );
}

function Row({ dashboard, onDelete }: { dashboard: DashboardSummaryDto; onDelete?: () => void }) {
  const t = useTranslations('dashboards');
  return (
    <div className="flex items-center gap-3 border-b border-(--el-border) px-3 py-2.5 last:border-0 hover:bg-(--el-surface-soft)">
      <LayoutDashboard className="size-4 shrink-0 text-(--el-text-muted)" aria-hidden />
      <Link
        href={`/dashboard/${dashboard.id}`}
        className="min-w-0 flex-1 focus-visible:outline-none"
        data-testid={`dashboard-row-${dashboard.id}`}
      >
        <span className="block truncate text-sm font-semibold text-(--el-text) hover:underline">
          {dashboard.name}
        </span>
        <span className="block truncate text-xs text-(--el-text-muted)">
          {dashboard.isOwner ? t('ownedByYou') : dashboard.owner.name} ·{' '}
          {t('widgetCount', { count: dashboard.widgetCount })}
        </span>
      </Link>
      <AccessPill access={dashboard.access} />
      {dashboard.isOwner ? (
        <Popover>
          <Popover.Trigger
            aria-label={t('optionsAria')}
            className="inline-flex size-7 items-center justify-center rounded-(--radius-control) text-(--el-text-muted) hover:bg-(--el-muted) hover:text-(--el-text) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color)"
          >
            <Ellipsis className="size-4" aria-hidden />
          </Popover.Trigger>
          <Popover.Content width={170} align="end" className="p-1">
            <Link
              href={`/dashboard/${dashboard.id}`}
              role="menuitem"
              className="flex w-full items-center gap-2 rounded-(--radius-control) px-(--spacing-control-x) py-(--spacing-control-y) text-sm text-(--el-text) hover:bg-(--el-muted) focus-visible:bg-(--el-muted) focus-visible:outline-none"
            >
              <LayoutDashboard className="size-4 text-(--el-text-muted)" aria-hidden />
              {t('open')}
            </Link>
            <button
              type="button"
              role="menuitem"
              onClick={onDelete}
              data-testid={`dashboard-row-delete-${dashboard.id}`}
              className="flex w-full items-center gap-2 rounded-(--radius-control) px-(--spacing-control-x) py-(--spacing-control-y) text-left text-sm text-(--el-text) hover:bg-(--el-muted) hover:text-(--el-danger) focus-visible:bg-(--el-muted) focus-visible:outline-none"
            >
              <Trash2 className="size-4 text-(--el-text-muted)" aria-hidden />
              {t('delete')}
            </button>
          </Popover.Content>
        </Popover>
      ) : (
        <Pill tone="neutral">{t('viewOnly')}</Pill>
      )}
    </div>
  );
}

function AccessPill({ access }: { access: DashboardSummaryDto['access'] }) {
  const t = useTranslations('dashboards');
  return access === 'workspace' ? (
    <Pill status="in-progress">
      <Users className="size-3" aria-hidden />
      {t('accessWorkspace')}
    </Pill>
  ) : (
    <Pill tone="neutral">
      <Lock className="size-3" aria-hidden />
      {t('accessPrivate')}
    </Pill>
  );
}

function DeleteRowModal({
  dashboard,
  onCancel,
  onDeleted,
}: {
  dashboard: DashboardSummaryDto;
  onCancel: () => void;
  onDeleted: () => void;
}) {
  const t = useTranslations('dashboards');
  const tc = useTranslations('common');
  const tToast = useTranslations('dashboards.toast');
  const { toast } = useToast();

  function handleDelete() {
    void fetch(`/api/dashboards/${encodeURIComponent(dashboard.id)}`, {
      method: 'DELETE',
      headers: { accept: 'application/json' },
    })
      .then((res) => {
        if (res.ok) onDeleted();
        else
          toast({
            variant: 'error',
            title: tToast('errorTitle'),
            description: tToast('deleteError'),
          });
      })
      .catch(() =>
        toast({
          variant: 'error',
          title: tToast('errorTitle'),
          description: tToast('deleteError'),
        }),
      );
  }

  return (
    <Modal open onOpenChange={(o) => !o && onCancel()} size="sm">
      <h2 className="flex items-center gap-2.5 font-serif text-lg font-semibold text-(--el-text-strong)">
        <Trash2 className="size-5 shrink-0 text-(--el-danger)" aria-hidden />
        {t('deleteModal.title', { name: dashboard.name })}
      </h2>
      <p className="mt-2 text-sm leading-relaxed text-(--el-text-secondary)">
        {t('deleteModal.body')}
      </p>
      <Modal.Footer>
        <Button variant="ghost" onClick={onCancel}>
          {tc('cancel')}
        </Button>
        <Button variant="danger" leftIcon={<Trash2 className="size-4" />} onClick={handleDelete}>
          {t('deleteModal.confirm')}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
