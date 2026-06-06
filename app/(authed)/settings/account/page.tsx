import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/auth';
import { LanguageCard } from './_components/LanguageCard';

// Account settings — the user's PERSONAL preferences (distinct from the
// workspace- and project-scoped settings pages). Ships with the Language
// preference; future per-user settings (display name, theme default, …) slot in
// as additional cards here. A server component: it only gates the session, the
// cards own their own state + mutations.
export default async function AccountSettingsPage() {
  const session = await getSession();
  if (!session) redirect('/sign-in');

  const t = await getTranslations('settings');

  return (
    <div className="mx-auto flex max-w-[42rem] flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="font-serif text-3xl font-semibold text-(--el-text)">{t('account.title')}</h1>
        <p className="text-(--el-text-muted) font-sans text-sm">{t('account.subtitle')}</p>
      </header>

      <LanguageCard />
    </div>
  );
}
