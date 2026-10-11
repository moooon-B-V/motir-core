import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/auth';
import { orgCan } from '@/lib/organizations/capabilities';
import { resolveActiveOrganizationAsShell } from '@/lib/workspaces/tierDisclosure.server';
import { LanguageCard } from '../_components/LanguageCard';

// The Language pane of the account-settings area (Story 7.8 · Subtask 7.8.12).
// The shipped Language preference (the NEXT_LOCALE cookie via setLocale), now in
// its own route/pane inside the area — behaviour unchanged, only its host pane.
// The page-head frames the pane (the design's `page-head`); the LanguageCard
// owns its own client state + mutation. A server component (session gate only —
// the card is the client island).
//
// It also shows the ACTIVE organisation's content language, read-only
// (MOTIR-8095 · `design/org-admin/org-admin--content-language.mock.html` panel
// 2): a plain member has no door to the org General card, so this is where they
// read it; an owner or admin gets a link back to the control.
export default async function AccountLanguagePage() {
  const session = await getSession();
  if (!session) redirect('/sign-in');

  const [t, { currentOrg }] = await Promise.all([
    getTranslations('settings.language'),
    resolveActiveOrganizationAsShell(session.user.id),
  ]);

  return (
    <div className="mx-auto flex max-w-[42rem] flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h2 className="font-serif text-2xl font-semibold text-(--el-text)">{t('heading')}</h2>
        <p className="max-w-[34rem] font-sans text-sm text-(--el-text-muted)">{t('subtitle')}</p>
      </header>

      <LanguageCard
        contentLanguage={
          currentOrg
            ? {
                orgName: currentOrg.organization.name,
                language: currentOrg.organization.contentLanguage,
                canChange: orgCan(currentOrg.role, 'manageOrgSettings'),
              }
            : null
        }
      />
    </div>
  );
}
