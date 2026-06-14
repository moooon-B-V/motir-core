'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Send } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { Textarea } from '@/components/ui/Textarea';
import { Button } from '@/components/ui/Button';
import { Segmented } from '@/components/ui/Segmented';
import { useToast } from '@/components/ui/Toast';
import { IssueTypeIcon } from '@/components/issues/IssueTypeIcon';

// The in-app "report a bug / request a feature" widget (Story 6.11 · Subtask
// 6.11.7), built FROM `design/triage/` panel 3. A signed-in member opens it from
// the shell (or the inbox header) and posts to the 6.11.4 intake endpoint
// (`POST /api/projects/[key]/triage/submissions`), which creates a `work_item`
// (kind `bug` / `task`) in the `triage` state — invisible to the tree until an
// admin promotes it from the inbox. Confirms with a Toast.
//
// The submission kind maps to the work_item kind: "Bug" → `bug`, "Feature" →
// `task` (the request grammar the intake service accepts). Title is required and
// capped at the service's MAX_TRIAGE_TITLE_LENGTH; description is optional.
//
// Scope note (Yue, 2026-06-14): the unauthenticated public portal form is
// DROPPED — a work item is created only by a signed-in account. The external
// "Submit a request" surface is Story 6.12. The design's OPTIONAL attachment
// dropzone is intentionally omitted here: the shipped 6.11.4 intake endpoint
// accepts only `{ kind, title, descriptionMd }`, so an attachment control would
// be a dead affordance — wiring it is follow-up work on the intake path.

// Mirrors the server backstop in `lib/triage/errors.ts` (MAX_TRIAGE_TITLE_LENGTH)
// so the client gates before the round-trip; the service re-validates regardless.
const MAX_TITLE_LENGTH = 200;

type ReportKind = 'bug' | 'task';

export interface ReportWidgetModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The active project's identifier ("PROD") — the intake route's `[key]`. */
  projectKey: string;
  /** Called after a submission is accepted (201), alongside `router.refresh()`. */
  onSubmitted?: () => void;
}

export function ReportWidgetModal({
  open,
  onOpenChange,
  projectKey,
  onSubmitted,
}: ReportWidgetModalProps) {
  const t = useTranslations('triage');
  const tc = useTranslations('common');
  const router = useRouter();
  const { toast } = useToast();

  const [kind, setKind] = useState<ReportKind>('bug');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [titleError, setTitleError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function reset() {
    setKind('bug');
    setTitle('');
    setDescription('');
    setTitleError(null);
  }

  // Reset the form whenever the modal closes (cancel, ✕, ESC, click-outside) so a
  // re-open starts clean — never leak the prior draft.
  function handleOpenChange(next: boolean) {
    if (!next) reset();
    onOpenChange(next);
  }

  async function handleSubmit() {
    const trimmed = title.trim();
    if (trimmed.length === 0) {
      setTitleError(t('widget.titleRequired'));
      return;
    }
    if (trimmed.length > MAX_TITLE_LENGTH) {
      setTitleError(t('widget.titleTooLong', { max: MAX_TITLE_LENGTH }));
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch(
        `/api/projects/${encodeURIComponent(projectKey)}/triage/submissions`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            kind,
            title: trimmed,
            descriptionMd: description.trim() ? description : null,
          }),
        },
      );
      if (!res.ok) throw new Error(`Triage submission failed: ${res.status}`);
      const result = (await res.json()) as { identifier: string };

      toast({
        variant: 'success',
        title: t('widget.submitted'),
        description: t('widget.submittedDetail', { key: result.identifier }),
      });
      reset();
      onOpenChange(false);
      onSubmitted?.();
      // The inbox is a Server Component reading page 1 of the queue; refresh so a
      // freshly-submitted item shows there without a manual reload.
      router.refresh();
    } catch {
      toast({ variant: 'error', title: t('widget.error') });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal open={open} onOpenChange={handleOpenChange} title={t('widget.heading')} size="md">
      <Modal.Body className="gap-4">
        <Segmented<ReportKind>
          label={t('widget.kindLabel')}
          value={kind}
          onChange={setKind}
          options={[
            {
              value: 'bug',
              label: t('widget.kindBug'),
              icon: <IssueTypeIcon type="bug" className="h-4 w-4" />,
            },
            {
              value: 'task',
              label: t('widget.kindFeature'),
              icon: <IssueTypeIcon type="task" className="h-4 w-4" />,
            },
          ]}
        />
        <Input
          label={t('widget.titleLabel')}
          value={title}
          onChange={(e) => {
            setTitle(e.target.value);
            if (titleError) setTitleError(null);
          }}
          error={titleError ?? undefined}
          maxLength={MAX_TITLE_LENGTH}
          placeholder={t('widget.titlePlaceholder')}
          autoFocus
        />
        <Textarea
          label={t('widget.descriptionLabel')}
          helperText={t('widget.descriptionHint')}
          rows={4}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={t('widget.descriptionPlaceholder')}
        />
      </Modal.Body>
      <Modal.Footer>
        <Button variant="ghost" onClick={() => handleOpenChange(false)} disabled={submitting}>
          {tc('cancel')}
        </Button>
        <Button
          variant="primary"
          leftIcon={<Send className="h-4 w-4" />}
          loading={submitting}
          onClick={handleSubmit}
        >
          {t('widget.submit')}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
