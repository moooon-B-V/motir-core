import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/auth';
import { usersService } from '@/lib/services/usersService';
import { Card } from '@/components/ui/Card';
import { ProfileCard } from '../_components/ProfileCard';
import { PasswordSecurityCard } from '../_components/PasswordSecurityCard';

// The Profile pane of the account-settings area (Story 8.8 · Subtask 8.8.24, the
// scaffold). Flips the reserved `General › Profile` "Soon" slot into a real route
// and renders the personal-details card (name inline-edit + email display) per
// `design/settings/profile.mock.html`, plus the avatar (8.8.24a) and the
// Password & security card (8.8.24c, branched on `hasPassword`). Email-change
// (8.8.24b) is the remaining sibling slice that composes into this pane. A server
// component: the session gate here, the data read behind a
// Suspense boundary so the pane streams in with a skeleton (the design's loading
// state); ProfileCard is the client island that owns the inline-edit state.
export default async function AccountProfilePage() {
  const session = await getSession();
  if (!session) redirect('/sign-in');

  const t = await getTranslations('settings.profile');

  return (
    <div className="mx-auto flex max-w-[42rem] flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h2 className="font-serif text-2xl font-semibold text-(--el-text)">{t('heading')}</h2>
        <p className="max-w-[34rem] font-sans text-sm text-(--el-text-muted)">{t('subtitle')}</p>
      </header>

      <Suspense
        fallback={<ProfilePaneSkeleton title={t('card.title')} subtitle={t('card.subtitle')} />}
      >
        <ProfilePane userId={session.user.id} />
      </Suspense>
    </div>
  );
}

/** Reads the session user's profile and renders the editable card. Split out so
 *  it suspends behind the boundary above (the DB read is the only async work). */
async function ProfilePane({ userId }: { userId: string }) {
  const [profile, { hasPassword }] = await Promise.all([
    usersService.getProfile(userId),
    usersService.getPasswordCapability(userId),
  ]);
  if (!profile) redirect('/sign-in');
  return (
    <>
      <ProfileCard initialName={profile.name} initialImage={profile.image} email={profile.email} />
      <PasswordSecurityCard hasPassword={hasPassword} />
    </>
  );
}

/** The loading state — a titled Card with shimmer rows mirroring the Photo +
 *  Name + Email rows (the design's skeleton panel: a circular avatar
 *  placeholder over two text rows). */
function ProfilePaneSkeleton({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <Card
      aria-busy
      header={
        <div>
          <h3 className="font-sans text-base font-semibold text-(--el-text)">{title}</h3>
          <p className="mt-0.5 font-sans text-sm text-(--el-text-muted)">{subtitle}</p>
        </div>
      }
    >
      <div className="flex items-center justify-between gap-4 pb-4">
        <div className="flex flex-col gap-1.5">
          <span className="h-3.5 w-16 animate-pulse rounded-(--radius-control) bg-(--el-muted)" />
          <span className="h-3 w-72 animate-pulse rounded-(--radius-control) bg-(--el-muted)" />
        </div>
        <span className="h-[52px] w-[52px] shrink-0 animate-pulse rounded-full bg-(--el-muted)" />
      </div>
      <div className="flex items-center justify-between gap-4 border-t border-(--el-border-soft) pb-4 pt-4">
        <div className="flex flex-col gap-1.5">
          <span className="h-3.5 w-16 animate-pulse rounded-(--radius-control) bg-(--el-muted)" />
          <span className="h-3 w-56 animate-pulse rounded-(--radius-control) bg-(--el-muted)" />
        </div>
        <span className="h-4 w-28 animate-pulse rounded-(--radius-control) bg-(--el-muted)" />
      </div>
      <div className="flex items-center justify-between gap-4 border-t border-(--el-border-soft) pt-4">
        <div className="flex flex-col gap-1.5">
          <span className="h-3.5 w-16 animate-pulse rounded-(--radius-control) bg-(--el-muted)" />
          <span className="h-3 w-64 animate-pulse rounded-(--radius-control) bg-(--el-muted)" />
        </div>
        <span className="h-4 w-40 animate-pulse rounded-(--radius-control) bg-(--el-muted)" />
      </div>
    </Card>
  );
}
