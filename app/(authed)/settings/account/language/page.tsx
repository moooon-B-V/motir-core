import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/auth';
import { LanguageCard } from '../_components/LanguageCard';

// The Language pane of the account-settings area (Story 7.8 · Subtask 7.8.12).
// The shipped Language preference (the NEXT_LOCALE cookie via setLocale), now in
// its own route/pane inside the area — behaviour unchanged, only its host pane.
// The page-head frames the pane (the design's `page-head`); the LanguageCard
// owns its own client state + mutation. A server component (session gate only —
// the card is the client island).
export default async function AccountLanguagePage() {
  const session = await getSession();
  if (!session) redirect('/sign-in');

  const t = await getTranslations('settings.language');

  return (
    <div className="mx-auto flex max-w-[42rem] flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h2 className="font-serif text-2xl font-semibold text-(--el-text)">{t('heading')}</h2>
        <p className="max-w-[34rem] font-sans text-sm text-(--el-text-muted)">{t('subtitle')}</p>
      </header>

      <LanguageCard />
    </div>
  );
}
