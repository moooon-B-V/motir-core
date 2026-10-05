import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import { Clock } from 'lucide-react';
import { buttonVariants } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { requirePlatformStaffPage } from '@/lib/platform/pageGate';
import { impersonationService } from '@/lib/services/impersonationService';

/**
 * THE SESSION-ENDED PAGE — design `platform-admin/design-notes.md` § AMENDMENT
 * 2026-10-03, Panel 5c (Story 10.3 · MOTIR-749).
 *
 * Where Exit session lands, and where a request carrying a session that is over
 * (the time-box ran out, or it was revoked) is sent once
 * `/api/staff-session/clear` has recorded its end and cleared the cookie. Inside
 * the console, so it renders under the operator's OWN identity and the console's
 * 404 posture; it shows only the operator's own sessions (anybody else's id, or
 * an unknown one, is the ordinary 404 — `getOwnSession` returns null).
 *
 * **Back to the console** · **Start a new session** — the second goes to the
 * account's page, where the dialog asks for a NEW reason (a session is never
 * extended).
 */

export const metadata: Metadata = { title: 'Staff session ended' };
export const dynamic = 'force-dynamic';

export default async function StaffSessionEndedPage({
  searchParams,
}: {
  searchParams: Promise<{ session?: string }>;
}) {
  const principal = await requirePlatformStaffPage('support');
  const { session: sessionId } = await searchParams;
  if (!sessionId) notFound();
  const session = await impersonationService.getOwnSession(principal, sessionId);
  if (!session) notFound();

  const t = await getTranslations('platformAdmin.imp');
  const format = await getFormatter();
  // The console formats in UTC (`i18n/request.ts`), and says so.
  const time = `${format.dateTime(new Date(session.endedAt ?? session.expiresAt), {
    hour: '2-digit',
    minute: '2-digit',
  })} UTC`;

  return (
    <div className="mx-auto flex max-w-[40rem] flex-col gap-4 px-6 py-12">
      <EmptyState
        icon={<Clock aria-hidden className="h-6 w-6 text-(--el-text-secondary)" />}
        title={t('ended.title', { time })}
        description={
          <>
            {t('ended.body', { name: session.targetName })}{' '}
            {session.endedBy ? t(`ended.endedBy.${session.endedBy}`) : null}
          </>
        }
        action={
          <div className="flex flex-wrap justify-center gap-2">
            <Link href="/admin" className={buttonVariants({ variant: 'primary', size: 'md' })}>
              {t('ended.back')}
            </Link>
            <Link
              href={`/admin/users/${encodeURIComponent(session.targetUserId)}`}
              className={buttonVariants({ variant: 'secondary', size: 'md' })}
            >
              {t('ended.again')}
            </Link>
          </div>
        }
      />
    </div>
  );
}
