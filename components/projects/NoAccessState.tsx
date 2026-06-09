import Link from 'next/link';
import { Lock } from 'lucide-react';
import { EmptyState } from '@/components/ui/EmptyState';
import { buttonVariants } from '@/components/ui/Button';

/**
 * NoAccessState — the panel a non-member hits when they navigate directly to a
 * project they cannot browse (Story 6.4 · Subtask 6.4.6, design 6.4.1). It is
 * the EmptyState/ErrorState family with a lock glyph + a way back, NOT a crash:
 * the project read threw `ProjectAccessDeniedError('browse')` (or the active
 * project resolved as non-browsable), and the page renders this instead of the
 * board / issue list.
 *
 * Purely presentational (server-renderable) so the board + issues pages — both
 * Server Components — can render it after the server-side browse check, passing
 * already-translated copy. The "Back to projects" action is a Next `<Link>`
 * styled as a button (the `buttonVariants` pattern). A "Request access" action
 * is intentionally NOT shown: notifying a project admin needs a backend flow
 * that Story 6.4 does not ship (see the 6.4.6 PR note) — a dead button would be
 * worse than its honest absence.
 */
export interface NoAccessStateProps {
  title: string;
  description: string;
  /** Where the "back" action navigates — the projects home (the dashboard). */
  backHref: string;
  backLabel: string;
}

export function NoAccessState({ title, description, backHref, backLabel }: NoAccessStateProps) {
  return (
    <EmptyState
      title={title}
      description={description}
      icon={<Lock className="h-12 w-12" aria-hidden />}
      action={
        <Link href={backHref} className={buttonVariants({ variant: 'primary' })}>
          {backLabel}
        </Link>
      }
    />
  );
}
