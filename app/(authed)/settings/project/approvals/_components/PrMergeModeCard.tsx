'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { GitMerge, User, Zap, type LucideIcon } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { useToast } from '@/components/ui/Toast';
import { PR_MERGE_MODE_VALUES, type PrMergeModeValue } from '@/lib/dto/projects';

// The MERGE-MODE card (Story MOTIR-4880 · Subtask MOTIR-5181), built to
// `design/projects/approvals.mock.html` panels 6 (`manual`), 7 (`auto`) and 8 (the
// `#merge-mode` arrival), with the copy from `design-notes.md` § ⭐ Approvals §7.
//
// A choice between two DESCRIBED modes, so it is the access-level radio-card
// grammar (`ProjectMembersSettings`), not a copy of the acceptance-video switch
// beside it: each option carries the sentence a switch cannot. Both hints open on
// "When its checks pass", because that is the only moment a merge is on the table
// in either mode.
//
// A pure client consumer of `PATCH /api/projects/[key]/pr-merge-mode`. Applied on
// change, reconciled from the response, and put BACK on failure — the room's
// switch idiom. A person's choice is stamped decided by the service, so the
// establishment default never overwrites it.
//
// ⚠️ INK. Title `--el-text`; description and hints `--el-text-secondary`, never
// `--el-text-muted` (fails AA on these surfaces).
//
// NO NOT-YET NOTICE (MOTIR-5539). The card once carried "Motir does not merge pull
// requests yet"; MOTIR-4882 made Motir merge on this setting, so it was removed as
// the design notes (§ Approvals §7) always said it would be. The two hints are the
// whole account — do not add a caveat back without a design.
//
// MANAGE-ONLY. There is no read-only state (Yue, 2026-09-13): the room admits only
// `workflow:manage`, so every actor who renders this card may change it.

export const MERGE_MODE_ANCHOR = 'merge-mode';

const OPTION_ICON: Record<PrMergeModeValue, LucideIcon> = { manual: User, auto: Zap };
const OPTION_TINT: Record<PrMergeModeValue, string> = {
  manual: 'bg-(--el-tint-sky)',
  auto: 'bg-(--el-tint-mint)',
};

export interface PrMergeModeCardProps {
  /** The project's `MOTIR`-style identifier — the key the route is addressed by. */
  projectKey: string;
  initialMode: PrMergeModeValue;
}

export function PrMergeModeCard({ projectKey, initialMode }: PrMergeModeCardProps) {
  const t = useTranslations('approvals.mergeMode');
  const { toast } = useToast();
  const [mode, setMode] = useState<PrMergeModeValue>(initialMode);
  const [isPending, startTransition] = useTransition();
  const [arrived, setArrived] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);

  // Panel 8: arriving at `#merge-mode` scrolls the card into view and gives it the
  // ordinary focus ring ONCE — not a tint, not a flash. The ring clears the first
  // time focus leaves the card.
  useEffect(() => {
    if (window.location.hash !== `#${MERGE_MODE_ANCHOR}`) return;
    const el = cardRef.current;
    if (!el) return;
    el.scrollIntoView?.({ block: 'start' });
    el.focus({ preventScroll: true });
    setArrived(true);
  }, []);

  function choose(next: PrMergeModeValue) {
    if (next === mode) return;
    const previous = mode;
    setMode(next);
    startTransition(async () => {
      try {
        const res = await fetch(`/api/projects/${encodeURIComponent(projectKey)}/pr-merge-mode`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ prMergeMode: next }),
        });
        if (!res.ok) throw new Error(`PATCH failed: ${res.status}`);
        const result = (await res.json()) as { prMergeMode: PrMergeModeValue };
        setMode(result.prMergeMode);
        toast({ variant: 'success', title: t('saved') });
      } catch {
        setMode(previous);
        toast({ variant: 'error', title: t('saveError') });
      }
    });
  }

  return (
    <div
      id={MERGE_MODE_ANCHOR}
      ref={cardRef}
      tabIndex={-1}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setArrived(false);
      }}
      className={`scroll-mt-6 rounded-(--radius-card) focus:outline-none ${
        arrived ? 'ring-(--focus-ring-color) ring-2' : ''
      }`}
    >
      <Card
        header={
          <div>
            <h2 className="flex items-center gap-2 font-sans text-base font-semibold text-(--el-text)">
              <GitMerge className="size-4" aria-hidden />
              {t('title')}
            </h2>
            <p className="text-(--el-text-secondary) font-sans text-sm">
              {t.rich('desc', { strong: (chunks) => <strong>{chunks}</strong> })}
            </p>
          </div>
        }
      >
        <div className="flex flex-col gap-3">
          <div role="radiogroup" aria-label={t('title')} className="flex flex-col gap-2">
            {PR_MERGE_MODE_VALUES.map((value) => {
              const Icon = OPTION_ICON[value];
              const selected = mode === value;
              return (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  disabled={isPending}
                  onClick={() => choose(value)}
                  className={`focus-visible:ring-(--focus-ring-color) enabled:hover:border-(--el-border-strong) flex items-center gap-3 rounded-(--radius-card) border p-(--spacing-card-padding) text-left focus-visible:outline-none focus-visible:ring-2 disabled:cursor-default ${
                    selected ? 'border-(--el-accent)' : 'border-(--el-border)'
                  }`}
                >
                  <span
                    className={`inline-flex size-9 shrink-0 items-center justify-center rounded-(--radius-control) text-(--el-text-strong) ${OPTION_TINT[value]}`}
                    aria-hidden
                  >
                    <Icon className="size-5" />
                  </span>
                  <span className="flex flex-1 flex-col gap-0.5">
                    <span className="font-sans text-sm font-medium text-(--el-text)">
                      {t(`${value}.label`)}
                    </span>
                    <span className="text-(--el-text-secondary) font-sans text-xs">
                      {t(`${value}.hint`)}
                    </span>
                  </span>
                  <span
                    className={`inline-flex size-4 shrink-0 items-center justify-center rounded-full border ${
                      selected ? 'border-(--el-accent)' : 'border-(--el-border-strong)'
                    }`}
                    aria-hidden
                  >
                    {selected ? <span className="size-2 rounded-full bg-(--el-accent)" /> : null}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </Card>
    </div>
  );
}
