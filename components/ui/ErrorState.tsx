import { forwardRef, type HTMLAttributes } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Button } from './Button';
import { Card } from './Card';
import { cn } from '@/lib/utils/cn';

/**
 * ErrorState — composed pattern for "something failed" screens.
 *
 * Use this whenever a request, mutation, or background job has failed in a
 * way the user needs to acknowledge or recover from. Prefer this over a
 * silent log line whenever the failure prevents the user from progressing.
 *
 * Has `role="alert"` so screen readers announce the failure when it's
 * inserted into the DOM. The `error.message` debug detail renders only in
 * non-production builds (Next.js statically replaces `process.env.NODE_ENV`
 * at build time, so the block is dead-code-eliminated in production).
 *
 * @example
 * <ErrorState
 *   title="Couldn't load workspace"
 *   description="We couldn't reach the server. Check your connection and try again."
 *   error={err}
 *   retry={() => refetch()}
 * />
 */
export interface ErrorStateProps extends HTMLAttributes<HTMLDivElement> {
  /** Short, plain-language summary of what failed. Required. */
  title: string;
  /** Recovery hint or context. Avoid restating the title. */
  description?: string;
  /** Real Error object — rendered as a mono code block in dev only. */
  error?: Error;
  /** Callback for the "Try again" button; omit to hide the button. */
  retry?: () => void;
}

export const ErrorState = forwardRef<HTMLDivElement, ErrorStateProps>(function ErrorState(
  { title, description, error, retry, className, ...rest },
  ref,
) {
  const showErrorDetail = error && process.env.NODE_ENV !== 'production';
  return (
    <Card
      ref={ref}
      role="alert"
      className={cn('flex flex-col items-center text-center', className)}
      {...rest}
    >
      <div
        className="mb-(--spacing-md) inline-flex h-12 w-12 items-center justify-center"
        style={{ color: 'var(--color-destructive)' }}
      >
        <AlertTriangle className="h-12 w-12" aria-hidden />
      </div>
      <h2 className="font-serif text-xl text-foreground">{title}</h2>
      {description ? (
        <p className="text-muted-foreground mt-(--spacing-sm) max-w-prose font-sans text-sm">
          {description}
        </p>
      ) : null}
      {showErrorDetail ? (
        <pre className="bg-surface text-muted-foreground mt-(--spacing-md) max-w-full overflow-x-auto rounded-(--radius-sm) px-2 py-1 text-left font-mono text-xs">
          {error.message}
        </pre>
      ) : null}
      {retry ? (
        <div className="mt-(--spacing-md)">
          <Button variant="secondary" onClick={retry}>
            Try again
          </Button>
        </div>
      ) : null}
    </Card>
  );
});
