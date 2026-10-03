'use client';

import { useState, useTransition, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Search } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Combobox, type ComboboxOption } from '@/components/ui/Combobox';
import { Input } from '@/components/ui/Input';
import { Segmented } from '@/components/ui/Segmented';
import { auditLogHref, hasFilters, type AuditLogQuery } from './auditLogUrl';

/**
 * The audit log's FILTERS — design Panel 6: free text over reasons and targets,
 * operator, tenant, action, a date range, and Writes / Writes & reads (default
 * Writes). Applying one is a NEW QUERY the server must answer, so it is a
 * `router.push` (CLAUDE.md § URL state), and it always drops the page position.
 *
 * Operator and tenant take an id: the console has no cross-estate people/org
 * picker to hang a `Combobox` on yet, and an operator arrives here from a user
 * or org page that already shows the id (the org page's "Open in the audit log"
 * fills the tenant for them).
 */
/** The "Any action" option — no action key contains a `*`. */
const ANY_ACTION = '*';

export function AuditLogFilters({
  query,
  actions,
}: {
  query: AuditLogQuery;
  /** Every action key the vocabulary knows. */
  actions: readonly string[];
}) {
  const t = useTranslations('platformAdmin.audit');
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [draft, setDraft] = useState({
    q: query.q,
    actor: query.actor,
    org: query.org,
    action: query.action,
    from: query.from,
    to: query.to,
  });

  function go(next: Partial<AuditLogQuery>) {
    startTransition(() => {
      router.push(auditLogHref({ ...query, ...draft, ...next, cursors: [], entry: null }));
    });
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    go({});
  }

  const actionOptions: ComboboxOption<string>[] = [
    { value: ANY_ACTION, label: t('filter.anyAction') },
    ...actions.map((a) => ({ value: a, label: a })),
  ];

  return (
    <form
      onSubmit={submit}
      aria-label={t('filter.label')}
      className="flex flex-col gap-3"
      data-testid="audit-filters"
    >
      <div className="grid gap-3 md:grid-cols-3">
        <Input
          label={t('filter.text')}
          value={draft.q}
          onChange={(e) => setDraft({ ...draft, q: e.target.value })}
          addonStart={<Search aria-hidden className="h-4 w-4" />}
          maxLength={200}
        />
        <Input
          label={t('filter.operator')}
          placeholder={t('filter.operatorPlaceholder')}
          value={draft.actor}
          onChange={(e) => setDraft({ ...draft, actor: e.target.value })}
          spellCheck={false}
        />
        <Input
          label={t('filter.tenant')}
          placeholder={t('filter.tenantPlaceholder')}
          value={draft.org}
          onChange={(e) => setDraft({ ...draft, org: e.target.value })}
          spellCheck={false}
        />
        <Combobox
          label={t('filter.action')}
          options={actionOptions}
          value={draft.action || ANY_ACTION}
          onChange={(action) => setDraft({ ...draft, action: action === ANY_ACTION ? '' : action })}
          searchable
        />
        <Input
          type="date"
          label={t('filter.from')}
          value={draft.from}
          onChange={(e) => setDraft({ ...draft, from: e.target.value })}
        />
        <Input
          type="date"
          label={t('filter.to')}
          value={draft.to}
          onChange={(e) => setDraft({ ...draft, to: e.target.value })}
        />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Segmented
          label={t('filter.scope')}
          value={query.scope}
          onChange={(scope) => go({ scope })}
          options={[
            { value: 'writes', label: t('filter.writes') },
            { value: 'all', label: t('filter.writesReads') },
          ]}
        />
        <div className="flex items-center gap-3">
          {hasFilters(query) ? (
            <Link
              href={auditLogHref({ scope: query.scope })}
              className="font-sans text-sm text-(--el-accent-on-surface) hover:underline"
            >
              {t('clear')}
            </Link>
          ) : null}
          <Button type="submit" variant="secondary" loading={pending}>
            {t('filter.apply')}
          </Button>
        </div>
      </div>
    </form>
  );
}
