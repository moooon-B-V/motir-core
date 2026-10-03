import { useTranslations } from 'next-intl';
import { Globe } from 'lucide-react';
import { Pill } from '@/components/ui/Pill';
import type {
  PlatformLessonInjectionState,
  PlatformLessonOwnerDTO,
} from '@/lib/dto/platformLessons';

/**
 * The cells the list and the detail share — design `platform-admin/design-notes.md`
 * § AMENDMENT 2026-10-02 (Planning lessons), the colour-roles table. No hooks
 * beyond `useTranslations`, so a Server Component and the client island both
 * render them.
 */

const TYPE_TINT: Record<string, string> = {
  regular_planning: 'bg-(--el-tint-mint)',
  onboarding_planning: 'bg-(--el-tint-sky)',
  planning_craft: 'bg-(--el-tint-lavender)',
  coding: 'bg-(--el-tint-peach)',
};

const KNOWN_TYPES = new Set(Object.keys(TYPE_TINT));

/** The type's label, or the raw value for a type this page does not know. */
export function useLessonTypeLabel() {
  const t = useTranslations('platformAdmin.lessons');
  return (mistakeType: string) =>
    KNOWN_TYPES.has(mistakeType) ? t(`type.${mistakeType as 'coding'}`) : mistakeType;
}

export function LessonTypePill({ mistakeType }: { mistakeType: string }) {
  const label = useLessonTypeLabel();
  return (
    <Pill
      tone="neutral"
      className={`${TYPE_TINT[mistakeType] ?? 'bg-(--el-surface)'} border-transparent text-(--el-text-strong)`}
    >
      {label(mistakeType)}
    </Pill>
  );
}

export function GlobalPill() {
  const t = useTranslations('platformAdmin.lessons');
  return (
    <Pill tone="private" className="inline-flex items-center gap-1">
      <Globe aria-hidden className="h-3 w-3" />
      {t('owner.global')}
    </Pill>
  );
}

export function LessonOwnerCell({ owner }: { owner: PlatformLessonOwnerDTO | null }) {
  const t = useTranslations('platformAdmin.lessons');
  if (!owner) return <GlobalPill />;
  const path = [owner.workspaceName, owner.projectName].filter(Boolean).join(' / ');
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-(--el-text)">{owner.organizationName ?? t('owner.unknownOrg')}</span>
      {path ? <span className="font-mono text-xs text-(--el-text-identifier)">{path}</span> : null}
    </div>
  );
}

const DOT: Record<PlatformLessonInjectionState, string> = {
  injected: 'bg-(--el-success)',
  resting: 'bg-(--el-warning)',
  off: 'bg-(--el-switch-off-border)',
};

export function LessonInjectionCell({
  state,
  retentionDays,
}: {
  state: PlatformLessonInjectionState;
  retentionDays: number;
}) {
  const t = useTranslations('platformAdmin.lessons');
  const word =
    state === 'injected' ? t('inj.on') : state === 'off' ? t('inj.off') : t('inj.resting');
  const sub =
    state === 'off'
      ? t('inj.offSub')
      : state === 'resting'
        ? t('inj.restSub', { days: retentionDays })
        : null;
  return (
    <div className="flex flex-col gap-0.5" data-testid="lesson-injection" data-state={state}>
      <span className="inline-flex items-center gap-2 text-(--el-text)">
        <span aria-hidden className={`h-2 w-2 rounded-full ${DOT[state]}`} />
        {word}
      </span>
      {sub ? <span className="text-xs text-(--el-text-secondary)">{sub}</span> : null}
    </div>
  );
}
