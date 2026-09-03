'use client';

import {
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Check, ExternalLink, Globe, Info, Loader2, Plus, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { MarkdownEditor } from '@/components/ui/MarkdownEditor';
import { Modal } from '@/components/ui/Modal';
import { useToast } from '@/components/ui/Toast';
import { SettingsCard } from '@/components/settings/SettingsCard';
import {
  PUBLIC_OVERVIEW_MAX_LENGTH,
  PUBLIC_TAGLINE_MAX_LENGTH,
  PUBLIC_TAGS_MAX_COUNT,
  PUBLIC_TAG_MAX_LENGTH,
} from '@/lib/publicProjects/limits';
import { useUnsavedChangesGuard } from './useUnsavedChangesGuard';

// THE PUBLIC PAGE ROOM's island (Story MOTIR-3875 · MOTIR-4171) — the card, the
// three fields, the save bar and its six states, as `design/projects/
// public-page.mock.html` Panel B and Panel C draw them and
// `design/projects/design-notes.md` § *Public page — the room in project
// settings* specifies them. The MOUNT around it — the rail row, the page, its
// gates and the initial read — is MOTIR-4243's (`../page.tsx`).
//
// ── What it saves through, and why nothing else ───────────────────────────
//
// One `PATCH /api/projects/{key}/public-overview` (MOTIR-4114) carrying ALL
// THREE fields every time. The door's contract is a partial author — an absent
// field is untouched — and the room leans on the other half of that contract:
// a field it SENDS is written, so an emptied tagline is sent as `null` and
// clears (the partial-author test, `tests/api/public-overview-seam.test.ts`).
// There is no second service path and no gate of this island's own: the route
// asserts nothing, and `publicProjectsService.setPublicOverview` refuses a
// non-admin before any write.
//
// ── Page state after the save (CLAUDE.md § page state, rule 1) ────────────
//
// The success response IS the confirmation. The committed snapshot flips to
// the working values and nothing calls `router.refresh()`: no other surface on
// this page re-reads these three fields, and refreshing the edited fields'
// own values is what causes a visible revert.
//
// ── Errors, per field (Panel C4) ──────────────────────────────────────────
//
// The caps are enforced twice and shown once. The room checks them as the
// reader types (`lib/publicProjects/limits.ts` exists so the browser and the
// service read the SAME numbers) and blocks Save while a field is over; the
// service checks them again and the route maps its three refusals to a 422
// naming the `field`, which lands in that field's own slot with the catalog's
// copy — never the server's English. Anything else that fails the save is the
// toast, and the edits are KEPT.

export interface PublicHeroValues {
  publicOverviewMd: string | null;
  publicTagline: string | null;
  publicTags: string[];
}

export interface PublicPageEditorProps {
  /** The active project's key — the `{key}` the door takes. */
  projectKey: string;
  /** The saved values the page read (`projectsService.getPublicHero`). */
  initial: PublicHeroValues;
  /** `accessLevel === 'public'` — decides the not-yet-public band and the head link. */
  isPublic: boolean;
  /** The project's page on the PUBLIC host (`publicProjectUrl`), resolved server-side. */
  publicPageUrl: string;
}

interface Working {
  tagline: string;
  tags: string[];
  readme: string;
}

type FieldKey = 'tagline' | 'tags' | 'readme';
type FieldErrors = Partial<Record<FieldKey, string>>;

/** The door's body keys → the room's fields, for a 422 that names one. */
const SERVER_FIELD: Record<string, FieldKey> = {
  publicTagline: 'tagline',
  publicTags: 'tags',
  publicOverviewMd: 'readme',
};

/** How long *Saved* stays in the footer before the hint goes quiet again. */
const SAVED_VISIBLE_MS = 2500;

function toWorking(values: PublicHeroValues): Working {
  return {
    tagline: values.publicTagline ?? '',
    tags: values.publicTags,
    readme: values.publicOverviewMd ?? '',
  };
}

/** Whether two working states are equal (the dirty check). Exported for the test. */
export function publicHeroEqual(a: Working, b: Working): boolean {
  return (
    a.tagline === b.tagline &&
    a.readme === b.readme &&
    a.tags.length === b.tags.length &&
    a.tags.every((tag, i) => tag === b.tags[i])
  );
}

export function PublicPageEditor({
  projectKey,
  initial,
  isPublic,
  publicPageUrl,
}: PublicPageEditorProps) {
  const t = useTranslations('settings');
  const tc = useTranslations('common');
  const { toast } = useToast();
  const router = useRouter();

  const [committed, setCommitted] = useState<Working>(() => toWorking(initial));
  const [working, setWorking] = useState<Working>(() => toWorking(initial));
  const [saving, setSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const [serverErrors, setServerErrors] = useState<FieldErrors>({});
  const [tagDraft, setTagDraft] = useState<string | null>(null);
  const [tagDraftError, setTagDraftError] = useState<string | null>(null);

  const dirty = !publicHeroEqual(working, committed);

  // The caps, checked as the reader types — the same numbers the service
  // enforces, so a field the room lets through is one the door accepts.
  const clientErrors = useMemo<FieldErrors>(() => {
    const errors: FieldErrors = {};
    if (working.tagline.trim().length > PUBLIC_TAGLINE_MAX_LENGTH) {
      errors.tagline = t('publicPage.error.taglineTooLong', { max: PUBLIC_TAGLINE_MAX_LENGTH });
    }
    if (
      working.tags.length > PUBLIC_TAGS_MAX_COUNT ||
      working.tags.some((tag) => tag.length > PUBLIC_TAG_MAX_LENGTH)
    ) {
      errors.tags = t('publicPage.error.tagsInvalid', {
        maxCount: PUBLIC_TAGS_MAX_COUNT,
        maxLength: PUBLIC_TAG_MAX_LENGTH,
      });
    }
    if (working.readme.trim().length > PUBLIC_OVERVIEW_MAX_LENGTH) {
      errors.readme = t('publicPage.error.overviewTooLong', { max: PUBLIC_OVERVIEW_MAX_LENGTH });
    }
    return errors;
  }, [working, t]);

  const errors: FieldErrors = { ...serverErrors, ...clientErrors };
  if (tagDraftError) errors.tags = tagDraftError;
  const invalid = Boolean(errors.tagline || errors.tags || errors.readme);
  const canSave = dirty && !saving && !invalid;

  // *Saved* clears after a beat (Panel C5), and on the next edit.
  useEffect(() => {
    if (!justSaved) return;
    const handle = window.setTimeout(() => setJustSaved(false), SAVED_VISIBLE_MS);
    return () => window.clearTimeout(handle);
  }, [justSaved]);

  const patch = useCallback((next: Partial<Working>, touched?: FieldKey) => {
    setJustSaved(false);
    if (touched) {
      setServerErrors((prev) => {
        if (!prev[touched]) return prev;
        const rest = { ...prev };
        delete rest[touched];
        return rest;
      });
    }
    setWorking((prev) => ({ ...prev, ...next }));
  }, []);

  const reset = useCallback(() => {
    setWorking(committed);
    setServerErrors({});
    setTagDraft(null);
    setTagDraftError(null);
    setJustSaved(false);
  }, [committed]);

  const save = useCallback(() => {
    if (!canSave) return;
    const next = working;
    setSaving(true);
    setJustSaved(false);
    setServerErrors({});
    void fetch(`/api/projects/${encodeURIComponent(projectKey)}/public-overview`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      // All three, every time: an emptied tagline is `null` so it CLEARS
      // (an absent field would be left untouched — the door's partial author).
      body: JSON.stringify({
        publicOverviewMd: next.readme,
        publicTagline: next.tagline.trim() === '' ? null : next.tagline,
        publicTags: next.tags,
      }),
    })
      .then(async (res) => {
        setSaving(false);
        if (res.ok) {
          setCommitted(next);
          setJustSaved(true);
          return;
        }
        const body = (await res.json().catch(() => null)) as { field?: string } | null;
        const field = body?.field ? SERVER_FIELD[body.field] : undefined;
        if (res.status === 422 && field) {
          // The catalog's copy for the field, not the server's message.
          setServerErrors({
            [field]:
              field === 'tagline'
                ? t('publicPage.error.taglineTooLong', { max: PUBLIC_TAGLINE_MAX_LENGTH })
                : field === 'tags'
                  ? t('publicPage.error.tagsInvalid', {
                      maxCount: PUBLIC_TAGS_MAX_COUNT,
                      maxLength: PUBLIC_TAG_MAX_LENGTH,
                    })
                  : t('publicPage.error.overviewTooLong', { max: PUBLIC_OVERVIEW_MAX_LENGTH }),
          });
          return;
        }
        toast({ variant: 'error', title: t('publicPage.error.saveFailed') });
      })
      .catch(() => {
        setSaving(false);
        toast({ variant: 'error', title: t('publicPage.error.saveFailed') });
      });
  }, [canSave, working, projectKey, t, toast]);

  // ── Tags — the two-state Add control panel 1c decided ───────────────────
  const removeTag = useCallback(
    (tag: string) => {
      setTagDraftError(null);
      patch({ tags: working.tags.filter((existing) => existing !== tag) }, 'tags');
    },
    [patch, working.tags],
  );

  const commitTagDraft = useCallback(() => {
    const value = (tagDraft ?? '').trim();
    if (value === '') {
      setTagDraft(null);
      setTagDraftError(null);
      return;
    }
    if (value.length > PUBLIC_TAG_MAX_LENGTH || working.tags.length >= PUBLIC_TAGS_MAX_COUNT) {
      setTagDraftError(
        t('publicPage.error.tagsInvalid', {
          maxCount: PUBLIC_TAGS_MAX_COUNT,
          maxLength: PUBLIC_TAG_MAX_LENGTH,
        }),
      );
      return;
    }
    setTagDraft(null);
    setTagDraftError(null);
    if (working.tags.some((tag) => tag.toLowerCase() === value.toLowerCase())) return;
    patch({ tags: [...working.tags, value] }, 'tags');
  }, [tagDraft, working.tags, patch, t]);

  const onTagDraftKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      commitTagDraft();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      setTagDraft(null);
      setTagDraftError(null);
    }
  };

  // ── Leaving with edits pending asks first (panel 1d) ────────────────────
  const guard = useUnsavedChangesGuard(dirty);
  const discardAndLeave = () => {
    const href = guard.discard();
    reset();
    if (href) router.push(href);
  };

  const tagsLabelId = useId();
  const tagsHelperId = useId();
  const tagsErrorId = useId();
  const readmeHelperId = useId();
  const readmeErrorId = useId();
  const tagInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (tagDraft !== null) tagInputRef.current?.focus();
  }, [tagDraft]);

  const viewLink = isPublic ? (
    <a
      href={publicPageUrl}
      target="_blank"
      rel="noreferrer"
      className="text-(--el-link) hover:text-(--el-link-pressed) inline-flex items-center gap-1.5 font-sans text-xs font-medium"
      data-testid="public-page-view-link"
    >
      <ExternalLink className="size-3.5" aria-hidden />
      {t('publicPage.viewPublicPage')}
    </a>
  ) : null;

  return (
    <>
      <SettingsCard
        icon={<Globe className="size-[17px]" aria-hidden />}
        title={t('publicPage.card.title')}
        subtitle={t('publicPage.card.subtitle')}
        action={viewLink}
        testId="public-page-editor"
        footer={
          <div className="bg-(--el-surface-soft) border-(--el-border-soft) flex items-center justify-end gap-2.5 border-t px-(--spacing-card-padding) py-3.5">
            <FooterHint invalid={invalid} saving={saving} saved={justSaved} dirty={dirty} t={t} />
            <Button variant="secondary" onClick={reset} disabled={!dirty || saving}>
              {tc('cancel')}
            </Button>
            <Button
              variant="primary"
              onClick={save}
              loading={saving}
              disabled={!canSave}
              data-testid="public-page-save"
            >
              {t('publicPage.footer.save')}
            </Button>
          </div>
        }
      >
        {!isPublic ? (
          <div
            className="flex items-start gap-2 rounded-(--radius-card) bg-(--el-tint-sky) p-(--spacing-card-padding)"
            data-testid="public-page-not-public"
          >
            <Info className="text-(--el-text-strong) mt-0.5 size-4 shrink-0" aria-hidden />
            <p className="font-sans text-xs text-(--el-text-strong)">
              <b className="font-semibold">{t('publicPage.notPublic.lead')}</b>{' '}
              {t.rich('publicPage.notPublic.body', {
                link: (chunks) => (
                  <Link
                    href="/settings/project/members"
                    className="font-medium underline underline-offset-2"
                  >
                    {chunks}
                  </Link>
                ),
              })}
            </p>
          </div>
        ) : null}

        {/* Tagline */}
        <Input
          label={t('publicPage.tagline.label')}
          value={working.tagline}
          onChange={(event) => patch({ tagline: event.target.value }, 'tagline')}
          placeholder={t('publicPage.tagline.placeholder')}
          helperText={t('publicPage.tagline.help', { max: PUBLIC_TAGLINE_MAX_LENGTH })}
          error={errors.tagline}
          errorVariant="box"
          disabled={saving}
          data-testid="public-page-tagline"
        />

        {/* Tags */}
        <div
          className="flex flex-col gap-1.5"
          role="group"
          aria-labelledby={tagsLabelId}
          aria-describedby={errors.tags ? tagsErrorId : tagsHelperId}
        >
          <span id={tagsLabelId} className="font-sans text-sm font-medium text-(--el-text)">
            {t('publicPage.tags.label')}
          </span>
          <div className="flex flex-wrap items-center gap-2">
            {working.tags.length === 0 ? (
              <span className="text-(--el-text-secondary) font-sans text-xs">
                {t('publicPage.tags.empty')}
              </span>
            ) : null}
            {working.tags.map((tag) => (
              <span
                key={tag}
                className="inline-flex items-center gap-1 rounded-(--radius-badge) border border-(--el-chip-border) bg-(--el-chip-bg) px-(--spacing-chip-x) py-(--spacing-chip-y) font-sans text-xs font-medium text-(--el-text-secondary)"
              >
                {tag}
                <button
                  type="button"
                  aria-label={t('publicPage.tags.remove', { tag })}
                  onClick={() => removeTag(tag)}
                  disabled={saving}
                  className="inline-flex size-4 items-center justify-center rounded-full text-(--el-text-muted) hover:bg-(--el-surface) hover:text-(--el-text) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color)"
                >
                  <X className="size-3" aria-hidden />
                </button>
              </span>
            ))}
            {tagDraft === null ? (
              <Button
                variant="secondary"
                size="sm"
                leftIcon={<Plus className="size-4" aria-hidden />}
                onClick={() => setTagDraft('')}
                disabled={saving || working.tags.length >= PUBLIC_TAGS_MAX_COUNT}
              >
                {t('publicPage.tags.add')}
              </Button>
            ) : (
              <div className="w-44">
                <Input
                  ref={tagInputRef}
                  aria-label={t('publicPage.tags.add')}
                  placeholder={t('publicPage.tags.addPlaceholder')}
                  value={tagDraft}
                  onChange={(event) => {
                    setTagDraftError(null);
                    setTagDraft(event.target.value);
                  }}
                  onKeyDown={onTagDraftKeyDown}
                  onBlur={commitTagDraft}
                  data-testid="public-page-tag-draft"
                />
              </div>
            )}
            <span className="text-(--el-text-secondary) ml-auto font-sans text-xs">
              {t('publicPage.tags.count', {
                count: working.tags.length,
                maxCount: PUBLIC_TAGS_MAX_COUNT,
              })}
            </span>
          </div>
          {errors.tags ? (
            <p
              id={tagsErrorId}
              role="alert"
              className="text-(--el-danger-on-surface) font-sans text-xs"
            >
              {errors.tags}
            </p>
          ) : (
            <p id={tagsHelperId} className="text-(--el-text-helper) font-sans text-xs">
              {t('publicPage.tags.help', {
                maxCount: PUBLIC_TAGS_MAX_COUNT,
                maxLength: PUBLIC_TAG_MAX_LENGTH,
              })}
            </p>
          )}
        </div>

        {/* README — the editor IS the preview (6.16: the page is the preview). */}
        <div
          className="flex flex-col gap-1.5"
          aria-describedby={errors.readme ? readmeErrorId : readmeHelperId}
          data-invalid={errors.readme ? 'true' : undefined}
        >
          <div
            className={
              errors.readme ? 'rounded-(--radius-input) ring-1 ring-(--el-danger)' : undefined
            }
          >
            <MarkdownEditor
              value={working.readme}
              onChange={(value) => patch({ readme: value }, 'readme')}
              label={t('publicPage.readme.label')}
              size="full"
            />
          </div>
          {errors.readme ? (
            <p
              id={readmeErrorId}
              role="alert"
              className="text-(--el-danger-on-surface) font-sans text-xs"
            >
              {errors.readme}
            </p>
          ) : (
            <p id={readmeHelperId} className="text-(--el-text-helper) font-sans text-xs">
              {working.readme.trim() === ''
                ? t('publicPage.readme.emptyHelp')
                : t('publicPage.readme.help', { max: PUBLIC_OVERVIEW_MAX_LENGTH })}
            </p>
          )}
        </div>
      </SettingsCard>

      {/* Discard unsaved changes? — panel 1d's confirm, on an in-app link click. */}
      <Modal
        open={guard.pendingHref !== null}
        onOpenChange={(open) => {
          if (!open) guard.keepEditing();
        }}
        role="alertdialog"
        size="sm"
        title={t('publicPage.discard.title')}
      >
        <Modal.Footer>
          <Button variant="ghost" onClick={guard.keepEditing}>
            {t('publicPage.discard.keep')}
          </Button>
          <Button variant="danger" onClick={discardAndLeave} data-testid="public-page-discard">
            {t('publicPage.discard.discard')}
          </Button>
        </Modal.Footer>
      </Modal>
    </>
  );
}

// The footer hint — one word per state, never colour alone (Panel C2–C5;
// the Details card's `SaveStatus` grammar on the AI-planning footer band).
function FooterHint({
  invalid,
  saving,
  saved,
  dirty,
  t,
}: {
  invalid: boolean;
  saving: boolean;
  saved: boolean;
  dirty: boolean;
  t: (key: string) => string;
}) {
  let body: ReactNode = null;
  let tone = 'text-(--el-text-secondary)';
  if (saving) {
    body = (
      <>
        <Loader2 className="size-3.5 animate-spin" aria-hidden />
        {t('publicPage.footer.saving')}
      </>
    );
  } else if (invalid) {
    body = t('publicPage.footer.invalid');
  } else if (saved) {
    tone = 'text-(--el-success) font-medium';
    body = (
      <>
        <Check className="size-3.5" aria-hidden />
        {t('publicPage.footer.saved')}
      </>
    );
  } else if (dirty) {
    body = (
      <>
        <span className="h-2 w-2 rounded-full bg-(--el-warning)" aria-hidden />
        {t('publicPage.footer.dirty')}
      </>
    );
  }
  return (
    <span
      role={saving || saved ? 'status' : undefined}
      className={`mr-auto flex items-center gap-1.5 font-sans text-xs ${tone}`}
      data-testid="public-page-footer-hint"
    >
      {body}
    </span>
  );
}
