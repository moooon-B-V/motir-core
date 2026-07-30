'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { buttonVariants } from '@/components/ui/Button';
import { cn } from '@/lib/utils/cn';
import { AuthShell, CodeChip, IdeaCarried } from '../../_components/AuthShell';
import { formatUserCode, normalizeUserCode } from '@/lib/cliDevice/userCode';

/**
 * State 6 of 6 — the signed-out arrival (design Panel 8, left card). The COMMON
 * real case: `motir login` opens a browser that has no Motir session.
 *
 * A STATE, not a redirect. The page names what is waiting, then hands off to
 * sign-in with the pending code encoded into `next`, so signing in returns to
 * `/device?user_code=…` rather than to an empty field — the round trip the
 * acceptance criteria require, and the one a `proxy.ts` bounce would break (it
 * carries only the pathname).
 *
 * IT SHOWS THE CODE AND NOT THE HOSTNAME, deliberately. The design's carried block
 * reads "Motir CLI on studio-mbp · code K4TP-9RXM", but the hostname can only come
 * from `GET /api/cli/device/grant`, which is session-gated AND attributed on
 * purpose — the substrate's rule is that a grant's facts are shown to the session
 * that owns it and to no one else, and the read is also what CLAIMS the code, which
 * an unauthenticated visitor must never trigger. So the pre-session banner carries
 * the one fact the URL already contains. The full four-fact inventory is the
 * confirm screen's job, after sign-in.
 */
export function DeviceSignedOut({ userCode }: { userCode: string }) {
  const t = useTranslations('device');
  const canonical = normalizeUserCode(userCode);

  // Path AND query encoded — `?next=` is read raw by the sign-in page, so the inner
  // `?user_code=` has to survive as data rather than being parsed as a second
  // parameter of the sign-in URL.
  const returnTo = canonical ? `/device?user_code=${canonical}` : '/device';
  const signInHref = `/sign-in?next=${encodeURIComponent(returnTo)}`;

  return (
    <AuthShell headline={t('heading.signedOut')} subhead={t('subhead.signedOut')}>
      <div className="flex flex-col gap-5">
        <IdeaCarried label={t('signedOut.carriedLabel')}>
          {canonical
            ? t.rich('signedOut.carriedValue', {
                code: formatUserCode(canonical),
                chip: (chunks) => <CodeChip>{chunks}</CodeChip>,
              })
            : t('signedOut.carriedNoCode')}
        </IdeaCarried>

        <p className="font-sans text-sm leading-relaxed text-(--el-text-secondary)">
          {t('signedOut.body')}
        </p>

        <Link
          href={signInHref}
          className={cn(buttonVariants({ variant: 'primary', size: 'lg' }), 'w-full')}
        >
          {t('signedOut.cta')}
        </Link>
      </div>
    </AuthShell>
  );
}
