'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/components/ui/Toast';
import { useProjectAccess } from '../../_components/ProjectAccessProvider';

// NEW PAGE (Story MOTIR-5752 · MOTIR-7300) — `design/pages/design-notes.md`
// § New page. One press creates an empty page at the project root
// (`POST /api/pages` → `{ id }`) and moves the browser to it, where the page
// itself asks for its title first: no dialog, no title prompt.
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

export function NewPageButton() {
  const t = useTranslations('pages.index');
  const router = useRouter();
  const { toast } = useToast();
  const { can } = useProjectAccess();
  const [pending, setPending] = useState(false);

  if (!can('page:edit')) return null;

  async function create() {
    if (pending) return;
    setPending(true);
    try {
      const res = await fetch('/api/pages', { method: 'POST' });
      if (!res.ok) throw new Error(`POST /api/pages answered ${res.status}`);
      const { id } = (await res.json()) as { id: string };
      router.push(`/pages/${encodeURIComponent(id)}`);
    } catch {
      setPending(false);
      toast({ variant: 'error', title: t('createFailed') });
    }
  }

  return (
    <Button
      variant="primary"
      leftIcon={<Plus className="h-4 w-4" />}
      loading={pending}
      onClick={create}
      data-testid="new-page-button"
    >
      {pending ? t('creating') : t('newPage')}
    </Button>
  );
}
