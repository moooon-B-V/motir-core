'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { CircleAlert, FolderGit2, Plus } from 'lucide-react';
import { Combobox, type ComboboxOption } from '@/components/ui/Combobox';
import { Button } from '@/components/ui/Button';
import {
  connectGitlabProjectAction,
  listGitlabProjectsAction,
  type ProjectActionError,
} from '../actions';

// The in-app project picker (MOTIR-1478, design/gitlab Panel 2b) — the honest
// inverse of GitHub's out-of-app install screen. GitLab's OAuth `api` scope lets
// Motir enumerate the user's projects, so the user connects them HERE, not on a
// separate GitLab screen. The DOOR is the quiet "+ Connect a project" link-cta in
// the Projects card footer; clicking it expands the shipped query-driven
// `Combobox` (the AddLinkControl grammar the design cites) over the user's
// not-yet-connected projects. Picking one + Connect persists the selection.
//
// A client island: it holds the fetched candidate list + open/selection/pending
// state. The projects list above is SERVER-rendered, so on a successful connect
// we `router.refresh()` (the page-state contract's server-surface case) and reset.
// A live-enumeration failure (revoked authorization) surfaces the reconnect hint.

export function GitlabProjectPicker() {
  const t = useTranslations('gitlab');
  const tc = useTranslations('common');
  const router = useRouter();

  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [candidates, setCandidates] = useState<ComboboxOption<string>[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<ProjectActionError | null>(null);
  const [pending, startTransition] = useTransition();

  async function openPicker() {
    setOpen(true);
    setError(null);
    setSelectedId(null);
    setLoading(true);
    const res = await listGitlabProjectsAction();
    setLoading(false);
    if (!res.ok) {
      setCandidates([]);
      setError(res.error);
      return;
    }
    // Only offer projects that aren't already connected (the connected ones show
    // in the list above). Repo icon + namespace/name; search matches both slots.
    setCandidates(
      res.projects
        .filter((p) => !p.connected)
        .map((p) => ({
          value: p.repoId,
          label: p.name,
          secondary: p.owner,
          icon: <FolderGit2 className="h-4 w-4 text-(--el-icon-muted)" />,
        })),
    );
  }

  function cancel() {
    setOpen(false);
    setError(null);
    setSelectedId(null);
    setCandidates([]);
  }

  function connect() {
    if (!selectedId) return;
    setError(null);
    startTransition(async () => {
      const res = await connectGitlabProjectAction(selectedId);
      if (res.ok) {
        cancel();
        // The projects list is server-rendered — re-read it so the new row shows.
        router.refresh();
      } else {
        setError(res.error);
      }
    });
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={openPicker}
        className="inline-flex items-center gap-1.5 rounded-(--radius-control) px-1.5 py-1 font-sans text-sm font-semibold text-(--el-link) hover:underline focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
      >
        <Plus className="h-4 w-4" aria-hidden />
        {t('projects.connectProject')}
      </button>
    );
  }

  return (
    <div className="mb-1 flex w-full flex-col gap-2.5 rounded-(--radius-card) border border-(--el-border) bg-(--el-surface-soft) p-3">
      <div className="flex flex-col gap-1.5">
        <span className="font-mono text-[11px] font-semibold tracking-wider text-(--el-text-eyebrow) uppercase">
          {t('projects.pickerLabel')}
        </span>
        <Combobox
          label={t('projects.pickerLabel')}
          options={candidates}
          value={selectedId}
          onChange={(v) => setSelectedId(v)}
          searchable
          placeholder={t('projects.searchPlaceholder')}
          searchPlaceholder={t('projects.searchPlaceholder')}
          loading={loading}
          emptyText={t('projects.noProjects')}
        />
        <p className="font-sans text-xs text-(--el-text-muted)">{t('projects.memberOnly')}</p>
      </div>
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={connect} disabled={!selectedId || pending} loading={pending}>
          {t('projects.connectAction')}
        </Button>
        <Button size="sm" variant="ghost" onClick={cancel} disabled={pending}>
          {tc('cancel')}
        </Button>
      </div>
      {error ? (
        <div className="flex items-start gap-2 rounded-(--radius-control) bg-(--el-tint-rose) px-3 py-2">
          <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-(--el-danger)" aria-hidden />
          <span className="font-sans text-[13px] text-(--el-text-strong)">
            {t(`projects.error.${error}`)}
          </span>
        </div>
      ) : null}
    </div>
  );
}
