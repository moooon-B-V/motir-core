'use client';

import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { CircleAlert, Pencil, Plus } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { MarkdownEditor } from '@/components/ui/MarkdownEditor';
import type { HowToTestDraftDTO } from '@/lib/dto/testInstructions';
import type { HowToTestRefusalField } from '@/lib/testInstructions/refusal';

// THE WRITE DOORS AND THE FORM (Story MOTIR-5450 · Subtask MOTIR-5455), built to
// `design/github/design-notes.md` §24, panels 13a · 13b · 13d · 13e · 13f · 13h.
//
// ⚠️ THE ABSENCE OF THIS PROVIDER IS THE ACCESS RULE. `HowToTestBlock` asks for
// the context and draws no door when there is none, so the read-only peek and
// the approval overlay — which render the same block and mount no provider —
// have no door by construction rather than by a flag each host remembers to
// pass (§24, decision 10). The item page mounts it only for an actor holding
// `work_item:edit`, which is the key both actions assert server-side anyway.
//
// ⚠️ THE FORM IS TWO FIELDS, AND THAT IS THE DESIGN'S LOUDEST DECISION (8b).
// No repository picker, no commit input, not even a read-only row: the
// repositories a record covers are DERIVED from the card's linked pull
// requests, which the rows directly above this part already show, and
// `+ Link pull request` in the same card is the door for them. A control here
// would be a second door onto one fact.
//
// ⚠️ NOT OPTIMISTIC. The saved record's author line, its history and its
// per-repository sub-blocks are all server-derived, so `router.refresh()` is
// what redraws them (`CLAUDE.md`'s page-state contract, case 2). Patching the
// body in place would show the new text beside a stale author.

/** The two fields, as the form holds them while they are being edited. */
interface HowToTestDraftState {
  bodyMd: string;
  previewPath: string;
}

export type HowToTestSaveResult =
  | { ok: true }
  | { ok: false; field: HowToTestRefusalField; error: string };

interface HowToTestWriteContextValue {
  open: boolean;
  /** `edit` when a record exists — it only changes which door is drawn. */
  mode: 'add' | 'edit';
  openForm: (mode: 'add' | 'edit') => void;
  cancel: () => void;
  save: () => void;
  draft: HowToTestDraftState;
  setBody: (value: string) => void;
  setPreviewPath: (value: string) => void;
  /** True between opening the form and the draft read answering. */
  loading: boolean;
  saving: boolean;
  dirty: boolean;
  /** The refusal, placed: beside a field, or on the form. */
  errors: PlacedErrors;
}

const HowToTestWriteContext = createContext<HowToTestWriteContextValue | null>(null);

/**
 * The write state, or `null` where no provider is mounted — which is how a
 * read-only surface gets no door. Never throws: the block is shared with hosts
 * that deliberately mount nothing.
 */
export function useHowToTestWrite(): HowToTestWriteContextValue | null {
  return useContext(HowToTestWriteContext);
}

type PlacedErrors = { bodyMd: string | null; previewPath: string | null; form: string | null };
const NO_ERRORS: PlacedErrors = { bodyMd: null, previewPath: null, form: null };

export function HowToTestWriteProvider({
  workItemId,
  identifier,
  loadDraft,
  saveHowToTest,
  children,
}: {
  workItemId: string;
  identifier: string;
  /** The draft read, handed down as a reference so this component imports no
   *  route action and stays usable from any host that has one. */
  loadDraft: (
    workItemId: string,
  ) => Promise<{ ok: true; draft: HowToTestDraftDTO } | { ok: false; error: string }>;
  saveHowToTest: (input: {
    workItemId: string;
    identifier: string;
    bodyMd: string;
    previewPath: string | null;
  }) => Promise<HowToTestSaveResult>;
  children: ReactNode;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<'add' | 'edit'>('add');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [draft, setDraft] = useState<HowToTestDraftState>({ bodyMd: '', previewPath: '' });
  const [errors, setErrors] = useState<PlacedErrors>(NO_ERRORS);

  const openForm = useCallback(
    (next: 'add' | 'edit') => {
      setMode(next);
      setOpen(true);
      setDirty(false);
      setErrors(NO_ERRORS);
      setDraft({ bodyMd: '', previewPath: '' });
      setLoading(true);
      void (async () => {
        const res = await loadDraft(workItemId);
        if (res.ok)
          setDraft({ bodyMd: res.draft.bodyMd, previewPath: res.draft.previewPath ?? '' });
        else setErrors({ ...NO_ERRORS, form: res.error });
        setLoading(false);
      })();
    },
    [loadDraft, workItemId],
  );

  const cancel = useCallback(() => {
    setOpen(false);
    setDirty(false);
    setErrors(NO_ERRORS);
    setDraft({ bodyMd: '', previewPath: '' });
  }, []);

  const save = useCallback(() => {
    setErrors(NO_ERRORS);
    setSaving(true);
    void (async () => {
      try {
        const trimmedPath = draft.previewPath.trim();
        const res = await saveHowToTest({
          workItemId,
          identifier,
          bodyMd: draft.bodyMd,
          previewPath: trimmedPath.length > 0 ? trimmedPath : null,
        });
        if (!res.ok) {
          // ⚠️ THE DRAFT SURVIVES (§24, decision 6). The body is the expensive
          // part of the input; clearing it to report a bad preview path is the
          // worst trade on this surface.
          setErrors({
            bodyMd: res.field === 'bodyMd' ? res.error : null,
            previewPath: res.field === 'previewPath' ? res.error : null,
            form: res.field === null ? res.error : null,
          });
          return;
        }
        setOpen(false);
        setDirty(false);
        router.refresh();
      } finally {
        setSaving(false);
      }
    })();
  }, [draft.bodyMd, draft.previewPath, identifier, router, saveHowToTest, workItemId]);

  const setBody = useCallback((value: string) => {
    setDirty(true);
    setDraft((d) => ({ ...d, bodyMd: value }));
  }, []);
  const setPreviewPath = useCallback((value: string) => {
    setDirty(true);
    setDraft((d) => ({ ...d, previewPath: value }));
  }, []);

  return (
    <HowToTestWriteContext.Provider
      value={{
        open,
        mode,
        openForm,
        cancel,
        save,
        draft,
        setBody,
        setPreviewPath,
        loading,
        saving,
        dirty,
        errors,
      }}
    >
      {children}
    </HowToTestWriteContext.Provider>
  );
}

/**
 * Panel 13a — **Add how to test**, the secondary button UNDER the missing
 * callout, inside the part. Not in the card head: that head is the pull
 * requests' (`+ Link pull request`), and the callout is where a reader learns
 * the record is missing, so it is where the remedy belongs (decision 1).
 */
export function AddHowToTestDoor() {
  const t = useTranslations('github.development.howToTest');
  const write = useHowToTestWrite();
  if (!write || write.open) return null;
  return (
    <div>
      <Button size="sm" variant="secondary" onClick={() => write.openForm('add')}>
        <Plus className="h-4 w-4" aria-hidden />
        {t('add')}
      </Button>
    </div>
  );
}

/**
 * Panel 13a — **Edit**, in the part head opposite the author line. A person may
 * edit a RUN's record (decision 4): the amendment's own reason is that a wrong
 * agent record could otherwise only be fixed by starting another run. Nothing is
 * destroyed — the save writes a new version and this one becomes history.
 */
export function EditHowToTestDoor() {
  const t = useTranslations('github.development.howToTest');
  const write = useHowToTestWrite();
  if (!write || write.open) return null;
  return (
    <button
      type="button"
      onClick={() => write.openForm('edit')}
      className="ml-auto inline-flex items-center gap-1.5 rounded-(--radius-control) px-1.5 py-1 font-sans text-xs font-semibold text-(--el-link) hover:underline focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
    >
      <Pencil className="h-3.5 w-3.5" aria-hidden />
      {t('edit')}
    </button>
  );
}

/** A refusal, beside the control it is about — `--el-danger-on-surface`, never
 *  `--el-danger-text` (that token is the ink FOR a danger fill). */
function Refusal({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-start gap-1.5 text-[12.5px] leading-normal text-(--el-danger-on-surface)">
      <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
      <span>{children}</span>
    </p>
  );
}

/**
 * Panels 13b · 13d · 13e — the form. TWO fields and Save / Cancel, and while it
 * saves every control is disabled, Cancel included: a half-cancelled save is a
 * state nobody can reason about.
 */
export function HowToTestForm() {
  const t = useTranslations('github.development.howToTest');
  const write = useHowToTestWrite();
  if (!write || !write.open) return null;
  const { draft, errors, saving, loading, dirty } = write;
  const busy = saving || loading;

  return (
    <div
      role="group"
      aria-label={t('form.label')}
      data-testid="how-to-test-form"
      aria-busy={saving || undefined}
      className={
        'flex min-w-0 flex-col gap-3 rounded-(--radius-card) border border-(--el-border) bg-(--el-surface-soft) p-(--spacing-card-padding) transition-opacity' +
        // Saving DIMS the form and takes every control with it, Cancel included
        // (§24's accessibility note): a half-cancelled save is a state nobody
        // can reason about. `pointer-events-none` is what reaches INSIDE the
        // editor — it has no disabled prop, and its `readOnly` swaps the whole
        // surface for a rendered view, which would make the text jump mid-save.
        (saving ? ' pointer-events-none opacity-60' : '')
      }
    >
      <div className="flex min-w-0 flex-col gap-1.5">
        <MarkdownEditor
          label={t('form.body')}
          value={draft.bodyMd}
          onChange={write.setBody}
          size="full"
          // The parity row that needed a component change (MOTIR-5458): a
          // person's fence carries its language, exactly as an agent's does.
          codeLanguage
        />
        {errors.bodyMd ? <Refusal>{errors.bodyMd}</Refusal> : null}
      </div>

      <div className="flex min-w-0 flex-col gap-1.5">
        <label
          htmlFor="how-to-test-preview-path"
          className="flex items-center gap-1.5 font-sans text-sm font-medium text-(--el-text)"
        >
          {t('form.previewPath')}
          <span className="font-normal text-(--el-text-secondary)">{t('form.optional')}</span>
        </label>
        <input
          id="how-to-test-preview-path"
          type="text"
          value={draft.previewPath}
          onChange={(e) => write.setPreviewPath(e.target.value)}
          disabled={busy}
          spellCheck={false}
          className="h-(--height-input) w-full rounded-(--radius-input) border border-(--el-input-border) bg-(--el-page-bg) px-(--spacing-input-x) font-mono text-[13px] text-(--el-text) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none disabled:cursor-not-allowed"
        />
        <p className="font-mono text-[12px] text-(--el-text-secondary)">
          {t('form.previewPathHint')}
        </p>
        {errors.previewPath ? <Refusal>{errors.previewPath}</Refusal> : null}
      </div>

      {errors.form ? <Refusal>{errors.form}</Refusal> : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={write.save} disabled={busy} loading={saving}>
          {t('form.save')}
        </Button>
        <Button size="sm" variant="ghost" onClick={write.cancel} disabled={busy}>
          {t('form.cancel')}
        </Button>
        {saving ? (
          <span role="status" className="text-xs text-(--el-text-secondary)">
            {t('form.saving')}
          </span>
        ) : dirty ? (
          <span className="text-xs text-(--el-text-secondary)">{t('form.dirty')}</span>
        ) : null}
      </div>
    </div>
  );
}
