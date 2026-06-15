'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Plus, LogIn } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button, buttonVariants } from '@/components/ui/Button';

// The "Submit a request" control on the public sub-bar (Story 6.12 · Subtask
// 6.12.4). The submit FORM is 6.12.5 and isn't built here; per the design,
// logged-out (and since 6.12.5 isn't built) it shows a "sign-in-to-act" prompt
// linking to /sign-in — reading is open, posting needs an account. Client
// component (the prompt toggles); colour via --el-* tokens, shape via tokens.

export function PublicSubmitRequestButton({ size = 'sm' }: { size?: 'sm' | 'md' }) {
  const t = useTranslations('publicProjects');
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <Button
        variant="primary"
        size={size}
        leftIcon={<Plus className="h-4 w-4" />}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {t('submitRequest')}
      </Button>
      {open ? (
        <div
          role="dialog"
          aria-label={t('signInToActTitle')}
          className="absolute right-0 z-10 mt-2 w-72 rounded-(--radius-card) border border-(--el-border) bg-(--el-page-bg) p-(--spacing-card-padding) shadow-(--shadow-card)"
        >
          <div className="mb-1 flex items-center gap-2 text-sm font-semibold text-(--el-text)">
            <LogIn className="h-4 w-4 text-(--el-text-muted)" aria-hidden />
            {t('signInToActTitle')}
          </div>
          <p className="mb-3 text-[12.5px] leading-relaxed text-(--el-text-muted)">
            {t('signInToActBody')}
          </p>
          <Link href="/sign-in" className={buttonVariants({ variant: 'primary', size: 'sm' })}>
            {t('signIn')}
          </Link>
        </div>
      ) : null}
    </div>
  );
}
