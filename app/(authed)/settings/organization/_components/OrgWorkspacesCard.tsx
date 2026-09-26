'use client';

import { useState, useTransition } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ArrowRight, Info, Layers, Plus, TriangleAlert } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Pill } from '@/components/ui/Pill';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorState } from '@/components/ui/ErrorState';
import { useToast } from '@/components/ui/Toast';
import { afterContextSwitchTarget } from '@/lib/navigation/afterContextSwitch';
import type { OrgWorkspacePageDTO, OrgWorkspaceRowDTO } from '@/lib/dto/workspaces';
import { CreateWorkspaceDialog } from '../../../_components/CreateWorkspaceDialog';
import { reconcileActiveWorkspaceAction } from '../actions';
import { switchWorkspaceAction } from '../../../_actions';
import { ORG_WORKSPACES_PAGE_SIZE } from './workspacesPageSize';
import { OPENED_WORKSPACE_TARGET } from '@/lib/navigation/afterContextSwitch';

export interface OrgWorkspacesCardProps {
  orgId: string;
  orgName: string;
  /** The first page, server-rendered by the org settings page. */
  initialPage: OrgWorkspacePageDTO;
  /** The session's active workspace — removing it re-points the active one. */
  activeWorkspaceId: string | null;
}

// The org WORKSPACES card (MOTIR-6312 ·
// `design/org-admin/org-admin--workspaces-at-org-tier.mock.html` panel 1): the
// org-tier home for creating and removing workspaces. Rendered by the org
// settings page ONLY for `manageWorkspaces` (an Owner or an Admin); an Admin
// sees EVERY workspace of the org, including ones they are not a member of,
// because removal needs no membership (MOTIR-6309).
//
// A client island that owns its own page (the roster's grammar, finding #57's
// at-scale rule): a page at a time via `GET /api/organizations/[orgId]/workspaces`,
// never load-all. After a mutation it refetches ITS page and asks the server
// for the rest with `router.refresh()` — the page-state contract's two halves
// (CLAUDE.md § *Page state after a mutation*): `router.refresh()` cannot reach
// an island seeded from props, and the island cannot reach the server-rendered
// counts, so a removal does both.
export function OrgWorkspacesCard({
  orgId,
  orgName,
  initialPage,
  activeWorkspaceId,
}: OrgWorkspacesCardProps) {
  const t = useTranslations('orgAdmin');
  const router = useRouter();

  const [page, setPage] = useState<OrgWorkspacePageDTO>(initialPage);
  const [pageIndex, setPageIndex] = useState(0);
  // cursorStack[i] = the `cursor` query that fetched page i (null for page 0).
  const [cursorStack, setCursorStack] = useState<(string | null)[]>([null]);
  const [status, setStatus] = useState<'idle' | 'loading' | 'error'>('idle');
  const [createOpen, setCreateOpen] = useState(false);
  const [removing, setRemoving] = useState<OrgWorkspaceRowDTO | null>(null);

  const pageCount = Math.max(1, Math.ceil(page.total / ORG_WORKSPACES_PAGE_SIZE));
  const from = page.workspaces.length === 0 ? 0 : pageIndex * ORG_WORKSPACES_PAGE_SIZE + 1;
  const to = pageIndex * ORG_WORKSPACES_PAGE_SIZE + page.workspaces.length;

  async function fetchPage(cursor: string | null, nextIndex: number): Promise<void> {
    setStatus('loading');
    try {
      const params = new URLSearchParams({ limit: String(ORG_WORKSPACES_PAGE_SIZE) });
      if (cursor) params.set('cursor', cursor);
      const res = await fetch(`/api/organizations/${orgId}/workspaces?${params.toString()}`);
      if (!res.ok) {
        setStatus('error');
        return;
      }
      const data = (await res.json()) as OrgWorkspacePageDTO;
      // A page emptied by a removal falls back to the one before it.
      if (data.workspaces.length === 0 && nextIndex > 0) {
        await fetchPage(cursorStack[nextIndex - 1] ?? null, nextIndex - 1);
        return;
      }
      setPage(data);
      setPageIndex(nextIndex);
      setStatus('idle');
    } catch {
      setStatus('error');
    }
  }

  function goNext() {
    if (!page.nextCursor) return;
    const nextIndex = pageIndex + 1;
    setCursorStack((stack) => {
      const copy = stack.slice(0, nextIndex);
      copy[nextIndex] = page.nextCursor;
      return copy;
    });
    void fetchPage(page.nextCursor, nextIndex);
  }

  function goPrev() {
    if (pageIndex === 0) return;
    const prevIndex = pageIndex - 1;
    void fetchPage(cursorStack[prevIndex] ?? null, prevIndex);
  }

  function reloadCurrent() {
    void fetchPage(cursorStack[pageIndex] ?? null, pageIndex);
  }

  function onCreated() {
    // A create changes the counts the server renders (the General card, the
    // shell's reveal test) and this list's total — both halves.
    reloadCurrent();
    router.refresh();
  }

  // Open (panel 6b): switch to the workspace, then land on its settings. It
  // writes nothing to the workspace's roster — an org Owner / Admin reaches it
  // by their org role.
  function openWorkspace(w: OrgWorkspaceRowDTO) {
    void switchWorkspaceAction(w.id).then(() => {
      router.push(OPENED_WORKSPACE_TARGET);
      router.refresh();
    });
  }

  function onRemoved(removed: OrgWorkspaceRowDTO) {
    // Optimistic leave: the row goes at once, the page then refetches so the
    // next workspace moves up into its slot.
    setPage((p) => ({
      ...p,
      workspaces: p.workspaces.filter((w) => w.id !== removed.id),
      total: Math.max(0, p.total - 1),
    }));
    reloadCurrent();
  }

  const newButton = (
    <Button
      variant="secondary"
      size="sm"
      leftIcon={<Plus className="h-4 w-4" />}
      onClick={() => setCreateOpen(true)}
    >
      {t('workspaces.new')}
    </Button>
  );

  const showPager = page.total > ORG_WORKSPACES_PAGE_SIZE && status !== 'error';

  return (
    <>
      <Card
        aria-labelledby="org-workspaces-heading"
        header={
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <h2
                id="org-workspaces-heading"
                className="font-sans text-base font-semibold text-(--el-text)"
              >
                {t('workspaces.title')}
              </h2>
              <Pill tone="neutral">{t('workspaces.count', { count: page.total })}</Pill>
            </div>
            {newButton}
          </div>
        }
        footer={
          showPager ? (
            <div className="flex items-center justify-between gap-3">
              <span className="text-(--el-text-muted) font-sans text-xs" aria-live="polite">
                {t('workspaces.pager', { from, to, total: page.total })}
              </span>
              <div className="flex items-center gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={goPrev}
                  disabled={pageIndex === 0 || status === 'loading'}
                >
                  {t('workspaces.prev')}
                </Button>
                <span className="text-(--el-text-muted) font-sans text-xs">
                  {t('workspaces.page', { n: pageIndex + 1, m: pageCount })}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={goNext}
                  disabled={!page.nextCursor || status === 'loading'}
                >
                  {t('workspaces.next')}
                </Button>
              </div>
            </div>
          ) : undefined
        }
      >
        <p className="text-(--el-text-secondary) mb-(--spacing-md) font-sans text-sm">
          {t('workspaces.subtitle', { org: orgName })}
        </p>

        {status === 'error' ? (
          <ErrorState
            title={t('workspaces.errorTitle')}
            description={t('workspaces.errorDescription')}
            retry={reloadCurrent}
          />
        ) : status === 'loading' ? (
          <ul
            role="list"
            className="flex flex-col"
            aria-busy="true"
            aria-label={t('workspaces.loading')}
          >
            {Array.from({
              length: Math.min(page.workspaces.length || 3, ORG_WORKSPACES_PAGE_SIZE),
            }).map((_, i) => (
              <WorkspaceRowSkeleton key={i} />
            ))}
          </ul>
        ) : page.workspaces.length === 0 ? (
          <EmptyState
            icon={<Layers className="h-12 w-12" aria-hidden />}
            title={t('workspaces.emptyTitle')}
            description={t('workspaces.emptyDescription', { org: orgName })}
            action={
              <Button
                variant="primary"
                leftIcon={<Plus className="h-4 w-4" />}
                onClick={() => setCreateOpen(true)}
              >
                {t('workspaces.new')}
              </Button>
            }
          />
        ) : (
          <ul role="list" className="flex flex-col">
            {page.workspaces.map((w) => (
              <li
                key={w.id}
                className="border-(--el-border-soft) flex items-center gap-3 border-b py-3 last:border-b-0"
              >
                <span
                  aria-hidden
                  className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-(--radius-control) bg-(--el-tint-peach) font-sans text-sm font-semibold text-(--el-text-strong)"
                >
                  {w.name.charAt(0).toUpperCase()}
                </span>
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate font-sans text-sm font-medium text-(--el-text)">
                    {w.name}
                  </span>
                  <span className="text-(--el-text-muted) font-sans text-xs">
                    {t('workspaces.rowMeta', {
                      members: w.memberCount,
                      projects: w.projectCount,
                    })}
                  </span>
                </div>
                {w.viewerIsMember ? null : (
                  // An org Owner / Admin reaches a workspace they are not on the
                  // roster of as its Manager (panel 6b) — said here, in words.
                  <Pill memberRole="admin" className="shrink-0">
                    {t('workspaces.viaOrganization')}
                  </Pill>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  rightIcon={<ArrowRight className="h-3.5 w-3.5" />}
                  aria-label={t('workspaces.openAria', { workspace: w.name })}
                  onClick={() => openWorkspace(w)}
                >
                  {t('workspaces.open')}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={t('workspaces.removeAria', { workspace: w.name })}
                  onClick={() => setRemoving(w)}
                >
                  {t('workspaces.remove')}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <CreateWorkspaceDialog open={createOpen} onOpenChange={setCreateOpen} onCreated={onCreated} />

      <RemoveWorkspaceModal
        orgId={orgId}
        orgName={orgName}
        workspace={removing}
        isLastWorkspace={page.total <= 1}
        isActive={removing !== null && removing.id === activeWorkspaceId}
        onOpenChange={(o) => {
          if (!o) setRemoving(null);
        }}
        onRemoved={onRemoved}
      />
    </>
  );
}

function WorkspaceRowSkeleton() {
  return (
    <li className="border-(--el-border-soft) flex items-center gap-3 border-b py-3 last:border-b-0">
      <span className="bg-(--el-muted) h-8 w-8 shrink-0 animate-pulse rounded-(--radius-control)" />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="bg-(--el-muted) h-3 w-32 animate-pulse rounded-(--radius-control)" />
        <span className="bg-(--el-muted) h-2.5 w-44 animate-pulse rounded-(--radius-control)" />
      </div>
      <span className="bg-(--el-muted) h-6 w-16 animate-pulse rounded-(--radius-control)" />
    </li>
  );
}

// Remove (1g) — the shipped workspace-tier `DeleteConfirmModal`, RE-HOMED: the
// rose tile, the serif title and the case-sensitive type-the-name unlock, with a
// body that states what goes.
function RemoveWorkspaceModal({
  orgId,
  orgName,
  workspace,
  isLastWorkspace,
  isActive,
  onOpenChange,
  onRemoved,
}: {
  orgId: string;
  orgName: string;
  workspace: OrgWorkspaceRowDTO | null;
  isLastWorkspace: boolean;
  isActive: boolean;
  onOpenChange: (open: boolean) => void;
  onRemoved: (workspace: OrgWorkspaceRowDTO) => void;
}) {
  const t = useTranslations('orgAdmin');
  const tc = useTranslations('common');
  const router = useRouter();
  const pathname = usePathname();
  const { toast } = useToast();
  const [typed, setTyped] = useState('');
  const [isPending, startTransition] = useTransition();
  const name = workspace?.name ?? '';
  const matches = workspace !== null && typed === name;

  function close() {
    setTyped('');
    onOpenChange(false);
  }

  function handleRemove() {
    if (!matches || !workspace) return;
    startTransition(async () => {
      let res: Response;
      try {
        res = await fetch(`/api/organizations/${orgId}/workspaces/${workspace.id}`, {
          method: 'DELETE',
        });
      } catch {
        toast({ variant: 'error', title: t('workspaces.removeErrorTitle', { workspace: name }) });
        return;
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        toast({
          variant: 'error',
          title: t('workspaces.removeErrorTitle', { workspace: name }),
          description: body?.error,
        });
        return;
      }
      toast({ variant: 'success', title: t('workspaces.removed', { workspace: name }) });
      close();
      onRemoved(workspace);
      // Removing the ACTIVE workspace re-points the active one the way a switch
      // does (afterContextSwitchTarget), so no island keeps the dead workspace's
      // state; anything else refreshes the server-rendered counts in place.
      const { changed } = isActive ? await reconcileActiveWorkspaceAction() : { changed: false };
      const target = changed ? afterContextSwitchTarget(pathname) : null;
      if (target) router.push(target);
      else router.refresh();
    });
  }

  return (
    <Modal
      open={workspace !== null}
      onOpenChange={(o) => {
        if (!o) close();
      }}
      size="md"
      // Its own visible heading below; `srTitle` gives the dialog that name rather
      // than the generic "Dialog" fallback.
      srTitle={t('workspaces.removeTitle', { workspace: name })}
    >
      <div className="mb-(--spacing-md) flex items-start gap-3">
        <span
          className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full"
          style={{ backgroundColor: 'var(--el-tint-rose)' }}
        >
          <TriangleAlert className="h-5 w-5" style={{ color: 'var(--el-danger)' }} />
        </span>
        <div>
          <h2 className="font-serif text-xl font-semibold text-(--el-text)">
            {t('workspaces.removeTitle', { workspace: name })}
          </h2>
          <p className="text-(--el-text-muted) mt-1 font-sans text-sm">
            {t('workspaces.removeDesc', {
              projects: workspace?.projectCount ?? 0,
              members: workspace?.memberCount ?? 0,
              org: orgName,
            })}
          </p>
          {/* IMMEDIATE, and the copy must say so (MOTIR-2171 · §14.3): a
              workspace removal is a hard cascade with no surface left to undo
              into, so the sentence the workspace-tier delete carried moves with
              it. */}
          <p className="text-(--el-text-muted) mt-1 font-sans text-sm">
            {t('workspaces.removeCodeIndex')}
          </p>
        </div>
      </div>

      {isLastWorkspace ? (
        // The org's last workspace: ALLOWED — the server has no last-workspace
        // rule — and SAID, not refused.
        <p
          className="mb-(--spacing-md) flex items-start gap-2 rounded-(--radius-control) bg-(--el-tint-yellow) px-3 py-2 font-sans text-sm text-(--el-text-strong)"
          data-testid="remove-last-workspace-note"
        >
          <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          {t('workspaces.removeLastWorkspace', { org: orgName })}
        </p>
      ) : null}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          handleRemove();
        }}
      >
        <Input
          label={t('workspaces.removeConfirmLabel', { workspace: name })}
          placeholder={name}
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          autoFocus
        />
        <Modal.Footer>
          <Button variant="ghost" onClick={close} disabled={isPending}>
            {tc('cancel')}
          </Button>
          <Button type="submit" variant="danger" disabled={!matches} loading={isPending}>
            {t('workspaces.removeConfirmButton')}
          </Button>
        </Modal.Footer>
      </form>
    </Modal>
  );
}
