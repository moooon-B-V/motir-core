import { CheckCheck } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import { publicFollowService } from '@/lib/services/publicFollowService';

// The unsubscribe landing (Story 8.9 · Subtask 8.9.5 · design Panel D4).
//
// ⚠️ IT ALWAYS SAYS THE SAME THING, and never reports a failure. The service is
// idempotent: a token whose row is already gone answers success, so a second
// click, a mail client's prefetch, and a link found two years later all land
// here identically. Telling somebody their unsubscribe "failed" is the one
// outcome this page must never produce — they would have no other lever, and
// the honest state either way is that we will not email them again.
//
// A missing token lands here too. There is nothing to do and nothing to
// confess: whoever arrived without one is not subscribed through this link.
//
// One click, no sign-in — which is why the unsubscribe token, unlike the
// confirmation one, never expires (`followTokens.ts`).

export default async function FollowUnsubscribePage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;
  if (token) await publicFollowService.unsubscribeByToken(token);
  const t = await getTranslations('publicProjects');

  return (
    <main className="mx-auto flex max-w-[34rem] flex-col items-center gap-3 px-6 py-20 text-center">
      <span className="text-(--el-success)" aria-hidden>
        <CheckCheck className="h-8 w-8" />
      </span>
      <h1 className="font-serif text-[20px] font-bold text-(--el-text)">
        {t('unsubscribedTitle')}
      </h1>
      <p className="max-w-[42ch] text-[13.5px] leading-relaxed text-(--el-text-secondary)">
        {t('unsubscribedBody')}
      </p>
    </main>
  );
}
