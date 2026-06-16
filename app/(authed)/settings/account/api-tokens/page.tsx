import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/auth';
import { getWorkspaceContext } from '@/lib/workspaces';
import { apiTokensService } from '@/lib/services/apiTokensService';
import { ApiTokensManager } from '../_components/ApiTokensManager';

// The API tokens pane of the account-settings area (Story 7.8 · Subtask 7.8.3) —
// the Security → API tokens surface (design `account-settings.mock.html` Panels
// 3–8), the human face of the PAT substrate (7.8.1) the MCP bearer gate (7.8.4)
// consumes. A server component (gate + the initial reads); the `ApiTokensManager`
// client island owns the create / revoke / copy interactions and its own
// optimistic list state. Account-level: it lists ALL the user's tokens across
// their workspaces (each row labelled with the org → workspace it is bound to,
// bug 7.21). The create modal scopes a new token to a chosen workspace, so the
// page also loads the user's org → workspace tree + the active workspace to
// pre-select.
export default async function AccountApiTokensPage() {
  const session = await getSession();
  if (!session) redirect('/sign-in');

  const t = await getTranslations('settings.apiTokens');
  const [tokens, scopeOrgs, ctx] = await Promise.all([
    apiTokensService.listForUser(session.user.id),
    apiTokensService.listScopeOptions(session.user.id),
    getWorkspaceContext(),
  ]);

  // The tokens TABLE is wide (8 columns incl. the 7.7.19 Scopes column), so this
  // pane uses the table-pane width (the workspace-jobs precedent), NOT the 42rem
  // form-pane width its sibling account panes (language / notifications) use —
  // the design's token list panel is ~1180px. The header copy stays narrow for
  // reading (its own max-w below).
  return (
    <div className="mx-auto flex max-w-[64rem] flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h2 className="font-serif text-2xl font-semibold text-(--el-text)">{t('heading')}</h2>
        <p className="max-w-[34rem] font-sans text-sm text-(--el-text-muted)">{t('subtitle')}</p>
      </header>

      <ApiTokensManager
        initialTokens={tokens}
        scopeOrgs={scopeOrgs}
        activeWorkspaceId={ctx?.workspaceId ?? null}
      />
    </div>
  );
}
