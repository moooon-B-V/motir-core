import Link from 'next/link';
import { CheckCheck, AlertTriangle } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import { publicFollowService } from '@/lib/services/publicFollowService';
import { FollowTokenInvalidError } from '@/lib/publicProjects/followErrors';

// The confirmation landing (Story 8.9 · Subtask 8.9.5 · design Panel D3's
// counterpart — the state AFTER the link in the inbox is followed).
//
// ⚠️ A GET PERFORMS THE CONFIRMATION, and that is a deliberate trade rather than
// an oversight. The alternative — render a button that POSTs — is safer against
// link-prefetching mail clients and security scanners, and it is what a
// destructive action would demand. This action is not destructive: the worst a
// scanner can do is confirm a subscription its own user asked for, and the
// unsubscribe link in every subsequent email is one click. Weighed against that,
// a second click on a page that says only "are you sure you want the thing you
// just asked for?" is friction that loses real subscribers. Both the one-click
// confirm and the one-click unsubscribe are the format's convention.
//
// The token is single-use and cleared as it is spent, so a prefetch followed by
// a human click lands on the invalid state rather than confirming twice — which
// is why the invalid copy says "expired or already used" rather than "wrong".

export default async function FollowConfirmPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;
  const t = await getTranslations('publicProjects');

  let projectIdentifier: string | null = null;
  let failed = false;
  if (!token) {
    failed = true;
  } else {
    try {
      ({ projectIdentifier } = await publicFollowService.confirmEmailFollow(token));
    } catch (err) {
      if (err instanceof FollowTokenInvalidError) failed = true;
      else throw err;
    }
  }

  return (
    <main className="mx-auto flex max-w-[34rem] flex-col items-center gap-3 px-6 py-20 text-center">
      <span
        className={failed ? 'text-(--el-danger-on-surface)' : 'text-(--el-success)'}
        aria-hidden
      >
        {failed ? <AlertTriangle className="h-8 w-8" /> : <CheckCheck className="h-8 w-8" />}
      </span>
      <h1 className="font-serif text-[20px] font-bold text-(--el-text)">
        {failed ? t('confirmInvalidTitle') : t('confirmedTitle')}
      </h1>
      <p className="max-w-[42ch] text-[13.5px] leading-relaxed text-(--el-text-secondary)">
        {failed
          ? t('confirmInvalidBody')
          : t('confirmedBody', { project: projectIdentifier ?? '' })}
      </p>
      {projectIdentifier ? (
        <Link
          href={`/p/${encodeURIComponent(projectIdentifier)}/changelog`}
          className="mt-2 text-[13px] text-(--el-link) hover:underline"
        >
          {t('backToProject')}
        </Link>
      ) : null}
    </main>
  );
}
