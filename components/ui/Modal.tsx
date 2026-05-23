'use client';

import { forwardRef, type ReactNode } from 'react';
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
    'w-[90vw] rounded-(--radius-modal) bg-background',
    'shadow-(--shadow-modal) border border-(--color-hairline)',
    'p-(--spacing-card-padding)',
    'focus:outline-none',
  ),
  {
    variants: {
      size: {
        sm: 'max-w-sm',
        md: 'max-w-md',
        lg: 'max-w-lg',
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
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <Dialog.Content className={cn(contentVariants({ size }), className)}>
          {title || description ? (
            <div className="mb-(--spacing-md)">
              {title ? (
                <Dialog.Title className="font-serif text-xl font-semibold text-foreground">
                  {title}
                </Dialog.Title>
              ) : null}
              {description ? (
                <Dialog.Description className="text-muted-foreground mt-1 font-sans text-sm">
                  {description}
                </Dialog.Description>
              ) : null}
            </div>
          ) : (
            // Radix requires Title for a11y; provide a visually-hidden one if missing.
            <Dialog.Title className="sr-only">Dialog</Dialog.Title>
          )}
          {children}
          {!hideClose ? (
            <Dialog.Close
              aria-label="Close"
              className="text-muted-foreground hover:text-foreground absolute right-3 top-3 rounded-(--radius-sm) p-1 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color)"
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
          'border-(--color-hairline) mt-(--spacing-md) flex items-center justify-end gap-2 border-t pt-(--spacing-md)',
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
