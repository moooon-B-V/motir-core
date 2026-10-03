'use client';

import { useTranslations } from 'next-intl';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useCreatePage } from '@/components/pages/tree/useCreatePage';
import type { PageParentDto } from '@/lib/dto/pages';
import { useProjectAccess } from '../../_components/ProjectAccessProvider';

// NEW PAGE (Story MOTIR-5752 · MOTIR-7300; given a place by Story MOTIR-5753 ·
// MOTIR-7373) — `design/pages/design-notes.md` § New page and § The page tree,
// "New". One press creates an empty page under `parent` — the project root when
// omitted — and moves the browser to it, where the page itself asks for its
// title first: no dialog, no title prompt. The POST and the move are
// `useCreatePage`'s, the one create path the tree's own New page here / New
// sub-page entries also go through.
//
// ⚠️ RENDERED ONLY FOR `page:edit` — the key `pagesService.createPage` asserts.
// A viewer gets NO button, not a disabled one (§ State 4: "a disabled button is
// a promise the product then refuses"). Hiding it is not the enforcement; the
// route's own gate is.
//
// While the POST is in flight the button is disabled and shows the spinner with
// "Creating page…". On success it STAYS pending: the browser is leaving for the
// new page, and re-enabling it would invite a second page. A failure is the
// shipped Toast, and the button returns.

const ROOT: PageParentDto = { kind: 'root' };

export interface NewPageButtonProps {
  /** Where the page is created; the project root when omitted. */
  parent?: PageParentDto;
}

export function NewPageButton({ parent = ROOT }: NewPageButtonProps) {
  const t = useTranslations('pages.index');
  const { can } = useProjectAccess();
  const { pending, create } = useCreatePage();

  if (!can('page:edit')) return null;

  return (
    <Button
      variant="primary"
      leftIcon={<Plus className="h-4 w-4" />}
      loading={pending !== null}
      onClick={() => create(parent)}
      data-testid="new-page-button"
    >
      {pending ? t('creating') : t('newPage')}
    </Button>
  );
}
