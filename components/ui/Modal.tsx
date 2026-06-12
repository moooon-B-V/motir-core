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
 * For a scrollable body with a pinned footer, wrap the fields in `Modal.Body`
 * (it owns the `flex-1 overflow-y-auto` scroll recipe and keeps focus rings
 * from clipping against the scroll edge — see `ModalBody`).
 *
 * @example
 * const [open, setOpen] = useState(false);
 * <Modal open={open} onOpenChange={setOpen} title="Confirm" size="md">
 *   <Modal.Body className="gap-4">
 *     <Input label="Name" autoFocus />
 *   </Modal.Body>
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
    // consumer can wrap its fields in `Modal.Body` (which owns the
    // `flex-1 overflow-y-auto` scroll recipe) and pin a `Modal.Footer`,
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
        // The large peek surface (Subtask 2.5.19's quick view) — a generous
        // dialog that takes a big part of the screen; pairs with a height +
        // p-0 className on the consumer side. Stock Tailwind 4xl rem value, so
        // the design-system --spacing-* scale stays untouched (see the comment
        // above on why we pin rems instead of max-w-{key}).
        xl: 'max-w-[58rem]',
        // The whole viewport (Subtask 5.2.6's attachment preview lightbox —
        // the 2.5.19 growth pattern one step further). Like `xl`, the variant
        // only lifts the size caps; the consumer pairs it with bg/border/
        // radius/padding overrides to drop the panel chrome it doesn't want.
        full: 'h-dvh max-h-dvh w-screen max-w-none',
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
  /**
   * Accessible name for a dialog that renders its OWN visible heading (so no
   * `title` is passed). Radix requires a Dialog.Title; without `title`/`srTitle`
   * we fall back to the generic "Dialog". Supply this to label the dialog with
   * something meaningful (e.g. the previewed issue's key) while keeping the
   * heading inside `children` (Subtask 2.5.19's quick-view peek).
   */
  srTitle?: string;
  className?: string;
  /**
   * Extra classes merged onto the backdrop — e.g. the attachment preview
   * lightbox (Subtask 5.2.6) deepens the default `bg-black/40` scrim to
   * `bg-black/80` per `design/work-items/attachments.mock.html` panel 6.
   */
  overlayClassName?: string;
}

function ModalRoot({
  open,
  onOpenChange,
  title,
  description,
  size,
  hideClose,
  srTitle,
  className,
  overlayClassName,
  children,
}: ModalProps) {
  const tc = useTranslations('common');
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={cn('fixed inset-0 z-40 bg-black/40', overlayClassName)} />
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
            // Radix requires Title for a11y; provide a visually-hidden one if
            // missing. `srTitle` lets a consumer with its own visible heading
            // still give the dialog a meaningful accessible name.
            <Dialog.Title className="sr-only">{srTitle ?? tc('dialog')}</Dialog.Title>
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

/**
 * ModalBody — the scrollable field area of a modal. Owns the scroll recipe
 * once so consumers don't re-derive it (and re-introduce the focus-ring clip):
 * it fills the remaining column height (the panel caps at `max-h-[90vh]`) and
 * scrolls, so a sibling `Modal.Footer` stays pinned.
 *
 * Ring-safe by construction. `Input` draws its focus ring as
 * `focus-within:ring-2 … ring-offset-2` — a box-shadow extending ~4px OUTSIDE
 * the field's border box. Per the CSS spec, `overflow-y: auto` forces the
 * computed `overflow-x` from `visible` to `auto`, so this body is a clip box on
 * BOTH axes; a full-width field's ring overhang would be painted outside it and
 * silently clipped (rings are box-shadows — they never grow the layout box, so
 * nothing scrolls, the paint is just cut). We pad the scroll container by more
 * than the overhang (`p-1.5` = 6px > 4px) and pull an equal negative margin
 * (`-m-1.5`), so the ring gets room while the body's visual gutter — and the
 * fields' alignment with the modal title/footer — is unchanged.
 *
 * Pass `gap-*` (and any extra layout) via `className`.
 */
const ModalBody = forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  function ModalBody({ className, children, ...rest }, ref) {
    return (
      <div
        ref={ref}
        className={cn(
          'flex min-h-0 flex-1 flex-col overflow-y-auto',
          // Ring-safe inset (see the component doc above): padding ≥ the focus
          // ring's ~4px overhang + an equal negative margin to keep the gutter.
          '-m-1.5 p-1.5',
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
  Body: ModalBody,
  Footer: ModalFooter,
  Trigger: ModalTrigger,
});
