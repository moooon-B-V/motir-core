'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ChevronDown, Sparkles } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/components/ui/Toast';
import { MarkdownEditor } from '@/components/ui/MarkdownEditor';
import { DatePicker } from '@/components/ui/DatePicker';
import { uploadIssueAttachment } from '@/lib/blob/uploadClient';
import { cn } from '@/lib/utils/cn';
import { TypePicker } from '@/components/issues/TypePicker';
import { ParentPicker } from '@/components/issues/ParentPicker';
import { PriorityPicker } from '@/components/issues/PriorityPicker';
import { CreateIssueLinksField, type PendingLink } from './CreateIssueLinksField';
import { createIssueAction } from '../issues/actions';
import type { WorkItemKindDto, WorkItemPriorityDto } from '@/lib/dto/workItems';

// The create-issue modal (Subtask 2.3.3, pickers wired in 2.3.4). Collects the
// field set and dispatches the `createIssueAction` Server Action; the service
// owns key allocation + the create revision. Open state lives in
// CreateIssueProvider (so the top-nav "+" button, the global "C" shortcut, and
// the ⌘K command all drive the same dialog) — this component reads it via props.
//
// Type + Parent are the 2.3.4 pickers (filtered so an illegal parent can't be
// constructed; an illegal pair from a forged payload still 422s and surfaces
// inline on the Parent field). STILL a stub: Description is a plain <textarea>
// (2.3.6 swaps in the 2.3.5 MarkdownEditor). DEFERRED: Assignee (needs a
// workspace-member combobox). Reporter is never a field — set server-side.

const MAX_TITLE_LENGTH = 200;

export interface CreateIssueModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Called after a work item is successfully created (alongside the
   * `router.refresh()`). Lets client-fetched surfaces that `router.refresh()`
   * can't reach — e.g. the board — refetch. Optional.
   */
  onCreated?: () => void;
}

export function CreateIssueModal({ open, onOpenChange, onCreated }: CreateIssueModalProps) {
  const t = useTranslations('shell');
  const tc = useTranslations('common');
  const tErr = useTranslations('errors');
  const router = useRouter();
  const { toast } = useToast();
  const [isPending, startTransition] = useTransition();

  const [kind, setKind] = useState<WorkItemKindDto>('task');
  const [parentId, setParentId] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [explanation, setExplanation] = useState('');
  const [explanationOpen, setExplanationOpen] = useState(false);
  const [priority, setPriority] = useState<WorkItemPriorityDto>('medium');
  // Due date as the DatePicker's ISO `YYYY-MM-DD` value (or null) — converted to
  // a full UTC ISO string on submit, like the edit form. Optional (2.3.12).
  const [dueDate, setDueDate] = useState<string | null>(null);
  const [links, setLinks] = useState<PendingLink[]>([]);
  const [titleError, setTitleError] = useState<string | null>(null);
  const [parentError, setParentError] = useState<string | null>(null);
  const [linksError, setLinksError] = useState<string | null>(null);

  // Reveal the Explanation editor when it's expanded: the field area scrolls
  // (the dialog height is fixed), so bring the section into view rather than
  // leaving it below the fold.
  const explanationRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (explanationOpen) {
      explanationRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [explanationOpen]);

  const trimmedTitle = title.trim();
  const canSubmit = trimmedTitle.length > 0 && trimmedTitle.length <= MAX_TITLE_LENGTH;

  function reset() {
    setKind('task');
    setParentId(null);
    setTitle('');
    setDescription('');
    setExplanation('');
    setExplanationOpen(false);
    setPriority('medium');
    setDueDate(null);
    setLinks([]);
    setTitleError(null);
    setParentError(null);
    setLinksError(null);
  }

  function close() {
    reset();
    onOpenChange(false);
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setTitleError(null);
    setLinksError(null);
    if (trimmedTitle.length === 0) {
      setTitleError(t('createIssue.titleRequired'));
      return;
    }
    if (trimmedTitle.length > MAX_TITLE_LENGTH) {
      setTitleError(t('createIssue.titleTooLong', { max: MAX_TITLE_LENGTH }));
      return;
    }
    startTransition(async () => {
      const result = await createIssueAction({
        kind,
        title: trimmedTitle,
        descriptionMd: description.trim() ? description : null,
        explanationMd: explanation.trim() ? explanation : null,
        priority,
        parentId,
        // Only send dueDate when set (UTC-safe full ISO, like the edit form), so
        // a plain create's payload (and its exact-match test) stays unchanged.
        ...(dueDate ? { dueDate: new Date(`${dueDate}T00:00:00.000Z`).toISOString() } : {}),
        // Only send links when present, so a plain create's payload (and its
        // exact-match test) stays unchanged. Strip the carried summary — the
        // service takes just the (relationship, target) pair.
        ...(links.length
          ? { links: links.map((l) => ({ targetId: l.targetId, relationship: l.relationship })) }
          : {}),
      });
      if (result.ok) {
        toast({
          variant: 'success',
          title: t('createIssue.created', { identifier: result.identifier }),
          description: trimmedTitle,
        });
        close();
        router.refresh();
        onCreated?.();
      } else if (result.field === 'parent') {
        // The picker pre-filters to legal parents, so this only fires on a
        // forged/edge payload (e.g. subtask + no parent) — surface it inline.
        setParentError(result.error);
      } else if (result.field === 'links') {
        // A bad pending link (cycle / cross-workspace) — the whole create was
        // rejected (atomic); surface it on the Linked-issues section.
        setLinksError(result.error);
      } else {
        toast({ variant: 'error', title: result.error });
      }
    });
  }

  return (
    <Modal
      open={open}
      onOpenChange={(o) => (o ? onOpenChange(true) : close())}
      size="lg"
      title={t('createIssue.title')}
    >
      <form className="mt-4 flex min-h-0 flex-1 flex-col" onSubmit={handleSubmit}>
        {/* Scrollable field area — the dialog height is fixed (Modal caps at
            90vh), so the fields scroll and the footer below stays pinned.
            `overflow-y-auto` also clips the X axis, so pad (p-1.5) + pull the
            margin back (-m-1.5) to give focus rings (ring-2 + offset-2 ≈ 4px)
            room instead of clipping them against the scroll edge. */}
        <div className="-m-1.5 flex flex-col gap-3 overflow-y-auto p-1.5">
          <div className="flex flex-col gap-1 font-sans text-sm">
            <span className="text-(--el-text) font-medium">{t('createIssue.type')}</span>
            <TypePicker
              value={kind}
              onChange={(v) => {
                setKind(v);
                setParentError(null); // a type change re-scopes the parent picker
              }}
              disabled={isPending}
            />
          </div>

          <div className="flex flex-col gap-1 font-sans text-sm">
            <span className="text-(--el-text) font-medium">{t('createIssue.parent')}</span>
            <ParentPicker
              childType={kind}
              value={parentId}
              onChange={(id) => {
                setParentId(id);
                setParentError(null);
              }}
              error={parentError}
              disabled={isPending}
            />
          </div>

          <Input
            label={t('createIssue.titleLabel')}
            value={title}
            onChange={(e) => {
              setTitle(e.target.value);
              if (titleError) setTitleError(null);
            }}
            error={titleError ?? undefined}
            maxLength={MAX_TITLE_LENGTH}
            placeholder={t('createIssue.titlePlaceholder')}
            disabled={isPending}
            autoFocus
            required
          />

          {/* The MarkdownEditor (min, with file upload) renders its own label
            (also its aria-label) — no external span, else it shows twice. */}
          <MarkdownEditor
            label={t('createIssue.description')}
            value={description}
            onChange={setDescription}
            size="min"
            onFileUpload={(f) => uploadIssueAttachment(f, tErr)}
          />

          {/* Explanation — the "why this matters" axis (Story 1.4), per
            design/work-items/create.png panel 3: a collapsible, OPTIONAL
            markdown section. "Draft with AI" is the Epic-7 planning layer
            (disabled until it ships); a human can author it here today. */}
          <div ref={explanationRef} className="flex scroll-mt-2 flex-col gap-1.5 font-sans text-sm">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setExplanationOpen((o) => !o)}
                aria-expanded={explanationOpen}
                className="text-(--el-text) flex items-center gap-1.5 font-medium focus-visible:outline-none"
                disabled={isPending}
              >
                <ChevronDown
                  className={cn('h-4 w-4 transition-transform', !explanationOpen && '-rotate-90')}
                  aria-hidden
                />
                {t('createIssue.explanation')}
              </button>
              <span className="text-(--el-text-secondary)">{t('createIssue.explanationHint')}</span>
              {explanationOpen ? (
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  leftIcon={<Sparkles className="h-3.5 w-3.5" />}
                  className="ml-auto"
                  disabled
                  title={t('createIssue.draftWithAiTooltip')}
                >
                  {t('createIssue.draftWithAi')}
                </Button>
              ) : null}
            </div>
            {explanationOpen ? (
              <MarkdownEditor
                label={t('createIssue.explanation')}
                value={explanation}
                onChange={setExplanation}
                size="min"
                onFileUpload={(f) => uploadIssueAttachment(f, tErr)}
              />
            ) : (
              <span className="text-xs text-(--el-text-secondary)">
                {t('createIssue.explanationSkip')}
              </span>
            )}
          </div>

          <div className="flex flex-col gap-1 font-sans text-sm">
            <span className="text-(--el-text) font-medium">{t('createIssue.priority')}</span>
            <PriorityPicker value={priority} onChange={setPriority} disabled={isPending} />
          </div>

          {/* Due date (Subtask 2.3.12) — per design/work-items/create.mock.html:
              a DatePicker row after Priority, mirroring Jira + the edit form.
              Optional; collected here, written with the issue on create. */}
          <div className="flex flex-col gap-1 font-sans text-sm">
            <span className="text-(--el-text) font-medium">Due date</span>
            <DatePicker
              aria-label="Due date"
              value={dueDate}
              onChange={setDueDate}
              disabled={isPending}
            />
          </div>

          {/* Linked issues (Subtask 2.4.10) — per design/work-items/links.mock.html
              panel 5. Collected here, written atomically when the issue is
              created. create.pen designed this section; 2.3.3/2.3.4 shipped the
              modal without it. */}
          <CreateIssueLinksField
            links={links}
            onChange={(next) => {
              setLinks(next);
              if (linksError) setLinksError(null);
            }}
            disabled={isPending}
            error={linksError}
          />
        </div>

        <Modal.Footer className="shrink-0">
          <Button type="button" variant="ghost" onClick={close} disabled={isPending}>
            {tc('cancel')}
          </Button>
          <Button type="submit" variant="primary" disabled={!canSubmit} loading={isPending}>
            {t('createIssue.create')}
          </Button>
        </Modal.Footer>
      </form>
    </Modal>
  );
}
