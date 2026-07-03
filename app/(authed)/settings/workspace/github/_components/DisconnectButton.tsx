'use client';

import { useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';
import { disconnectGithubAction } from '../actions';

// The identity-card "Disconnect" control (MOTIR-895, design Panel 2 — the
// danger-ghost button). A thin client island: the page is a Server Component, so
// the only client need is dispatching the Server Action + a pending state. The
// design's "danger-ghost" = the shipped `ghost` Button variant with danger ink +
// a border (the Button primitive has no danger-ghost variant; composed via the
// `--el-danger` / `--el-border` tokens, per the design-notes colour row).

export function DisconnectButton() {
  const t = useTranslations('github');
  const [pending, startTransition] = useTransition();

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      loading={pending}
      onClick={() => startTransition(() => void disconnectGithubAction())}
      className="border border-(--el-border) text-(--el-danger) hover:bg-(--el-danger-surface)"
    >
      {t('identity.disconnect')}
    </Button>
  );
}
