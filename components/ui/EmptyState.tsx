import { forwardRef, type HTMLAttributes, type ReactNode } from 'react';
import { Inbox } from 'lucide-react';
import { Card } from './Card';
import { cn } from '@/lib/utils/cn';

/**
 * EmptyState — composed pattern for "there's nothing to show yet" screens.
 *
 * Composes [`Card`](./Card.tsx) + a lucide icon + an optional action button.
 * Use this whenever a list, table, board, or detail panel has no data —
 * the common mistake is leaving the screen blank, which reads as broken.
 * Always give the user (a) a sense of what would appear here, and (b) a
 * clear next step.
 *
 * Icons come from `lucide-react`. The default `<Inbox />` is appropriate for
 * generic "no items" cases; pass `icon` to specialize (FolderOpen,
 * MessageSquareOff, Users, etc.).
 *
 * @example
 * <EmptyState
 *   title="No projects yet"
 *   description="Create your first project to get started."
 *   action={<Button leftIcon={<Plus />}>New project</Button>}
 * />
 */
export interface EmptyStateProps extends HTMLAttributes<HTMLDivElement> {
  /** Headline — what's missing. Required. */
  title: string;
  /** Optional supporting copy explaining what would appear here. */
  description?: string;
  /** Lucide-style icon; defaults to `<Inbox />`. */
  icon?: ReactNode;
  /** Typically a `<Button>` representing the next action. */
  action?: ReactNode;
}

export const EmptyState = forwardRef<HTMLDivElement, EmptyStateProps>(function EmptyState(
  { title, description, icon, action, className, ...rest },
  ref,
) {
  return (
    <Card ref={ref} className={cn('flex flex-col items-center text-center', className)} {...rest}>
      <div className="text-muted-foreground mb-(--spacing-md) inline-flex h-12 w-12 items-center justify-center">
        {icon ?? <Inbox className="h-12 w-12" aria-hidden />}
      </div>
      <h2 className="font-serif text-xl text-foreground">{title}</h2>
      {description ? (
        <p className="text-muted-foreground mt-(--spacing-sm) max-w-prose font-sans text-sm">
          {description}
        </p>
      ) : null}
      {action ? <div className="mt-(--spacing-md)">{action}</div> : null}
    </Card>
  );
});
