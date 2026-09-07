import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { FileQuestion } from 'lucide-react';
import { EmptyState } from '@/components/ui/EmptyState';
import { buttonVariants } from '@/components/ui/Button';

// MOTIR-4708 — the not-found BOUNDARY for every signed-in route.
//
// ── WHY THIS FILE EXISTS AT ALL ───────────────────────────────────────────
// With no `not-found.tsx` above them, all 16 `app/(authed)` pages that call
// `notFound()` fell through to Next's BUILT-IN not-found component, whose markup
// carries its own `<style>` inside the body
// (`next/dist/client/components/http-access-fallback/error-fallback.js`):
//
//     body{color:#000;background:#fff;margin:0}
//     @media (prefers-color-scheme:dark){body{color:#fff;background:#000}}
//
// That rule is emitted AFTER `app/globals.css`'s `body { color: var(--el-page-text) }`
// at equal specificity, so its `color` wins — and its polarity comes from the OS,
// while the ground the reader actually sees is painted by `AppLayout`'s
// `bg-(--el-page-bg)` div from `data-theme` on `<html>`. A person who PINS light
// or dark (two of the three states the top bar's tri-state toggle cycles into) can
// disagree with their OS by construction, and then the ink and the ground are set
// by different authorities: light theme + dark OS renders white-on-white, 1.00 : 1.
// The 404 was served correctly and read as a blank rectangle.
//
// Rendering our OWN boundary is what fixes it: the built-in component — and its
// inline `<style>` — is never mounted, so nothing on the page takes its colour
// from `prefers-color-scheme`. `EmptyState` routes every colour through `--el-*`.
//
// ── WHY IT IS INSIDE `(authed)` AND NOT ONLY AT THE ROOT ───────────────────
// A root `app/not-found.tsx` renders outside `(authed)/layout.tsx` and so gets no
// shell — no rail, no top bar, no way back except a link this page draws itself.
// Placing the boundary INSIDE the group keeps the shell that MOTIR-4193's
// explanation relies on ("a rail full of doors"), which is the whole reason the
// app host was judged acceptable on wayfinding in the first place. The root file
// still exists for the two public `notFound()` pages and for unmatched URLs; it is
// deliberately the plainer of the two, because it has no session to assume.
//
// ── WHAT MUST NOT BE ADDED ABOVE THIS ─────────────────────────────────────
// No `loading.tsx` may sit above any page that calls `notFound()` — a Suspense
// fallback flushes the head at 200 and the 404 becomes a page that merely looks
// like one (CLAUDE.md § *A `loading.tsx` may NOT sit above a route that decides
// existence*; MOTIR-3491 / MOTIR-3492). A `not-found.tsx` is NOT such a boundary:
// it renders only after `notFound()` has already settled the status.
// `tests/navigation/loading-boundary-guard.test.ts` enforces the prohibition and
// `tests/navigation/not-found-boundary.test.ts` enforces this file's own contract.
export default async function AuthedNotFound() {
  const t = await getTranslations('errors.notFound');

  return (
    <div className="mx-auto max-w-[48rem]">
      <EmptyState
        icon={<FileQuestion className="h-12 w-12" aria-hidden />}
        title={t('title')}
        description={t('description')}
        action={
          <Link href="/items" className={buttonVariants({ variant: 'secondary' })}>
            {t('workItemsAction')}
          </Link>
        }
      />
    </div>
  );
}
