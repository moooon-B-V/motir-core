import { useTranslations } from 'next-intl';
import type { EnterpriseRequestFilter } from '@/lib/dto/platformEnterpriseRequest';
import { RequestsCardFrame } from './EnterpriseRequestsCard';

/**
 * The list's LOADING frame — design § Enterprise requests Panel 3a. The page
 * header is static copy and already painted above this frame; the card, its
 * title and the filter paint at once, four skeleton rows wait, and NO count is
 * guessed — the count line says only "Newest first." and the segments carry no
 * number until the read lands.
 */
export function EnterpriseRequestsSkeleton({ filter }: { filter: EnterpriseRequestFilter }) {
  const t = useTranslations('platformAdmin.enterpriseRequests');
  return (
    <RequestsCardFrame filter={filter} countLine={t('count.loading')}>
      <div aria-busy="true" data-testid="enterprise-requests-loading" className="flex flex-col">
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            className="flex items-start gap-6 border-b border-(--el-border-soft) py-3 last:border-b-0"
          >
            <div className="flex flex-col gap-2">
              <Block className="h-3 w-36" />
              <Block className="h-2.5 w-24" />
            </div>
            <div className="hidden flex-col gap-2 md:flex">
              <Block className="h-2.5 w-28" />
              <Block className="h-2.5 w-36" />
            </div>
            <Block className="hidden h-2.5 w-20 md:block" />
            <Block className="hidden h-2.5 w-48 md:block" />
            <Block className="h-2.5 w-16" />
          </div>
        ))}
      </div>
    </RequestsCardFrame>
  );
}

function Block({ className }: { className: string }) {
  return <div className={`rounded-(--radius-control) bg-(--el-muted) ${className}`} />;
}
