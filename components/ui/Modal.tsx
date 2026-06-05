'use client';

import { forwardRef, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils/cn';

/**
 * Modal — accessible dialog wrapping @radix-ui/react-dialog.
 *
 * Radix handles focus trap, ESC-to-close, click-outside-to-close, and
 * focus-return-on-close out of the box. We style on top.
 *
 * Open/close is controlled by the consumer via `open` + `onOpenChange`.
 *
 * @example
 * const [open, setOpen] = useState(false);
 * <Modal open={open} onOpenChange={setOpen} title="Confirm" size="md">
 *   <p>Body content</p>
 *   <Modal.Footer>
 *     <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
 *     <Button variant="primary" onClick={confirm}>Confirm</Button>
 *   </Modal.Footer>
 * </Modal>
 */
const contentVariants = cva(
  cn(
    'fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2',
    'w-[90vw] rounded-(--radius-modal) bg-(--el-page-bg)',
    'shadow-(--shadow-modal) border border-(--el-border)',
    'p-(--spacing-card-padding)',
    'focus:outline-none',
    // Never exceed the viewport: cap height and lay out as a column so a
    // consumer can give its body `flex-1 overflow-y-auto` and pin a footer,
    // instead of the dialog growing off-screen (e.g. the create modal's
    // expandable Explanation pushing the Create button out of view).
    'flex max-h-[90vh] flex-col overflow-hidden',
  ),
  {
    variants: {
      // Literal widths, NOT the max-w-sm/md/lg utilities: the design
      // system's @theme defines --spacing-sm/md/lg (12/16/20px), and
      // Tailwind v4 resolves `max-w-{key}` against the --spacing-* scale
      // when that key exists — so `max-w-md` would collapse the modal to
      // 16px wide. Pinning the rem values (Tailwind's stock sm/md/lg) keeps
      // the design-system token set untouched and the dialog readable.
      size: {
        sm: 'max-w-[24rem]',
        md: 'max-w-[28rem]',
        lg: 'max-w-[32rem]',
      },
    },
    defaultVariants: { size: 'md' },
  },
);

export interface ModalProps extends VariantProps<typeof contentVariants> {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: string;
  description?: string;
  children?: ReactNode;
  /** Hide the default close (×) button in the corner. */
  hideClose?: boolean;
  className?: string;
}

function ModalRoot({
  open,
  onOpenChange,
  title,
  description,
  size,
  hideClose,
  className,
  children,
}: ModalProps) {
  const tc = useTranslations('common');
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
        {/*
          PRODECT_FINDINGS #8: Radix checks for a describing element
          (Dialog.Description → aria-describedby) independently of the Title
          check. When no `description` prop is passed we render no
          Dialog.Description, so Radix logs a "Missing Description or
          aria-describedby={undefined}" warning. We pick the explicit opt-out
          (aria-describedby={undefined}) rather than emitting an empty sr-only
          Description — an empty description announces nothing useful and is
          worse for screen-reader users than declaring the dialog has none.
        */}
        <Dialog.Content
          className={cn(contentVariants({ size }), className)}
          // Only opt out when there's no description. When `description` is
          // set we omit the prop entirely so Radix keeps auto-wiring
          // aria-describedby to the rendered Dialog.Description's id.
          {...(description ? {} : { 'aria-describedby': undefined })}
        >
          {title || description ? (
            <div className="mb-(--spacing-md) shrink-0">
              {title ? (
                <Dialog.Title className="font-serif text-xl font-semibold text-(--el-text)">
                  {title}
                </Dialog.Title>
              ) : null}
              {description ? (
                <Dialog.Description className="text-(--el-text-muted) mt-1 font-sans text-sm">
                  {description}
                </Dialog.Description>
              ) : null}
            </div>
          ) : (
            // Radix requires Title for a11y; provide a visually-hidden one if missing.
            <Dialog.Title className="sr-only">{tc('dialog')}</Dialog.Title>
          )}
          {children}
          {!hideClose ? (
            <Dialog.Close
              aria-label={tc('close')}
              className="text-(--el-text-muted) hover:text-(--el-text) absolute right-3 top-3 rounded-(--radius-control) p-(--spacing-icon-btn) transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color)"
            >
              <X className="h-4 w-4" />
            </Dialog.Close>
          ) : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

const ModalFooter = forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  function ModalFooter({ className, children, ...rest }, ref) {
    return (
      <div
        ref={ref}
        className={cn(
          'border-(--el-border) mt-(--spacing-md) flex items-center justify-end gap-2 border-t pt-(--spacing-md)',
          className,
        )}
        {...rest}
      >
        {children}
      </div>
    );
  },
);

/** Convenience trigger — wires children to Radix's DialogTrigger. */
const ModalTrigger = Dialog.Trigger;

export const Modal = Object.assign(ModalRoot, {
  Footer: ModalFooter,
  Trigger: ModalTrigger,
});
