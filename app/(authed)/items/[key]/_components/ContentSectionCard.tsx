import type { ReactNode } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Pencil } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import type { ApprovalGateKindDTO } from '@/lib/dto/approvalGate';

// A content section on the issue detail page (Subtask 2.4.2), per the mockup
// `design/work-items/detail.png`: a Card with a header row — section title +
// a muted "— <subtitle>" gloss + optional badge + an "Edit" link — over the
// rendered body. Both the description ("what to do") and the explanation
// ("why it matters") render through this so they read as siblings.

export interface ContentSectionCardProps {
  title: string;
  /** The muted "— <subtitle>" gloss after the title (e.g. "what to do"). */
  subtitle?: string;
  /** Extra header content after the title (e.g. the AI-drafted badge). */
  headerExtra?: ReactNode;
  /** Right-aligned header content (e.g. the read-only "Manage in Epic 5" note).
   * Mutually exclusive with `editHref` — both claim the header's far end. */
  headerRight?: ReactNode;
  /** When set, an "Edit" link is shown at the header's end. */
  editHref?: string;
  /**
   * The gate kinds whose frame this section draws (Story MOTIR-4908 · MOTIR-5878;
   * design § *The item header — where pressing it takes you*). The header's
   * decision-waiting marker scrolls to whichever section carries its kind, so the
   * destination follows where the frame is actually drawn rather than a fixed map
   * — a design gate moves into Development when the card has an open pull request.
   * Rendered as `data-decision-anchor` (space-separated, matched with `~=`) plus
   * `tabIndex={-1}`, so the landed section can take focus.
   */
  decisionAnchor?: readonly ApprovalGateKindDTO[];
  children: ReactNode;
}

export function ContentSectionCard({
  title,
  subtitle,
  headerExtra,
  headerRight,
  editHref,
  decisionAnchor,
  children,
}: ContentSectionCardProps) {
  const t = useTranslations('issueViews');
  return (
    <Card
      {...(decisionAnchor && decisionAnchor.length > 0
        ? { 'data-decision-anchor': decisionAnchor.join(' '), tabIndex: -1 }
        : {})}
      // The landed section takes focus from the header marker's press, so it draws
      // the focus ring the design names (panel 8A) — `focus`, not
      // `focus-visible`, because the focus is programmatic after a pointer press.
      className={
        decisionAnchor && decisionAnchor.length > 0
          ? 'shadow-(--shadow-card) focus:ring-2 focus:ring-(--focus-ring-color) focus:outline-none'
          : 'shadow-(--shadow-card)'
      }
      header={
        <div className="flex items-center gap-2">
          <h2 className="text-(--el-text) font-sans text-base font-semibold">{title}</h2>
          {subtitle ? (
            <span className="font-sans text-sm text-(--el-text-secondary)">— {subtitle}</span>
          ) : null}
          {headerExtra}
          {headerRight ? <div className="ml-auto flex items-center">{headerRight}</div> : null}
          {editHref ? (
            <Link
              href={editHref}
              className="ml-auto inline-flex items-center gap-1 rounded-(--radius-control) px-1.5 py-0.5 font-sans text-sm text-(--el-text-secondary) hover:text-(--el-text) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
            >
              <Pencil className="h-3.5 w-3.5" aria-hidden />
              {t('edit')}
            </Link>
          ) : null}
        </div>
      }
    >
      {children}
    </Card>
  );
}
