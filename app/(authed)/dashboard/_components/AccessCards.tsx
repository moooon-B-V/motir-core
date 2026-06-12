'use client';

import { Lock, Users } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { DashboardAccess } from '@prisma/client';

// The access radio cards (6.3.5, design panel 1b) — the 6.4.1 access-card
// grammar narrowed to `private | workspace` (the recorded deviation; the
// richer Jira audience matrix is the documented extension the `access` enum
// grows into). Shared by the create modal + the change-access modal.

export function AccessCards({
  value,
  onChange,
}: {
  value: DashboardAccess;
  onChange: (access: DashboardAccess) => void;
}) {
  const t = useTranslations('dashboards.create');
  const cards: { value: DashboardAccess; title: string; desc: string; icon: typeof Lock }[] = [
    { value: 'private', title: t('privateTitle'), desc: t('privateDesc'), icon: Lock },
    { value: 'workspace', title: t('workspaceTitle'), desc: t('workspaceDesc'), icon: Users },
  ];
  return (
    <div role="radiogroup" className="grid grid-cols-1 gap-2 sm:grid-cols-2">
      {cards.map((card) => {
        const selected = value === card.value;
        const Icon = card.icon;
        return (
          <button
            key={card.value}
            type="button"
            role="radio"
            aria-checked={selected}
            data-testid={`access-card-${card.value}`}
            onClick={() => onChange(card.value)}
            className={`flex items-start gap-2.5 rounded-(--radius-card) border p-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) ${
              selected
                ? 'border-(--el-accent) bg-(--el-surface-soft)'
                : 'border-(--el-border) hover:border-(--el-border-strong)'
            }`}
          >
            <Icon className="mt-0.5 size-4 shrink-0 text-(--el-text-secondary)" aria-hidden />
            <span className="min-w-0">
              <span className="block text-sm font-semibold text-(--el-text-strong)">
                {card.title}
              </span>
              <span className="block text-xs leading-relaxed text-(--el-text-muted)">
                {card.desc}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
