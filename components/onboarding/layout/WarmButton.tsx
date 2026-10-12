import { forwardRef, type ComponentProps } from 'react';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/utils/cn';

// The warm primary button (MOTIR-8251 Revision 5, built by MOTIR-8254). The
// onboarding screens keep a cool tone overall and paint ONE warm element: the
// primary action, in the palette's highlight with an ink label. It is a
// TREATMENT of `Button`'s primary variant — the same shape, sizes, hover
// opacity and disabled state — with only the two colour roles swapped:
//
//   fill  `--el-cta-warm`       (the palette's `--el-highlight`)
//   label `--el-cta-warm-text`  (the body ink in light, the page ink in dark:
//                                4.65:1 / 5.9:1 — white on the orange is not AA)
//
// Every other variant passes through untouched, so a screen can import this
// as its `Button` and only its primary actions turn warm.

/** The class pair a primary-looking element (a `Link` styled with
 *  `buttonVariants`) adds to turn warm. */
export const WARM_CTA = 'bg-(--el-cta-warm) text-(--el-cta-warm-text)';

type ButtonProps = ComponentProps<typeof Button>;

export const WarmButton = forwardRef<HTMLButtonElement, ButtonProps>(function WarmButton(
  { variant, className, ...rest },
  ref,
) {
  const primary = (variant ?? 'primary') === 'primary';
  return (
    <Button ref={ref} variant={variant} className={cn(className, primary && WARM_CTA)} {...rest} />
  );
});
