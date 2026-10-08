'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Segmented } from '@/components/ui/Segmented';
import {
  ENTERPRISE_REQUEST_FILTERS,
  type EnterpriseRequestFilter,
} from '@/lib/dto/platformEnterpriseRequest';
import { requestListHref } from './requestListQuery';

/**
 * The list's STATE FILTER — design § Enterprise requests Panels 1–3: the shipped
 * `Segmented`, **Open** (the default) · New · Contacted · Offer sent · Won · Lost
 * · All, each segment carrying its count. A filter is a different query, so the
 * server must answer it: `router.push`, and the pager starts over.
 *
 * `counts` is absent while the read is in flight (Panel 3a): the segments paint
 * at once and carry no number until the read lands — no count is guessed.
 */
export function RequestStateFilter({
  value,
  counts,
}: {
  value: EnterpriseRequestFilter;
  counts?: Record<EnterpriseRequestFilter, number>;
}) {
  const t = useTranslations('platformAdmin.enterpriseRequests');
  const router = useRouter();

  const label = (filter: EnterpriseRequestFilter) =>
    filter === 'open' || filter === 'all' ? t(`filter.${filter}`) : t(`status.${filter}`);

  return (
    <div data-testid="enterprise-requests-filter" className="flex flex-wrap">
      <Segmented<EnterpriseRequestFilter>
        label={t('filterLabel')}
        value={value}
        onChange={(next) => router.push(requestListHref({ filter: next }))}
        className="flex-wrap"
        options={ENTERPRISE_REQUEST_FILTERS.map((filter) => ({
          value: filter,
          label: label(filter),
          trailing: counts ? counts[filter] : undefined,
        }))}
      />
    </div>
  );
}
