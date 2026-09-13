'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Segmented } from '@/components/ui/Segmented';
import type { StoppedReasonFilter as Filter } from '@/lib/dto/platformIndexAllowance';

/**
 * The Stopped orgs REASON filter (MOTIR-4595, design Panel 13 rev 2) — the shipped
 * `Segmented`, each option carrying its count, driving the `reason` URL parameter so
 * the list stays a server-paged read. Changing the filter returns to page 1.
 *
 * The margin-ceiling option is drawn DISABLED, never omitted: hard gate B is not
 * active yet (MOTIR-5280), and a missing option would read as "no such stop".
 */
export function StoppedReasonFilter({
  value,
  counts,
  labels,
}: {
  value: Filter;
  counts: { all: number; noCredit: number; allowanceExhausted: number };
  labels: {
    group: string;
    all: string;
    noCredit: string;
    allowanceExhausted: string;
    margin: string;
    marginInactive: string;
    marginInactiveHint: string;
  };
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const go = (next: Filter | 'margin') => {
    if (next === 'margin') return;
    const query = new URLSearchParams(params.toString());
    if (next === 'all') query.delete('reason');
    else query.set('reason', next);
    query.delete('page');
    const qs = query.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };

  return (
    <Segmented<Filter | 'margin'>
      label={labels.group}
      value={value}
      onChange={go}
      options={[
        { value: 'all', label: labels.all, trailing: counts.all },
        { value: 'no_credit', label: labels.noCredit, trailing: counts.noCredit },
        {
          value: 'allowance_exhausted',
          label: labels.allowanceExhausted,
          trailing: counts.allowanceExhausted,
        },
        {
          value: 'margin',
          label: labels.margin,
          trailing: <em className="font-medium">{labels.marginInactive}</em>,
          disabled: true,
          title: labels.marginInactiveHint,
        },
      ]}
    />
  );
}
