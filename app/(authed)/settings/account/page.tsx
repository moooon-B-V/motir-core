import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/auth';
import { notificationPreferencesService } from '@/lib/services/notificationPreferencesService';
import { LanguageCard } from './_components/LanguageCard';
import { NotificationPreferencesCard } from './_components/NotificationPreferencesCard';

// Account settings — the user's PERSONAL preferences (distinct from the
// workspace- and project-scoped settings pages). Ships with the Language
// preference + the notification-preferences matrix (Story 5.7 · 5.7.6); future
// per-user settings (display name, theme default, …) slot in as additional
// cards here. A server component (services only — 4-layer): it gates the
// session and reads the initial matrix; the cards own their own state +
// mutations.
export default async function AccountSettingsPage() {
  const session = await getSession();
  if (!session) redirect('/sign-in');

  const t = await getTranslations('settings');
  const notificationMatrix = await notificationPreferencesService.getMatrix(session.user.id);

  return (
    <div className="mx-auto flex max-w-[42rem] flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="font-serif text-3xl font-semibold text-(--el-text)">{t('account.title')}</h1>
        <p className="text-(--el-text-muted) font-sans text-sm">{t('account.subtitle')}</p>
      </header>

      <LanguageCard />
      <NotificationPreferencesCard initial={notificationMatrix} />
    </div>
  );
}
