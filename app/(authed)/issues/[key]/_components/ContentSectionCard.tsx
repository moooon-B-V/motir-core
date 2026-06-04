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
  /** When set, an "Edit" link is shown at the header's end. */
  editHref?: string;
  children: ReactNode;
}

export function ContentSectionCard({
  title,
  subtitle,
  headerExtra,
  editHref,
  children,
}: ContentSectionCardProps) {
  return (
    <Card
      className="shadow-(--shadow-card)"
      header={
        <div className="flex items-center gap-2">
          <h2 className="text-foreground font-sans text-base font-semibold">{title}</h2>
          {subtitle ? (
            <span className="font-sans text-sm text-(--color-slate)">— {subtitle}</span>
          ) : null}
          {headerExtra}
          {editHref ? (
            <Link
              href={editHref}
              className="ml-auto inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-sans text-sm text-(--color-slate) hover:text-foreground focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
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
