'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { CircleCheckBig, Send, Sparkles } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { Textarea } from '@/components/ui/Textarea';
import { Button } from '@/components/ui/Button';
import { Segmented } from '@/components/ui/Segmented';
import { useToast } from '@/components/ui/Toast';
import { IssueTypeIcon } from '@/components/issues/IssueTypeIcon';
import { useOpenPlanningWorkspace } from '@/lib/hooks/useOpenPlanningWorkspace';
import { debugSeedBody, handSurfaceSeed } from '@/lib/planning/surfaceSeed';

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
//
// ── THE DEBUG OFFER (Story MOTIR-7042 · MOTIR-7050) ──────────────────────────
// Built FROM `design/triage/report-widget--debug-offer.mock.html` and § "The
// Debug with Motir AI offer" of `design/triage/design-notes.md`. When a BUG is
// filed and the actor may start a Motir AI turn (`canDebug` — the orb's own gate),
// the widget does NOT close on the 201 and fires no Toast: its body becomes a
// success state carrying "Debug with Motir AI". Pressing it is the go (ADR
// `conversation-turn-intent.md` AMENDMENT 1, A1.3): the widget closes, the one
// Motir AI surface opens on the PROJECT conversation, and the person's own title
// and description are sent ONCE through the ask door, anchored on the triage bug
// just filed. Close sends nothing. In every other case — a Feature, no Motir AI,
// no `ai:plan` — nothing here renders and the widget closes and toasts exactly as
// it always has: no dimmed button, no "ask an admin" line.

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
  /**
   * Offer "Debug with Motir AI" after a BUG is filed (MOTIR-7050). The layout's
   * `showPlanWithAi` — Motir AI configured, an active project, `ai:plan` — handed
   * down through `ReportProvider`, so the offer and the orb share one gate.
   */
  canDebug?: boolean;
}

/** The bug just filed, held while the success state offers to debug it. */
interface FiledBug {
  key: string;
  title: string;
  /** The seeded turn's body — the person's words, word for word (A1.3). */
  body: string;
}

export function ReportWidgetModal({
  open,
  onOpenChange,
  projectKey,
  onSubmitted,
  canDebug = false,
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
  // The SUCCESS STATE (MOTIR-7050): set only when the offer applies.
  const [filed, setFiled] = useState<FiledBug | null>(null);
  // The press opens the SAME surface the orb's rows open, on the project
  // conversation — never a work-item launch: the anchored thread submits through
  // the plan-change path, which never reads a turn as a report.
  const { open: openWorkspace } = useOpenPlanningWorkspace({ kind: 'project' });

  function reset() {
    setKind('bug');
    setTitle('');
    setDescription('');
    setTitleError(null);
    setFiled(null);
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

      if (kind === 'bug' && canDebug) {
        // OFFERED: stay open on the success state. The two lines the Toast would
        // have said head it instead, so no Toast fires.
        setFiled({
          key: result.identifier,
          title: trimmed,
          body: debugSeedBody(trimmed, description),
        });
      } else {
        toast({
          variant: 'success',
          title: t('widget.submitted'),
          description: t('widget.submittedDetail', { key: result.identifier }),
        });
        reset();
        onOpenChange(false);
      }
      // The item exists either way, so both surfaces it lands on update now:
      // the inbox queue is a client island that refetches on this tick, and the
      // server-rendered bits (the triage count) take the refresh.
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

  /**
   * THE PRESS IS THE GO. Hand the seeded turn to the surface (page memory, never
   * the address), close the widget, then open the project conversation — whose
   * rail sends it once, claimed under the triage bug's key.
   */
  function startDebug(bug: FiledBug) {
    handSurfaceSeed({ kind: 'send', body: bug.body, anchorKey: bug.key });
    handleOpenChange(false);
    openWorkspace();
  }

  if (filed) {
    return (
      <Modal open={open} onOpenChange={handleOpenChange} title={t('widget.heading')} size="md">
        <Modal.Body className="gap-4" data-testid="report-debug-offer">
          <div role="status" className="flex items-start gap-2.5">
            <CircleCheckBig
              className="mt-px size-4 flex-none text-(--el-success)"
              aria-hidden="true"
            />
            <span>
              <span className="block text-sm font-medium text-(--el-text)">
                {t('widget.submitted')}
              </span>
              <span className="mt-0.5 block text-[13px] text-(--el-text-secondary)">
                {t('widget.submittedDetail', { key: filed.key })}
              </span>
            </span>
          </div>
          <div
            data-testid="report-debug-filed"
            className="flex items-center gap-2 rounded-(--radius-control) border border-(--el-border) bg-(--el-card) px-(--spacing-control-x) py-(--spacing-control-y) text-[13px]"
          >
            <IssueTypeIcon type="bug" className="size-4 flex-none" />
            <span className="font-mono text-xs font-medium text-(--el-text-identifier)">
              {filed.key}
            </span>
            <span className="min-w-0 truncate text-(--el-text)">{filed.title}</span>
          </div>
          <p
            id="report-debug-offer-hint"
            className="m-0 text-[13px] leading-relaxed text-(--el-text-secondary)"
          >
            {t.rich('widget.debugOffer.hint', {
              b: (chunks) => <b className="font-semibold text-(--el-text)">{chunks}</b>,
            })}
          </p>
        </Modal.Body>
        <Modal.Footer>
          <Button variant="ghost" onClick={() => handleOpenChange(false)}>
            {tc('close')}
          </Button>
          <Button
            variant="primary"
            leftIcon={<Sparkles className="h-4 w-4" aria-hidden="true" />}
            aria-describedby="report-debug-offer-hint"
            onClick={() => startDebug(filed)}
          >
            {t('widget.debugOffer.action')}
          </Button>
        </Modal.Footer>
      </Modal>
    );
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
