import { useTranslations } from 'next-intl';
import { Pill } from '@/components/ui/Pill';
import type { IdeaKind, IdeaStatus } from '@/generated/prisma/client';
import type { IdeaTagRefDto } from '@/lib/dto/ideas';

/**
 * The pills and chips the Ideas list and detail share — design
 * `platform-admin/design-notes.md` § Ideas, the value-set table. No hooks beyond
 * `useTranslations`, so a Server Component and a client island both render
 * them. The hue sits in a `--el-tint-*` BACKGROUND with `--el-text-strong` ink
 * (finding #35); a retired idea is the quiet surface pill, because retiring is
 * the normal end of an idea and not an alarm.
 */

const STATUS_CLASS: Record<IdeaStatus, string> = {
  active: 'bg-(--el-tint-mint) border-transparent text-(--el-text-strong)',
  retired: 'bg-(--el-surface) border-(--el-border) text-(--el-text-secondary)',
};

const KIND_CLASS: Record<IdeaKind, string> = {
  motir_buys: 'bg-(--el-tint-lavender) border-transparent text-(--el-text-strong)',
  direction: 'bg-(--el-tint-sky) border-transparent text-(--el-text-strong)',
};

export function IdeaStatusPill({ status }: { status: IdeaStatus }) {
  const t = useTranslations('platformAdmin.ideas.status');
  return (
    <Pill tone="neutral" data-status={status} className={STATUS_CLASS[status]}>
      {t(status)}
    </Pill>
  );
}

export function IdeaKindPill({ kind }: { kind: IdeaKind }) {
  const t = useTranslations('platformAdmin.ideas.kind');
  return (
    <Pill tone="neutral" data-kind={kind} className={KIND_CLASS[kind]}>
      {t(kind)}
    </Pill>
  );
}

export function IdeaCategoryPill({ label }: { label: string }) {
  return <Pill tone="neutral">{label}</Pill>;
}

/** One tag as a quiet chip — `--el-surface-soft` with `--el-text-secondary` ink. */
export function IdeaTagChip({ tag }: { tag: IdeaTagRefDto }) {
  return (
    <span className="inline-flex items-center rounded-(--radius-badge) border border-(--el-border-soft) bg-(--el-surface-soft) px-(--spacing-chip-x) py-(--spacing-chip-y) font-sans text-xs text-(--el-text-secondary)">
      {tag.label}
    </span>
  );
}
