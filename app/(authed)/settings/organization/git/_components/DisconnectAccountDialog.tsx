'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { CircleAlert, FolderGit2, Layers } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { ErrorState } from '@/components/ui/ErrorState';
import type { AccountDisconnectPreviewDto } from '@/lib/services/githubAccountDisconnectService';
import type { GithubAccountRef } from './githubAccounts';

// DISCONNECT ONE GITHUB ACCOUNT FROM THIS ORGANISATION (Story MOTIR-8216 ·
// MOTIR-8223), built to `design/github/github--multi-org-account.mock.html`
// Panels A7a–A7d. It extends the shipped repository dialog's pattern
// (`RepositoryInventory`): the act happens IN Motir — it removes a link Motir
// owns, not the App's selection on GitHub — so it is an ordinary destructive
// confirm, `alertdialog`, danger fill.
//
// ⚠️ EVERY FACT IS THE PREVIEW'S. The account, its repositories here, the
// projects that lose them and the retention window all come from
// `GET /api/organization/github/accounts/{id}/disconnect-preview` (MOTIR-8222),
// read when the dialog opens. The window in particular is INTERPOLATED from the
// preview's `retentionWindowDays` — a number retyped here would be a second
// definition of it, and the first to drift.
//
// ⚠️ SUCCESS REFRESHES THE ROOM; IT DOES NOT PATCH IT. The account list is
// server-rendered, and the inventory island below it is re-keyed by the room
// on the same refresh, so one `router.refresh()` (the caller's `onDone`) is the
// whole of the update — back to the not-connected panel when it was the last.

type PreviewState =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'ok'; preview: AccountDisconnectPreviewDto };

export interface DisconnectAccountDialogProps {
  account: GithubAccountRef | null;
  organizationName: string;
  onClose: () => void;
  onDone: () => void;
}

export function DisconnectAccountDialog({
  account,
  organizationName,
  onClose,
  onDone,
}: DisconnectAccountDialogProps) {
  const t = useTranslations('github.accountDisconnect');
  const tPicker = useTranslations('github.picker');
  const tInventory = useTranslations('github.orgDisconnect');
  const [preview, setPreview] = useState<PreviewState>({ kind: 'loading' });
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const seq = useRef(0);

  const path = account
    ? `/api/organization/github/accounts/${encodeURIComponent(account.installationId)}`
    : null;

  // A PURE read — no state write — so the open effect may call it and apply the
  // answer in a `.then` (the React-19 set-state-in-effect rule).
  const requestPreview = async (url: string): Promise<PreviewState> => {
    try {
      const res = await fetch(`${url}/disconnect-preview`);
      if (!res.ok) return { kind: 'error' };
      return { kind: 'ok', preview: (await res.json()) as AccountDisconnectPreviewDto };
    } catch {
      return { kind: 'error' };
    }
  };

  const load = () => {
    if (!path) return;
    const mine = ++seq.current;
    setPreview({ kind: 'loading' });
    void requestPreview(path).then((next) => {
      if (mine === seq.current) setPreview(next);
    });
  };

  // The room re-keys this dialog per account, so every piece of state starts
  // fresh for each one — `preview` already reads `loading` — and only the
  // preview read remains to start.
  useEffect(() => {
    if (!path) return;
    const mine = ++seq.current;
    void requestPreview(path).then((next) => {
      if (mine === seq.current) setPreview(next);
    });
  }, [path]);

  const confirm = async () => {
    if (!path) return;
    setBusy(true);
    setFailed(false);
    try {
      const res = await fetch(path, { method: 'DELETE' });
      if (!res.ok) {
        setFailed(true);
        return;
      }
      onDone();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  const login = account?.accountLogin ?? '';
  const chip =
    'inline-flex items-center gap-1.5 rounded-(--radius-badge) border border-(--el-chip-border) bg-(--el-chip-bg) px-(--spacing-chip-x) py-(--spacing-chip-y) font-sans text-xs text-(--el-text-secondary)';

  return (
    <Modal
      open={account !== null}
      onOpenChange={(open) => {
        // In flight the dialog cannot be dismissed: the act is already on its way.
        if (!open && !busy) onClose();
      }}
      role="alertdialog"
      size="lg"
      hideClose={busy}
      title={t('title', { account: login, org: organizationName })}
    >
      <Modal.Body className="gap-3">
        {preview.kind === 'loading' ? (
          <p role="status" className="font-sans text-sm text-(--el-text-secondary)">
            {t('loading')}
          </p>
        ) : preview.kind === 'error' ? (
          <ErrorState
            title={t('loadFailed', { account: login })}
            retry={() => load()}
            retryLabel={tPicker('retry')}
          />
        ) : (
          <>
            <p className="font-sans text-sm text-(--el-text)">
              {t('repos', {
                org: organizationName,
                account: preview.preview.accountLogin,
                count: preview.preview.repos.length,
              })}
            </p>
            {preview.preview.repos.length > 0 ? (
              <ul className="flex flex-wrap gap-2">
                {preview.preview.repos.map((repo) => (
                  <li key={repo.githubRepoId} className={chip}>
                    <FolderGit2 className="h-3.5 w-3.5 text-(--el-icon-muted)" aria-hidden />
                    {repo.repoRef.slice(repo.repoRef.indexOf('/') + 1)}
                  </li>
                ))}
              </ul>
            ) : null}
            {preview.preview.projects.length === 0 ? (
              <p className="font-sans text-sm text-(--el-text)">
                {t('noProjects', { org: organizationName })}
              </p>
            ) : (
              <>
                <p className="font-sans text-sm text-(--el-text)">
                  {t('projects', { count: preview.preview.projects.length })}
                </p>
                <ul className="flex flex-wrap gap-2">
                  {preview.preview.projects.map((project) => (
                    <li key={project.id} className={chip}>
                      <Layers className="h-3.5 w-3.5 text-(--el-icon-muted)" aria-hidden />
                      {project.name}
                    </li>
                  ))}
                </ul>
                <p className="font-sans text-sm text-(--el-text-secondary)">
                  {tInventory('onlyLinked')}
                </p>
              </>
            )}
            <p className="font-sans text-sm text-(--el-text-secondary)">
              {t('retention', { days: preview.preview.retentionWindowDays })}
            </p>
            <p className="font-sans text-sm text-(--el-text-secondary)">
              {t('others', { account: preview.preview.accountLogin })}
            </p>
          </>
        )}
      </Modal.Body>
      <Modal.Footer className="flex-wrap">
        {failed ? (
          <p
            role="alert"
            className="mr-auto flex items-start gap-1.5 font-sans text-sm text-(--el-danger-on-surface)"
          >
            <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            <span>{t('failed', { account: login })}</span>
          </p>
        ) : null}
        <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onClose}>
          {t('cancel')}
        </Button>
        <Button
          type="button"
          variant="danger"
          size="sm"
          loading={busy}
          disabled={busy || preview.kind !== 'ok'}
          onClick={() => void confirm()}
        >
          {t('confirm')}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
