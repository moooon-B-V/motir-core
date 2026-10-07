'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { AlertTriangle, Archive, CheckCircle2, Pencil, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/components/ui/Toast';
import type { StaffIdeaDto, StaffIdeaTagDto } from '@/lib/dto/ideas';
import type { IdeaRefusalCode } from '../../actions';
import { IdeaDetailView } from '../../_components/IdeaDetailView';
import { DeleteIdeaDialog } from './DeleteIdeaDialog';
import { IdeaEditForm } from './IdeaEditForm';
import { RetireIdeaDialog } from './RetireIdeaDialog';

/**
 * One idea with its WRITE controls — design `platform-admin` § Ideas, Panels
 * 6–10, card MOTIR-7681. Rendered for an operator or a superadmin; a support
 * viewer gets the read-only page, which is the role matrix's "absent, not
 * disabled". The buttons are presentation: each action re-gates, and the
 * service is the rule.
 *
 * ⚠️ WHAT THIS ISLAND OWNS, AND WHAT IT DOES NOT (`CLAUDE.md`'s page-state
 * contract). The idea is a server prop and every action revalidates the detail,
 * so the page re-reads after a write. A save ALSO answers the stored DTO, which
 * this island shows at once (Panel 7b, with the added evidence rows marked
 * _New_) — but only while it is at least as new as the prop, so the re-read,
 * a retire or another tab's newer write always wins over a held copy.
 */

export interface IdeaWorkbenchProps {
  idea: StaffIdeaDto;
  tags: StaffIdeaTagDto[];
  retiredBy: string | null;
  canDelete: boolean;
}

type Notice = 'saved' | 'already' | null;

export function IdeaWorkbench({ idea, tags, retiredBy, canDelete }: IdeaWorkbenchProps) {
  const t = useTranslations('platformAdmin.ideas');
  const router = useRouter();
  const { toast } = useToast();
  const [editing, setEditing] = useState(false);
  const [saved, setSaved] = useState<{ idea: StaffIdeaDto; added: ReadonlySet<number> } | null>(
    null,
  );
  const [notice, setNotice] = useState<Notice>(null);
  const [retireOpen, setRetireOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const held = saved && saved.idea.updatedAt >= idea.updatedAt ? saved : null;
  const shown = held?.idea ?? idea;

  function refused(code: IdeaRefusalCode) {
    if (code === 'not_found') {
      toast({ variant: 'error', title: t('refused.notFound') });
      router.push('/admin/ideas');
      return;
    }
    if (code === 'not_active') {
      setNotice('already');
      return;
    }
    toast({
      variant: 'error',
      title: t(code === 'not_permitted' ? 'refused.notPermitted' : 'refused.failed'),
    });
  }

  const actions = editing ? null : (
    <div className="flex flex-wrap items-center gap-2" data-testid="idea-actions">
      <Button
        size="sm"
        variant="secondary"
        leftIcon={<Pencil className="h-3.5 w-3.5" />}
        onClick={() => {
          setNotice(null);
          setEditing(true);
        }}
      >
        {t('action.edit')}
      </Button>
      {shown.status === 'active' ? (
        <Button
          size="sm"
          variant="secondary"
          leftIcon={<Archive className="h-3.5 w-3.5" />}
          onClick={() => setRetireOpen(true)}
        >
          {t('action.retire')}
        </Button>
      ) : null}
      {canDelete ? (
        <Button
          size="sm"
          variant="ghost"
          className="text-(--el-danger-on-surface)"
          leftIcon={<Trash2 className="h-3.5 w-3.5" />}
          onClick={() => setDeleteOpen(true)}
        >
          {t('action.delete')}
        </Button>
      ) : null}
    </div>
  );

  const callout =
    notice === 'saved' ? (
      <p
        role="status"
        data-testid="idea-saved"
        className="flex items-start gap-2 rounded-(--radius-card) bg-(--el-tint-mint) p-(--spacing-card-padding) font-sans text-sm text-(--el-text-strong)"
      >
        <CheckCircle2 aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
        <span>{t('edit.saved')}</span>
      </p>
    ) : notice === 'already' ? (
      <p
        role="alert"
        data-testid="idea-already-retired"
        className="flex items-start gap-2 rounded-(--radius-card) bg-(--el-tint-yellow) p-(--spacing-card-padding) font-sans text-sm text-(--el-text-strong)"
      >
        <AlertTriangle aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
        <span>{t('retire.already')}</span>
      </p>
    ) : null;

  return (
    <>
      <IdeaDetailView
        idea={shown}
        actions={actions}
        notice={callout}
        retiredBy={retiredBy}
        {...(held ? { newEvidence: held.added } : {})}
        body={
          editing ? (
            <IdeaEditForm
              idea={shown}
              tags={tags}
              onCancel={() => setEditing(false)}
              onSaved={(next, added) => {
                setSaved({ idea: next, added });
                setEditing(false);
                setNotice('saved');
              }}
              onRefused={refused}
            />
          ) : undefined
        }
      />
      <RetireIdeaDialog
        idea={shown}
        open={retireOpen}
        onOpenChange={setRetireOpen}
        onDone={(result) => {
          if (result.ok) {
            setNotice(null);
            toast({ variant: 'success', title: t('retire.done') });
            return;
          }
          refused(result.code);
        }}
      />
      {canDelete ? (
        <DeleteIdeaDialog
          idea={shown}
          open={deleteOpen}
          onOpenChange={setDeleteOpen}
          onDone={(result) => {
            if (result.ok) {
              // The toast outlives the navigation: its provider sits in the root layout.
              toast({ variant: 'success', title: t('delete.done', { title: shown.title }) });
              router.push('/admin/ideas');
              return;
            }
            refused(result.code);
          }}
        />
      ) : null}
    </>
  );
}
