'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { ArrowRight, CircleAlert, Languages, RotateCw, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Spinner } from '@/components/ui/Spinner';
import { useTranslationContext } from './TranslationProvider';

// THE TRANSLATION BAR (Story MOTIR-7735 · Subtask MOTIR-8122; design MOTIR-8112
// § *Entry and access path*, § *States — item scope*, § *Element table*). ONE
// control per item, directly under the title, in both hosts.
//
// ⚠️ THE BUTTON IS ONE ELEMENT THROUGH EVERY STATE. Translate → Translating… →
// Show original / Show translation, and Retry in the same slot, so focus stays
// on it after a press. Busy is `aria-disabled` + `aria-busy`, never `disabled`,
// which would drop focus. Only no-credit removes it (D6), and then focus moves
// to the message, which takes `tabIndex={-1}`.

const HINT = 'font-sans text-[13px] text-(--el-text-secondary)';
const MESSAGE =
  'flex min-w-0 items-start gap-1.5 font-sans text-[13px] leading-snug text-(--el-text)';
const GLYPH = 'h-3.5 w-3.5';

/** The no-credit message: everyone's line, and the link or the member's addition. */
function NoCreditMessage({ canAddCredits }: { canAddCredits: boolean }) {
  const t = useTranslations('itemTranslation');
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    // The button this replaced held focus after the press; hand it here.
    if (document.activeElement === document.body || document.activeElement === null) {
      ref.current?.focus();
    }
  }, []);
  return (
    <span ref={ref} tabIndex={-1} className={MESSAGE} data-translation-message="no-credit">
      <CircleAlert className={`mt-0.5 ${GLYPH} shrink-0 text-(--el-text-secondary)`} aria-hidden />
      <span>
        {t('noCredits')}{' '}
        {canAddCredits ? (
          <Link
            href="/settings/organization/billing"
            className="inline-flex items-center gap-1 font-medium text-(--el-link) underline"
          >
            {t('addCredits')}
            <ArrowRight className={GLYPH} aria-hidden />
          </Link>
        ) : (
          t('noCreditsMember')
        )}
      </span>
    </span>
  );
}

/** The button's label, glyph and ARIA for the current phase. */
function useControlFace() {
  const t = useTranslations('itemTranslation');
  const ctx = useTranslationContext()!;
  const { phase, state, languageName } = ctx;
  const showing = state.view === 'translated';
  if (phase.kind === 'busy') {
    return {
      label: t('translating'),
      icon: <Spinner size="sm" aria-hidden className={`${GLYPH} border-[1.5px]`} />,
      aria: { 'aria-disabled': true, 'aria-busy': true } as const,
      hint: <span className={HINT}>{t('hintInto', { language: languageName })}</span>,
      onPress: () => undefined,
    };
  }
  if (phase.kind === 'translated') {
    const hint = !showing
      ? t('hintShowingOriginal')
      : phase.failedCount > 0
        ? t('hintPartial', { language: languageName, n: phase.failedCount })
        : t('hintTranslated', { language: languageName });
    return {
      label: showing ? t('showOriginal') : t('showTranslation'),
      icon: <Languages className={GLYPH} aria-hidden />,
      aria: { 'aria-pressed': showing } as const,
      hint: <span className={HINT}>{hint}</span>,
      onPress: () => ctx.setView(showing ? 'original' : 'translated'),
    };
  }
  return phase.kind === 'failed' ? failedFace(t, ctx.translate) : offeredFace(t, ctx);
}

function failedFace(t: ReturnType<typeof useTranslations>, translate: () => void) {
  return {
    label: t('retry'),
    icon: <RotateCw className={GLYPH} aria-hidden />,
    aria: {} as const,
    hint: (
      <span className={MESSAGE} data-translation-message="failed">
        <TriangleAlert
          className={`mt-0.5 ${GLYPH} shrink-0 text-(--el-danger-on-surface)`}
          aria-hidden
        />
        <span>{t('failedItem')}</span>
      </span>
    ),
    onPress: translate,
  };
}

function offeredFace(
  t: ReturnType<typeof useTranslations>,
  ctx: NonNullable<ReturnType<typeof useTranslationContext>>,
) {
  return {
    label: t('translate'),
    icon: <Languages className={GLYPH} aria-hidden />,
    aria: {} as const,
    hint: <span className={HINT}>{t('hintInto', { language: ctx.languageName })}</span>,
    onPress: ctx.translate,
  };
}

function Bar({ phase, children }: { phase: string; children: ReactNode }) {
  const t = useTranslations('itemTranslation');
  return (
    <div
      role="group"
      aria-label={t('groupLabel')}
      data-translation-bar={phase}
      className="flex min-h-(--height-btn-sm) flex-wrap items-center gap-x-3 gap-y-1.5"
    >
      {children}
    </div>
  );
}

/**
 * The bar, or NOTHING: no provider (the public page), or no field of this host
 * differs from the reader's language — no disabled button, no explanation.
 */
export function TranslateControl() {
  const ctx = useTranslationContext();
  if (!ctx || ctx.scope.length === 0) return null;
  if (ctx.phase.kind === 'no_credit') {
    return (
      <Bar phase="no-credit">
        <NoCreditMessage canAddCredits={ctx.canAddCredits} />
      </Bar>
    );
  }
  return <ControlBar />;
}

function ControlBar() {
  const ctx = useTranslationContext()!;
  const face = useControlFace();
  return (
    <Bar phase={ctx.phase.kind}>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        leftIcon={face.icon}
        {...face.aria}
        // Busy's `onPress` does nothing: a second press while busy is ignored.
        onClick={face.onPress}
        data-translation-control
      >
        {face.label}
      </Button>
      {face.hint}
    </Bar>
  );
}
