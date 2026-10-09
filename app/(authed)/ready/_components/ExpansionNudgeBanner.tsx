'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ArrowRight, Sparkles, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { withPlanningOverlay } from '@/lib/planning/launcher';
import { shallowPush } from '@/lib/navigation/shallowUrl';
import type { ExpansionNudge } from '@/lib/dto/ready';

// The `/ready` expansion nudge (7.11.7 · MOTIR-904) — the cadence-side entrance
// into planning: the ready set drains, and the nudge offers to expand the
// nominated stub.
//
// ⚠️ IT IS A LAUNCHER, NOT A PLANNER (story MOTIR-5266; design MOTIR-7875,
// `design/ready/design-notes.md` § *Expand starts a planning conversation*).
// Expand opens the planning overlay over this page, on a conversation anchored
// on the stub, with "Plan <KEY>" sent for the person as its first turn — the
// overlay's start-turn launch (MOTIR-7973). The planner starts in its
// conversation phase, so a thin stub is asked what to plan instead of being
// expanded blind. Approve and decline happen on the overlay, through its own
// decide door; this banner runs no job, polls nothing and reviews nothing.
//
// The press IS the consent to spend, as a pick's yes is
// (`docs/decisions/picked-option-planning-starts.md`, MOTIR-6455).
//
// Dismiss only hides the nudge for this session: with no job behind the banner
// there is no plan for a dismissal to decline (the reason MOTIR-1740's
// decline-on-dismiss existed).

const STORAGE_KEY_PREFIX = 'motir_expansion_nudge_dismissed_';

export function ExpansionNudgeBanner() {
  const t = useTranslations('ready');
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [nudge, setNudge] = useState<ExpansionNudge | null>(null);
  const [visible, setVisible] = useState(true);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const dismissKey = nudge ? `${STORAGE_KEY_PREFIX}${nudge.nominatedKey}_${nudge.readyCount}` : '';

  useEffect(() => {
    fetch('/api/ready/nudge', { headers: { Accept: 'application/json' } })
      .then((res) => res.json())
      .then((data) => {
        if (!mountedRef.current) return;
        if (data && (data as ExpansionNudge).nominatedKey) {
          const key = `${STORAGE_KEY_PREFIX}${(data as ExpansionNudge).nominatedKey}_${(data as ExpansionNudge).readyCount}`;
          const dismissed = sessionStorage.getItem(key);
          if (!dismissed) {
            setNudge(data as ExpansionNudge);
            setVisible(true);
          }
        }
      })
      .catch(() => {});
  }, []);

  // The address the overlay opens OVER — path and query, so Close returns to the
  // same lane and filter.
  const currentHref = useMemo(() => {
    const qs = searchParams.toString();
    return `${pathname}${qs ? `?${qs}` : ''}`;
  }, [pathname, searchParams]);

  const handleDismiss = useCallback(() => {
    if (dismissKey) {
      sessionStorage.setItem(dismissKey, '1');
    }
    setVisible(false);
  }, [dismissKey]);

  // `shallowPush`: the page underneath stays as it is, and the overlay is a URL
  // the client reads (`CLAUDE.md` § *URL state the CLIENT reads*).
  const handleExpand = useCallback(
    (itemKey: string) => {
      shallowPush(
        withPlanningOverlay(currentHref, { kind: 'work-item', itemKey, startTurn: true }),
      );
    },
    [currentHref],
  );

  if (!nudge || !visible) return null;

  return (
    <Card className="bg-(--el-tint-lavender) border-(--el-border-soft)">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <Sparkles className="h-4 w-4 shrink-0 text-(--el-accent-on-surface)" aria-hidden />
          <span className="text-sm text-(--el-text-strong)">
            {t('nudge.body', {
              count: nudge.readyCount,
              key: nudge.nominatedKey,
              title: nudge.nominatedTitle,
            })}
          </span>
        </div>
        <button
          type="button"
          onClick={handleDismiss}
          className="shrink-0 p-(--spacing-icon-btn) rounded-(--radius-control) text-(--el-text-secondary) hover:text-(--el-text) hover:bg-(--el-surface-soft)"
          aria-label={t('nudge.dismissAria')}
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      </div>

      <div className="mt-3 flex items-center gap-2">
        <Button
          variant="secondary"
          size="sm"
          rightIcon={<ArrowRight className="h-3.5 w-3.5" />}
          onClick={() => handleExpand(nudge.nominatedKey)}
        >
          {t('nudge.expandLabel')}
        </Button>
        {nudge.readyCount === 0 ? (
          <span className="text-xs text-(--el-text-secondary)">{t('nudge.emptyHint')}</span>
        ) : null}
      </div>
      <p className="mt-2.5 text-xs text-(--el-text-secondary)">
        {t('nudge.expandHint', { key: nudge.nominatedKey })}
      </p>
    </Card>
  );
}
