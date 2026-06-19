import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/auth';
import { AppearanceCard } from '../_components/AppearanceCard';

// The Appearance pane of the account-settings area (Story 7.3 · Subtask 7.3.58) —
// Motir's three-axis design system (theme × style × palette × type) turned on
// itself: the signed-in user themes the Motir app, live. Flipping the reserved
// `appearance` "Soon" slot (7.8.2) to a real route here keeps the route↔registry
// totality test green by construction (the entry drops its `placeholder`).
//
// A server component (session gate only); the AppearanceCard is the client island
// that reads/writes the ThemeProvider — picking re-skins instantly via
// localStorage → <html>, with no server write (the inline-edit-no-refresh
// preference contract). The page-head frames the pane like the Language pane.
export default async function AccountAppearancePage() {
  const session = await getSession();
  if (!session) redirect('/sign-in');

  const t = await getTranslations('settings.appearance');

  return (
    <div className="mx-auto flex max-w-[42rem] flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h2 className="font-serif text-2xl font-semibold text-(--el-text)">{t('heading')}</h2>
        <p className="max-w-[34rem] font-sans text-sm text-(--el-text-muted)">{t('subtitle')}</p>
      </header>

      <AppearanceCard />
    </div>
  );
}
