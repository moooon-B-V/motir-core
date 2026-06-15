'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Plus, LogIn } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button, buttonVariants } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { PublicSubmitRequestForm } from './PublicSubmitRequestForm';

// The "Submit a request" control on the public surface (Story 6.12 · Subtasks
// 6.12.4 + 6.12.11). READ is anonymous; only the WRITE needs an account:
//
//  - LOGGED OUT → a "sign-in-to-act" prompt linking to /sign-in (the
//    unauthenticated public portal form is dropped — Yue, 2026-06-14; posting
//    needs an account).
//  - SIGNED IN → opens the real submit composer (6.12.11) in a Modal: kind
//    toggle + title + description + duplicate-detection ("upvote this instead").
//
// Client component; colour via --el-* tokens, shape via element-semantic tokens.
export function PublicSubmitRequestButton({
  projectId,
  roadmapHref,
  signedIn,
  submitterName = null,
  submitterOrg = null,
  size = 'sm',
}: {
  projectId: string;
  roadmapHref: string;
  signedIn: boolean;
  submitterName?: string | null;
  submitterOrg?: string | null;
  size?: 'sm' | 'md';
}) {
  const t = useTranslations('publicProjects');
  const [promptOpen, setPromptOpen] = useState(false);
  const [formOpen, setFormOpen] = useState(false);

  // Signed in: the real composer behind a button.
  if (signedIn) {
    return (
      <>
        <Button
          variant="primary"
          size={size}
          leftIcon={<Plus className="h-4 w-4" />}
          onClick={() => setFormOpen(true)}
        >
          {t('submitRequest')}
        </Button>
        <Modal open={formOpen} onOpenChange={setFormOpen} title={t('submitRequest')} size="lg">
          <PublicSubmitRequestForm
            projectId={projectId}
            roadmapHref={roadmapHref}
            submitterName={submitterName}
            submitterOrg={submitterOrg}
            onClose={() => setFormOpen(false)}
          />
        </Modal>
      </>
    );
  }

  // Logged out: the sign-in-to-act prompt (reading is open; posting needs an account).
  return (
    <div className="relative">
      <Button
        variant="primary"
        size={size}
        leftIcon={<Plus className="h-4 w-4" />}
        aria-expanded={promptOpen}
        onClick={() => setPromptOpen((v) => !v)}
      >
        {t('submitRequest')}
      </Button>
      {promptOpen ? (
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
