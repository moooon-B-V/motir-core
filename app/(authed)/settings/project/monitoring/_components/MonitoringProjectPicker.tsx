'use client';

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { CircleAlert, Search, TriangleAlert } from 'lucide-react';
import { Button, buttonVariants } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Checkbox';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { Spinner } from '@/components/ui/Spinner';
import type { AvailableMonitorProjectDto } from '@/lib/dto/monitors';

// THE PROJECT PICKER (Story MOTIR-4928 · MOTIR-5297) — design/monitoring panels
// 6 and 7, and §11's two picker rules.
//
// The second act of a connect: the callback stored the grant and bound nothing
// (MOTIR-5260), so this is where a person decides which of the organisation's
// projects become bugs on THIS board.
//
// ⚠️ THE READ IS MADE WHEN THE DIALOG OPENS, NOT WITH THE ROOM. The available-
// projects read is the one read on this surface that calls the provider, so a
// degraded credential must not stop the room rendering — it fails here, where
// the person asked for the list, and says why (panel 7).
//
// ⚠️ TWO 409s, ONE OF THEM A SUCCESS. The bind route answers 409 for
// `MONITOR_CONNECTION_ALREADY_EXISTS` (somebody bound the same project a moment
// ago — the state the person wanted) and for `MONITOR_GRANT_NOT_FOUND` (the
// grant is gone). The status cannot tell them apart; the body's `code` can.
//
// ⚠️ RETRY IS PER ROW. A failed bind keeps its box ticked with the reason
// inline; Try again re-POSTs only the failures, and a bind that already
// succeeded is never sent twice.

const ALREADY_BOUND_CODE = 'MONITOR_CONNECTION_ALREADY_EXISTS';

type Load =
  | { state: 'loading' }
  | { state: 'ready'; projects: AvailableMonitorProjectDto[] }
  | { state: 'degraded'; reason: string | null }
  | { state: 'failed' };

type Outcome = 'bound' | 'failed';

export interface MonitoringProjectPickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectKey: string;
  /** The organisation the grant is for — what the copy says the list is FROM. */
  org: string;
  /** Where Reconnect goes (Motir's start route). */
  connectHref: string;
  /** Called once the dialog closes having bound at least one project, so the
   *  room re-reads — the room renders from the server read, so this is
   *  `router.refresh()`. */
  onBound: () => void;
}

/**
 * The picker. Its state lives in {@link PickerDialog}, which is mounted only while
 * the dialog is open — so every open starts from a fresh read and an empty
 * selection by construction, with no reset to forget.
 */
export function MonitoringProjectPicker(props: MonitoringProjectPickerProps) {
  return props.open ? <PickerDialog {...props} /> : null;
}

function PickerDialog({
  onOpenChange,
  projectKey,
  org,
  connectHref,
  onBound,
}: MonitoringProjectPickerProps) {
  const t = useTranslations('monitoring.picker');
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [outcomes, setOutcomes] = useState<ReadonlyMap<string, Outcome>>(new Map());
  const [attempted, setAttempted] = useState<readonly string[]>([]);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    // `live` guards a read that resolves after the dialog closed (unmounted).
    let live = true;
    void (async () => {
      let next: Load;
      try {
        const res = await fetch(
          `/api/projects/${encodeURIComponent(projectKey)}/monitors/available`,
        );
        if (res.ok) {
          next = { state: 'ready', projects: (await res.json()) as AvailableMonitorProjectDto[] };
        } else if (res.status === 502) {
          const body = (await res.json().catch(() => ({}))) as { providerReason?: string };
          next = { state: 'degraded', reason: body.providerReason ?? null };
        } else {
          next = { state: 'failed' };
        }
      } catch {
        next = { state: 'failed' };
      }
      if (live) setLoad(next);
    })();
    return () => {
      live = false;
    };
  }, [projectKey]);

  const projects = useMemo(() => (load.state === 'ready' ? load.projects : []), [load]);
  const boundAtOpen = useMemo(
    () => new Set(projects.filter((p) => p.bound).map((p) => p.externalId)),
    [projects],
  );
  const failedIds = attempted.filter((id) => outcomes.get(id) === 'failed');
  const partial = attempted.length > 0 && failedIds.length > 0;
  // What Try again sends: the failures the person has left ticked. A failure
  // stays ticked by default, and unticking one is how to give up on it.
  const retryIds = failedIds.filter((id) => selected.has(id));
  const anyBound = [...outcomes.values()].includes('bound');

  // In the partial result the list narrows to what the person was deciding
  // about: what was already monitored, plus what they just tried (panel 6, right).
  const visible = useMemo(() => {
    if (partial) {
      return projects.filter(
        (p) => boundAtOpen.has(p.externalId) || attempted.includes(p.externalId),
      );
    }
    const needle = filter.trim().toLowerCase();
    if (!needle) return projects;
    return projects.filter(
      (p) => p.slug.toLowerCase().includes(needle) || p.name.toLowerCase().includes(needle),
    );
  }, [partial, projects, boundAtOpen, attempted, filter]);

  function close() {
    onOpenChange(false);
    if (anyBound) onBound();
  }

  async function bind(ids: readonly string[]) {
    setSubmitting(true);
    const results = await Promise.all(
      ids.map(async (id): Promise<[string, Outcome]> => {
        const project = projects.find((p) => p.externalId === id)!;
        try {
          const res = await fetch(`/api/projects/${encodeURIComponent(projectKey)}/monitors`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              externalProjectId: project.externalId,
              externalProjectSlug: project.slug,
            }),
          });
          if (res.ok) return [id, 'bound'];
          const body = (await res.json().catch(() => ({}))) as { code?: string };
          return [id, res.status === 409 && body.code === ALREADY_BOUND_CODE ? 'bound' : 'failed'];
        } catch {
          return [id, 'failed'];
        }
      }),
    );
    const merged = new Map(outcomes);
    for (const [id, outcome] of results) merged.set(id, outcome);
    setOutcomes(merged);
    setSubmitting(false);

    if (results.every(([, outcome]) => outcome === 'bound')) {
      onOpenChange(false);
      onBound();
    }
  }

  function onPrimary() {
    if (partial) {
      void bind(retryIds);
      return;
    }
    const ids = [...selected];
    setAttempted(ids);
    void bind(ids);
  }

  const newCount = selected.size;
  const added = attempted.length - failedIds.length;

  return (
    <Modal
      open
      onOpenChange={(next) => {
        if (!next && !submitting) close();
      }}
      title={t('title')}
      description={
        load.state === 'ready'
          ? partial
            ? t('partial', { added, attempted: attempted.length, failed: failedIds.length })
            : t('subtitle', { org })
          : undefined
      }
      size="lg"
    >
      {load.state === 'loading' ? (
        <p className="inline-flex items-center gap-2.5 py-6 font-sans text-sm text-(--el-text-secondary)">
          <Spinner size="sm" aria-hidden="true" />
          {t('loading', { org })}
        </p>
      ) : null}

      {load.state === 'degraded' ? (
        <>
          <Modal.Body className="gap-3">
            <div
              role="alert"
              className="flex items-start gap-2.5 rounded-(--radius-card) bg-(--el-warning-surface) px-3.5 py-3 font-sans text-sm text-(--el-warning-text)"
            >
              <TriangleAlert
                className="mt-0.5 size-4 flex-none text-(--el-warning)"
                aria-hidden="true"
              />
              <span>
                <b className="font-semibold">{t('degraded.title', { org })}</b>
                {load.reason ? ` ${t('degraded.says', { reason: load.reason })}` : null}
              </span>
            </div>
            <p className="font-sans text-sm leading-relaxed text-(--el-text-secondary)">
              {t('degraded.body')}
            </p>
          </Modal.Body>
          <Modal.Footer className="shrink-0">
            <Button variant="ghost" onClick={close}>
              {t('cancel')}
            </Button>
            <a href={connectHref} className={buttonVariants({ variant: 'primary' })}>
              {t('reconnect')}
            </a>
          </Modal.Footer>
        </>
      ) : null}

      {load.state === 'failed' ? (
        <>
          <Modal.Body>
            <p
              role="alert"
              className="flex items-start gap-2 font-sans text-sm text-(--el-danger-on-surface)"
            >
              <CircleAlert className="mt-0.5 size-4 flex-none" aria-hidden="true" />
              {t('loadFailed', { org })}
            </p>
          </Modal.Body>
          <Modal.Footer className="shrink-0">
            <Button variant="ghost" onClick={close}>
              {t('cancel')}
            </Button>
          </Modal.Footer>
        </>
      ) : null}

      {load.state === 'ready' ? (
        <>
          <Modal.Body className="gap-3">
            {partial ? null : (
              <Input
                aria-label={t('filter')}
                placeholder={t('filter')}
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                addonStart={<Search className="size-4 text-(--el-icon-muted)" aria-hidden="true" />}
              />
            )}
            {projects.length === 0 ? (
              <p className="font-sans text-sm text-(--el-text-secondary)">
                {t('noProjects', { org })}
              </p>
            ) : visible.length === 0 ? (
              <p className="font-sans text-sm text-(--el-text-secondary)">{t('noMatch')}</p>
            ) : (
              <ul className="flex flex-col rounded-(--radius-card) border border-(--el-border) bg-(--el-card) p-1">
                {visible.map((project) => {
                  const id = project.externalId;
                  const outcome = outcomes.get(id);
                  const locked = boundAtOpen.has(id) || outcome === 'bound';
                  const failed = outcome === 'failed';
                  const checked = locked || selected.has(id);
                  return (
                    <li
                      key={id}
                      className="flex min-w-0 items-center gap-2.5 rounded-(--radius-control) px-(--spacing-control-x) py-(--spacing-control-y)"
                    >
                      <Checkbox
                        checked={checked}
                        disabled={locked || submitting}
                        label={project.slug}
                        stateLabels={{ checked: t('chosen'), unchecked: t('notChosen') }}
                        onChange={(next) =>
                          setSelected((current) => {
                            const copy = new Set(current);
                            if (next) copy.add(id);
                            else copy.delete(id);
                            return copy;
                          })
                        }
                      />
                      <span
                        className={`font-mono text-sm font-semibold ${
                          locked ? 'text-(--el-text-secondary)' : 'text-(--el-text)'
                        }`}
                      >
                        {project.slug}
                      </span>
                      <span className="min-w-0 truncate font-sans text-xs text-(--el-text-secondary)">
                        {project.name}
                      </span>
                      {locked ? (
                        <span className="ml-auto font-sans text-xs whitespace-nowrap text-(--el-text-secondary)">
                          {boundAtOpen.has(id) ? t('alreadyMonitored') : t('nowMonitored')}
                        </span>
                      ) : failed ? (
                        <span className="ml-auto inline-flex items-center gap-1.5 font-sans text-xs whitespace-nowrap text-(--el-danger-on-surface)">
                          <CircleAlert className="size-3.5" aria-hidden="true" />
                          {t('rowError')}
                        </span>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </Modal.Body>
          <Modal.Footer className="shrink-0">
            <Button variant="ghost" disabled={submitting} onClick={close}>
              {partial ? t('done') : t('cancel')}
            </Button>
            <Button
              variant="primary"
              loading={submitting}
              disabled={partial ? retryIds.length === 0 : newCount === 0}
              onClick={onPrimary}
            >
              {partial ? t('retry') : t('monitor', { count: newCount })}
            </Button>
          </Modal.Footer>
        </>
      ) : null}
    </Modal>
  );
}
