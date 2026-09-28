'use client';

import { useTranslations } from 'next-intl';
import { RotateCw, Timer } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';

// THE RATE-LIMITED STATE (Story MOTIR-6170 · MOTIR-6648; design MOTIR-6641 panel
// 9b): past the reader's `public-read` budget, the view is replaced — inside the
// Visitor chrome, banner included — by the shipped `EmptyState`. The seconds are
// the limiter's `Retry-After`; Try again reloads the page. The budget is per
// READER (every Visitor has an account), which is what the copy says.

export function VisitorRateLimited({ retryAfterSeconds }: { retryAfterSeconds: number }) {
  const t = useTranslations('visitor.shell');
  return (
    <EmptyState
      data-testid="visitor-rate-limited"
      icon={<Timer className="h-12 w-12" aria-hidden />}
      title={t('rateLimitedTitle')}
      description={t('rateLimitedBody', { seconds: retryAfterSeconds })}
      action={
        <Button
          variant="secondary"
          leftIcon={<RotateCw className="h-4 w-4" aria-hidden />}
          onClick={() => window.location.reload()}
        >
          {t('rateLimitedRetry')}
        </Button>
      }
    />
  );
}
