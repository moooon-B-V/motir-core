'use client';

import { useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';
import { disconnectGitAccountAction } from '../actions';

// `Disconnect`, on the account's Git pane (Story MOTIR-4669 · MOTIR-4682).
//
// ⚠️ THE SHIPPED DANGER-GHOST TREATMENT, COMPOSED — the `ghost` Button variant
// with danger ink on an `--el-border` border, hovering to `--el-danger-surface`.
// The `Button` primitive has NO danger-ghost variant, which is why that
// composition exists in the app at all; the design's own primitives table says
// to reuse it verbatim precisely so a fourth version of it is not drawn here.
//
// ⚠️ ONE DEPARTURE FROM THE SIBLING, AND IT IS A CORRECTION. The workspace
// page's `DisconnectButton` paints `text-(--el-danger)`. On a page surface that
// is the wrong token: `CLAUDE.md` measures raw `--el-danger` at 4.11–4.25:1 on
// the DARK page in three palettes, and `--el-danger-on-surface` is ≥ 4.77:1 on
// every surface in all twenty palette × theme combinations. The design's token
// table asks for `--el-danger` here; the ink guard and the contrast table are the
// authority over a mock (`design/settings/design-notes.md` says as much about
// `--el-danger-text` two rows down), so this uses the on-surface token. The
// sibling keeps its own value until something re-measures it — a drive-by fix to
// a surface this card does not own is how an unreviewed change lands.
export function DisconnectAccountButton() {
  const t = useTranslations('settings.gitAccounts');
  const [pending, startTransition] = useTransition();

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      loading={pending}
      onClick={() => startTransition(() => void disconnectGitAccountAction())}
      className="border border-(--el-border) text-(--el-danger-on-surface) hover:bg-(--el-danger-surface)"
    >
      {t('disconnect')}
    </Button>
  );
}
