'use client';

import { useRouter } from 'next/navigation';
import { CircleAlert } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { MONITORING_STATE_CARD } from './MonitoringStates';

// Panel 9's ERROR render (Story MOTIR-4928 · MOTIR-5262). Its one claim is small
// and true — nothing has changed — because a failed READ has disconnected
// nothing, and that is what a person seeing an error here needs first.
//
// Try again is `router.refresh()`: the read lives in the server page, so
// re-running the page is the retry, with no second copy of the fetch here.
export function MonitoringLoadError({
  title,
  body,
  retryLabel,
}: {
  title: string;
  body: string;
  retryLabel: string;
}) {
  const router = useRouter();
  return (
    <div role="alert" className={MONITORING_STATE_CARD}>
      <CircleAlert className="size-5 text-(--el-danger-on-surface)" aria-hidden="true" />
      <h2 className="font-serif text-lg font-semibold text-(--el-text)">{title}</h2>
      <p className="max-w-[52ch] font-sans text-[13px] leading-relaxed text-(--el-text-secondary)">
        {body}
      </p>
      <Button variant="secondary" size="sm" onClick={() => router.refresh()}>
        {retryLabel}
      </Button>
    </div>
  );
}
