'use client';

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import * as RadixToast from '@radix-ui/react-toast';
import { AlertCircle, CheckCircle2, Info, X, XCircle } from 'lucide-react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils/cn';

/**
 * Toast — transient notification with stacking, auto-dismiss, hover-to-pause.
 *
 * Wrap the app in `<ToastProvider>` once. Use `useToast()` from any client
 * component to dispatch:
 *
 * @example
 * const { toast } = useToast();
 * toast({ variant: 'success', title: 'Saved', description: 'Changes synced.' });
 */
const toastVariants = cva(
  cn(
    'pointer-events-auto flex items-start gap-3',
    'rounded-(--radius-card) border bg-(--el-page-bg)',
    'px-(--spacing-md) py-(--spacing-sm)',
    'shadow-(--shadow-elevated)',
    'data-[state=open]:animate-in data-[state=closed]:animate-out',
    'data-[state=open]:fade-in-0 data-[state=closed]:fade-out-80',
    'data-[swipe=move]:translate-x-(--radix-toast-swipe-move-x)',
    'data-[swipe=cancel]:translate-x-0 data-[swipe=end]:translate-x-(--radix-toast-swipe-end-x)',
    'data-[swipe=cancel]:transition-transform data-[swipe=end]:transition-transform',
  ),
  {
    variants: {
      variant: {
        info: 'border-(--el-info)',
        success: 'border-(--el-success)',
        warning: 'border-(--el-warning)',
        error: 'border-(--el-danger)',
      },
    },
    defaultVariants: { variant: 'info' },
  },
);

type ToastVariant = NonNullable<VariantProps<typeof toastVariants>['variant']>;

interface ToastItem {
  id: string;
  variant: ToastVariant;
  title: string;
  description?: string;
}

interface ToastContextValue {
  toast: (opts: { variant?: ToastVariant; title: string; description?: string }) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const ICONS: Record<ToastVariant, typeof Info> = {
  info: Info,
  success: CheckCircle2,
  warning: AlertCircle,
  error: XCircle,
};

const ICON_COLOR_VAR: Record<ToastVariant, string> = {
  info: 'var(--el-info)',
  success: 'var(--el-success)',
  warning: 'var(--el-warning)',
  error: 'var(--el-danger)',
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const toast = useCallback<ToastContextValue['toast']>(
    ({ variant = 'info', title, description }) => {
      const id = crypto.randomUUID();
      setToasts((prev) => [...prev, { id, variant, title, description }]);
    },
    [],
  );

  const remove = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const value = useMemo(() => ({ toast }), [toast]);

  return (
    <ToastContext.Provider value={value}>
      <RadixToast.Provider swipeDirection="right" duration={5000}>
        {children}
        {toasts.map((t) => {
          const Icon = ICONS[t.variant];
          return (
            <RadixToast.Root
              key={t.id}
              className={toastVariants({ variant: t.variant })}
              onOpenChange={(open) => {
                if (!open) remove(t.id);
              }}
            >
              <span aria-hidden className="mt-0.5 inline-flex">
                <Icon className="h-4 w-4" style={{ color: ICON_COLOR_VAR[t.variant] }} />
              </span>
              <div className="flex-1">
                <RadixToast.Title className="font-sans text-sm font-medium text-(--el-text)">
                  {t.title}
                </RadixToast.Title>
                {t.description ? (
                  <RadixToast.Description className="text-(--el-text-muted) mt-0.5 font-sans text-xs">
                    {t.description}
                  </RadixToast.Description>
                ) : null}
              </div>
              <RadixToast.Close
                aria-label="Close"
                className="text-(--el-text-muted) hover:text-(--el-text) rounded-(--radius-control) p-(--spacing-icon-btn) transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color)"
              >
                <X className="h-3.5 w-3.5" />
              </RadixToast.Close>
            </RadixToast.Root>
          );
        })}
        <RadixToast.Viewport className="fixed bottom-0 right-0 z-50 m-4 flex w-96 max-w-[100vw] flex-col gap-2 outline-none" />
      </RadixToast.Provider>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error('useToast must be used inside <ToastProvider>');
  }
  return ctx;
}
