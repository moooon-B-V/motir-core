'use client';

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/Button';

/**
 * "Verify again" (design Panel 6). The integrity line and the per-row markers
 * are SERVER-rendered from one verification, so re-checking is a server re-read
 * of the page (`router.refresh()`) — the page-state contract's case 2. The
 * check is itself an audited `audit.verify`.
 */
export function VerifyAgainButton({ label }: { label: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <Button
      size="sm"
      variant="secondary"
      loading={pending}
      leftIcon={<RefreshCw aria-hidden className="h-4 w-4" />}
      onClick={() => startTransition(() => router.refresh())}
      data-testid="audit-verify-again"
    >
      {label}
    </Button>
  );
}
