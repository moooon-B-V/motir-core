import { useTranslations } from 'next-intl';
import { NotebookText } from 'lucide-react';
import { EmptyState } from '@/components/ui/EmptyState';
import { PageTree } from '@/components/pages/tree/PageTree';
import type { PageTreeLevelDto } from '@/lib/dto/pages';
import { NewPageButton } from './NewPageButton';

// THE `/pages` INDEX BODY (Story MOTIR-5752 · MOTIR-7300; the TREE since Story
// MOTIR-5753 · MOTIR-7373) — `design/pages/pages--tree.mock.html` panels 1–8,
// `design-notes.md` § The page tree.
//
// No `'use client'`: it renders inside the page's server <Suspense>, handing the
// server-read root level to the client `PageTree`, which reads every deeper
// level itself. `useTranslations` works in a Server Component, so the same
// component renders under a test's intl provider.
//
// An EMPTY project — no folders and no pages — is the design system's
// `EmptyState` (panel 4, the base's state 3 unchanged): New page as the call to
// action for a reader who may write pages, and NO action at all for a viewer,
// whose description says who writes pages so the empty room does not read as
// broken. The tree draws it in place of its frame, so a root that a retry finds
// empty lands on the same state. (Its New folder action is MOTIR-7374's.)

export interface PagesIndexProps {
  /** The root level as the server read it; `null` when that read failed. */
  root: PageTreeLevelDto | null;
  /** The project's key — every deeper level is read against it. */
  projectKey: string;
  /** Whether the reader holds `page:edit` — the New controls and row menus. */
  canEdit: boolean;
}

export function PagesIndex({ root, projectKey, canEdit }: PagesIndexProps) {
  const t = useTranslations('pages.index');
  return (
    <PageTree
      initialRoot={root}
      projectKey={projectKey}
      canEdit={canEdit}
      emptyState={
        <EmptyState
          data-testid="pages-empty"
          icon={<NotebookText className="h-12 w-12" aria-hidden />}
          title={t('empty.title')}
          description={canEdit ? t('empty.member') : t('empty.viewer')}
          action={canEdit ? <NewPageButton /> : undefined}
        />
      }
    />
  );
}
