'use client';

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Switch } from '@/components/ui/Switch';
import { disconnectGitlabProjectAction } from '../actions';

// The per-project sync toggle (MOTIR-1478, design/gitlab Panel 2 — the
// `role="switch"`). A connected project renders the switch ON (it is syncing);
// turning it OFF disconnects the project — removing its `github_repo` row and the
// row from the list ("you can disconnect any of them any time", the design copy).
// The projects card is server-rendered, so on success we `router.refresh()` to
// re-read it (the page-state contract's server-surface case). While the action is
// in flight the switch is disabled so a double-toggle can't race.
//
// (The design's third "Paused" state — a switch left OFF while the project stays
// listed — needs a persisted `sync-enabled` flag, deferred with the same
// judgement as self-managed GitLab in the design notes; connect/disconnect is the
// shipped two-state control. The switch is the faithful primitive either way.)
export function GitlabProjectSyncSwitch({ repoId, label }: { repoId: string; label: string }) {
  const t = useTranslations('gitlab');
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <Switch
      checked
      disabled={pending}
      aria-label={t('projects.syncLabel', { project: label })}
      onCheckedChange={() =>
        startTransition(async () => {
          await disconnectGitlabProjectAction(repoId);
          router.refresh();
        })
      }
    />
  );
}
