'use client';

import { useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';
import { disconnectGitlabAction } from '../actions';

// The identity-card "Disconnect" control (MOTIR-1478, design/gitlab Panel 2 — the
// danger-ghost button). A thin client island: the page is a Server Component, so
// the only client need is dispatching the Server Action + a pending state. The
// design's "danger-ghost" = the shipped `ghost` Button variant with danger ink +
// a border (composed via the `--el-danger` / `--el-border` tokens, per the
// design-notes colour row) — the SAME treatment as the GitHub DisconnectButton.
export function GitlabDisconnectButton() {
  const t = useTranslations('gitlab');
  const [pending, startTransition] = useTransition();

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      loading={pending}
      onClick={() => startTransition(() => void disconnectGitlabAction())}
      className="border border-(--el-border) text-(--el-danger) hover:bg-(--el-danger-surface)"
    >
      {t('identity.disconnect')}
    </Button>
  );
}
