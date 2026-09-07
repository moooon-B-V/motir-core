import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { FileQuestion } from 'lucide-react';
import { EmptyState } from '@/components/ui/EmptyState';
import { buttonVariants } from '@/components/ui/Button';

// MOTIR-4708 — the ROOT not-found boundary: the two public pages that call
// `notFound()` outside `(authed)`, plus every URL the router matches nothing for.
//
// Its job is the same as `app/(authed)/not-found.tsx`'s and its reasoning is
// written there in full: without a boundary, Next mounts its built-in not-found
// component, which ships an inline `body{color:#000} @media (prefers-color-scheme:dark){body{color:#fff}}`
// that overrides `app/globals.css`. Owning the boundary is what stops that markup
// being rendered at all, so nothing here — or inherited by here — takes a colour
// from the OS colour scheme.
//
// It is deliberately PLAINER than the authed one. This file renders inside
// `app/layout.tsx` only, so it has the appearance tokens (`data-theme` is on
// `<html>` on the first byte) but no app shell, and it may be reached by somebody
// with no session at all. So its one door is the product's front door rather than
// `/items`, which would bounce a signed-out reader to `/sign-in`. The signed-in
// case never lands here: `(authed)` owns its own boundary, one segment down.
export default async function NotFound() {
  const t = await getTranslations('errors.notFound');

  return (
    <main className="mx-auto flex min-h-dvh max-w-[48rem] flex-col justify-center px-(--spacing-lg) py-(--spacing-2xl)">
      <EmptyState
        icon={<FileQuestion className="h-12 w-12" aria-hidden />}
        title={t('title')}
        description={t('description')}
        action={
          <Link href="/" className={buttonVariants({ variant: 'secondary' })}>
            {t('homeAction')}
          </Link>
        }
      />
    </main>
  );
}
