import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { Lock } from 'lucide-react';
import { getSession } from '@/lib/auth';
import { organizationsService } from '@/lib/services/organizationsService';
import { SignOutLink } from '../two-factor-required/_components/SignOutLink';
import { SwitchOrganizationList } from './_components/SwitchOrganizationList';

/**
 * WHAT A MEMBER OF A SUSPENDED ORGANIZATION SEES — design
 * `platform-admin/design-notes.md` AMENDMENT 2026-10-03, Panel 3d (MOTIR-752;
 * the gate that sends people here is MOTIR-748's `redirectIfOrganizationSuspended`).
 * A calm refusal with a lock, never a 500: the organization is named, nothing
 * has been deleted, and who to talk to.
 *
 * ⚠️ IT LIVES IN `(auth)`, OUTSIDE `(authed)`, ON PURPOSE. The `(authed)` layout
 * is the gate that redirects here; a page under it would be redirected to itself.
 * `(auth)`'s layout is a pure frame that reads no session (the
 * `/two-factor-required` precedent), so the page protects itself: an anonymous
 * visitor goes to sign-in.
 *
 * ⚠️ IT NAMES ONLY WHAT THE READER MAY KNOW. `?org=` is a URL a person can edit,
 * so the organization is named only when the reader belongs to it and it IS
 * suspended (`getSuspensionNotice` reads under the reader's own RLS context);
 * otherwise the page says the organization is not available, and names nothing.
 *
 * ⚠️ AND IT OFFERS A WAY OUT. A member of another, open organization is offered
 * the switch — the pinned cookie would otherwise keep sending them back here.
 * No `loading.tsx`: there is nothing slow enough to frame.
 */

export const metadata: Metadata = {
  title: 'Organization suspended',
};

export const dynamic = 'force-dynamic';

export default async function OrganizationSuspendedPage({
  searchParams,
}: {
  searchParams: Promise<{ org?: string }>;
}) {
  const session = await getSession();
  if (!session) redirect('/sign-in');

  const { org } = await searchParams;
  const notice = await organizationsService.getSuspensionNotice(session.user.id, org ?? null);
  const t = await getTranslations('platformAdmin.member.suspended');
  const alternatives = notice.alternatives.filter((o) => o.id !== notice.organization?.id);

  return (
    <section className="flex flex-col gap-6" data-testid="organization-suspended">
      <header className="flex flex-col gap-3">
        <span
          aria-hidden
          className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-(--el-tint-rose)"
        >
          <Lock className="h-5 w-5 text-(--el-danger)" />
        </span>
        <h1 className="font-serif text-3xl font-semibold leading-tight tracking-tight text-(--el-text)">
          {notice.organization ? t('title', { org: notice.organization.name }) : t('unknownTitle')}
        </h1>
        <p className="font-sans text-base text-(--el-text-secondary)">
          {notice.organization ? t('body') : t('unknownBody')}
        </p>
      </header>

      {alternatives.length > 0 ? (
        <div className="flex flex-col gap-3">
          <h2 className="font-sans text-sm font-semibold text-(--el-text)">{t('switchTitle')}</h2>
          <SwitchOrganizationList organizations={alternatives} />
        </div>
      ) : null}

      <div className="self-start">
        <SignOutLink label={t('signOut')} />
      </div>
    </section>
  );
}
