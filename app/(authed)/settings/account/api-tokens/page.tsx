import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/auth';
import { apiTokensService } from '@/lib/services/apiTokensService';
import { ApiTokensManager } from '../_components/ApiTokensManager';

// The API tokens pane of the account-settings area (Story 7.8 · Subtask 7.8.3) —
// the Security → API tokens surface (design `account-settings.mock.html` Panels
// 3–8), the human face of the PAT substrate (7.8.1) the MCP bearer gate (7.8.4)
// consumes. A server component (session gate + the initial-list read); the
// `ApiTokensManager` client island owns the create / revoke / copy interactions
// and its own optimistic list state. Personal settings, so the gate is
// `getSession`, not a workspace context.
export default async function AccountApiTokensPage() {
  const session = await getSession();
  if (!session) redirect('/sign-in');

  const t = await getTranslations('settings.apiTokens');
  const tokens = await apiTokensService.listForUser(session.user.id);

  return (
    <div className="mx-auto flex max-w-[42rem] flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h2 className="font-serif text-2xl font-semibold text-(--el-text)">{t('heading')}</h2>
        <p className="max-w-[34rem] font-sans text-sm text-(--el-text-muted)">{t('subtitle')}</p>
      </header>

      <ApiTokensManager initialTokens={tokens} />
    </div>
  );
}
