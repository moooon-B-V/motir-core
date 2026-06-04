import type { ReactNode } from 'react';
import Link from 'next/link';
import { Pencil } from 'lucide-react';
import { Card } from '@/components/ui/Card';

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
  children: ReactNode;
}

export function ContentSectionCard({
  title,
  subtitle,
  headerExtra,
  headerRight,
  editHref,
  children,
}: ContentSectionCardProps) {
  return (
    <Card
      className="shadow-(--shadow-card)"
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
              className="ml-auto inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-sans text-sm text-(--el-text-secondary) hover:text-(--el-text) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
            >
              <Pencil className="h-3.5 w-3.5" aria-hidden />
              Edit
            </Link>
          ) : null}
        </div>
      }
    >
      {children}
    </Card>
  );
}
