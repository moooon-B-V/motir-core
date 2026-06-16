'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import {
  Check,
  CheckCheck,
  Code2,
  Minus,
  PencilLine,
  Plus,
  RotateCw,
  Route,
  TriangleAlert,
  X,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Pill } from '@/components/ui/Pill';
import { Button, buttonVariants } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { MarkdownEditor } from '@/components/ui/MarkdownEditor';
import { MarkdownView } from '@/components/ui/MarkdownView';
import { useToast } from '@/components/ui/Toast';
import type { PublicProjectOverviewDto } from '@/lib/dto/publicProjects';
import {
  PUBLIC_TAGLINE_MAX_LENGTH,
  PUBLIC_TAGS_MAX_COUNT,
  PUBLIC_TAG_MAX_LENGTH,
} from '@/lib/publicProjects/limits';
import { savePublicOverviewAction } from '../p/[identifier]/overview-actions';

// PublicOverviewEditor (Story 6.16 · Subtask 6.16.5 · design/public-projects
// Panels 1b / 1c / 1d) — the on-page admin "Edit page" affordance + in-place,
// WYSIWYG editor over the public Overview landing. Mounted ONLY when the viewer
// can manage the project (`overview.viewerCanManage`), so an anonymous reader /
// crawler never loads this island — they get the server-rendered read hero +
// body (the crawlable path in page.tsx). Because the edited values are now
// CLIENT-owned, this island renders the hero + body ITSELF from local state (the
// "client island over a server page" rule): a Save keeps the optimistic value
// and the read view reflects it WITHOUT a whole-tree refresh (inline-edit rule).
//
// Placement note: the design draws the "Edit page" affordance + Editing chip in
// the shared public TOP BAR, but that bar + banner are server-rendered LAYOUT
// chrome shared across all five public tabs; wiring edit-mode client state
// through the layout for a single tab would touch the other four. So the
// affordance + edit chrome render page-level here (the card scopes the island
// "over the public Overview page"); the shared chrome stays untouched.

const TAG_TONES = [
  'border-transparent bg-(--el-tint-lavender) text-(--el-text-strong)',
  'border-transparent bg-(--el-tint-mint) text-(--el-text-strong)',
  '',
];

function compact(n: number): string {
  if (n >= 1000) {
    const k = n / 1000;
    return `${k % 1 === 0 ? k.toFixed(0) : k.toFixed(1)}k`;
  }
  return String(n);
}

function sameTags(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((t, i) => t === b[i]);
}

export interface PublicOverviewEditorProps {
  overview: PublicProjectOverviewDto;
  roadmapHref: string;
  /** The signed-in admin's display name (for the "Name · Admin" identity). */
  adminName: string;
  /** The static FAQ block (server-rendered, passed through unchanged). */
  faq: ReactNode;
  /** The Links / At-a-glance sidebar (server-rendered, passed through unchanged). */
  sidebar: ReactNode;
  /**
   * The hero's "Submit a request" CTA. `PublicSubmitRequest` is an async SERVER
   * component (it reads the session), so it CANNOT be imported into this client
   * island — it's rendered on the server and threaded in as a node, like `faq` /
   * `sidebar`. (The CTA is static — it never reflects the edited values.)
   */
  submitButton: ReactNode;
  /**
   * Open straight into edit mode on mount. Set by the page when the URL carries
   * `?edit=1` — the deep link the Settings "Edit on the public page →" entry
   * (Subtask 6.16.6) uses so an admin lands here already editing, rather than
   * having to click the "Edit page" affordance.
   */
  initialEditing?: boolean;
}

export function PublicOverviewEditor({
  overview,
  roadmapHref,
  adminName,
  faq,
  sidebar,
  submitButton,
  initialEditing = false,
}: PublicOverviewEditorProps) {
  const t = useTranslations('publicProjects');
  const { toast } = useToast();

  const [editing, setEditing] = useState(initialEditing);

  // The three editable fields + their last-saved baselines (the optimistic
  // value IS the committed value on success — no tree refresh).
  const [tagline, setTagline] = useState(overview.publicTagline ?? '');
  const [tags, setTags] = useState<string[]>(overview.publicTags);
  const [overviewMd, setOverviewMd] = useState(overview.publicOverviewMd ?? '');
  const [savedTagline, setSavedTagline] = useState(overview.publicTagline ?? '');
  const [savedTags, setSavedTags] = useState<string[]>(overview.publicTags);
  const [savedOverviewMd, setSavedOverviewMd] = useState(overview.publicOverviewMd ?? '');

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [guardOpen, setGuardOpen] = useState(false);

  // Add-tag is a two-state affordance: a "+ Add tag" button that swaps to a
  // small inline input (design Panel 1c / 1d).
  const [addingTag, setAddingTag] = useState(false);
  const [newTag, setNewTag] = useState('');
  const newTagRef = useRef<HTMLInputElement>(null);

  const dirty =
    tagline !== savedTagline || overviewMd !== savedOverviewMd || !sameTags(tags, savedTags);

  // Warn on browser navigation away with pending edits (the unsaved-changes
  // guard's navigate-away arm; the in-app Cancel arm is the guard dialog below).
  useEffect(() => {
    if (!editing || !dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [editing, dirty]);

  useEffect(() => {
    if (addingTag) newTagRef.current?.focus();
  }, [addingTag]);

  function enterEdit() {
    setSaveError(null);
    setEditing(true);
  }

  function leaveEdit() {
    setTagline(savedTagline);
    setTags(savedTags);
    setOverviewMd(savedOverviewMd);
    setAddingTag(false);
    setNewTag('');
    setSaveError(null);
    setGuardOpen(false);
    setEditing(false);
  }

  function requestCancel() {
    if (dirty) setGuardOpen(true);
    else leaveEdit();
  }

  function removeTag(idx: number) {
    setTags((prev) => prev.filter((_, i) => i !== idx));
  }

  function commitNewTag() {
    const trimmed = newTag.trim().slice(0, PUBLIC_TAG_MAX_LENGTH);
    if (
      trimmed.length > 0 &&
      tags.length < PUBLIC_TAGS_MAX_COUNT &&
      !tags.some((tg) => tg.toLowerCase() === trimmed.toLowerCase())
    ) {
      setTags((prev) => [...prev, trimmed]);
    }
    setNewTag('');
    setAddingTag(false);
  }

  function errorMessage(
    code: 'TOO_LONG' | 'TAGLINE_TOO_LONG' | 'TAGS_INVALID' | 'NOT_ADMIN' | 'UNKNOWN',
  ) {
    switch (code) {
      case 'TOO_LONG':
        return t('editErrTooLong');
      case 'TAGLINE_TOO_LONG':
        return t('editErrTaglineTooLong');
      case 'TAGS_INVALID':
        return t('editErrTagsInvalid');
      case 'NOT_ADMIN':
        return t('editErrNotAdmin');
      default:
        return t('editErrGeneric');
    }
  }

  const save = useCallback(async () => {
    if (!dirty || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      const result = await savePublicOverviewAction(overview.identifier, {
        publicOverviewMd: overviewMd,
        publicTagline: tagline.trim().length > 0 ? tagline.trim() : null,
        publicTags: tags,
      });
      if (result.ok) {
        // Success IS the confirmation: promote the optimistic values to the new
        // baseline, drop back to the read view (which now renders them from this
        // island's state), and DON'T refresh (the no-tree-refresh rule).
        setSavedTagline(tagline);
        setSavedTags(tags);
        setSavedOverviewMd(overviewMd);
        setEditing(false);
        setAddingTag(false);
        setNewTag('');
        toast({ variant: 'success', title: t('editSavedToast') });
      } else {
        setSaveError(errorMessage(result.code));
      }
    } catch {
      setSaveError(t('editErrGeneric'));
    } finally {
      setSaving(false);
    }
    // errorMessage closes over `t`; the rest are state setters / primitives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty, saving, overview.identifier, overviewMd, tagline, tags, toast, t]);

  const initial = overview.name.trim().charAt(0).toUpperCase() || 'P';
  const stats: Array<{ n: number; l: string }> = [
    { n: overview.stats.publicRequests, l: t('statPublicRequests') },
    { n: overview.stats.upvotes, l: t('statUpvotes') },
    { n: overview.stats.planned, l: t('statPlanned') },
    { n: overview.stats.shipped, l: t('statShipped') },
  ];

  // --- The hero, shared between read + edit modes (logo / name / stats are
  // identical; tags + tagline swap to editable controls; the CTA row shows only
  // in read mode, per design Panel 1c). -------------------------------------
  const readTagline = savedTagline.length > 0 ? savedTagline : t('autoIntroTagline');

  const hero = (
    <div
      className={`relative overflow-hidden rounded-(--radius-card) border p-8 shadow-(--shadow-card) ${
        editing ? 'border-(--el-accent) border-dashed' : 'border-(--el-border)'
      }`}
      style={{
        background:
          'radial-gradient(120% 140% at 0% 0%, var(--el-hero-wash-a) 0%, transparent 55%), radial-gradient(120% 140% at 100% 0%, var(--el-hero-wash-b) 0%, transparent 50%), var(--el-page-bg)',
      }}
    >
      <div className="mb-4 flex items-start gap-3.5">
        <span
          aria-hidden
          className="inline-flex h-[52px] w-[52px] flex-none items-center justify-center rounded-(--radius-card) bg-(--el-accent) text-2xl font-extrabold text-(--el-accent-text) shadow-(--shadow-subtle)"
        >
          {initial}
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="font-serif text-3xl font-semibold leading-tight tracking-tight text-(--el-text)">
            {overview.name}
          </h1>

          {editing ? (
            <div className="mt-2.5">
              <span className="mb-1.5 block text-[11px] font-medium uppercase tracking-wide text-(--el-text-muted)">
                {t('editFieldTags')}
              </span>
              <div className="flex flex-wrap items-center gap-2">
                {tags.map((tag, i) => (
                  <span
                    key={tag}
                    className={`inline-flex items-center gap-1 rounded-(--radius-badge) border px-(--spacing-chip-x) py-(--spacing-chip-y) text-xs font-medium ${
                      TAG_TONES[i % TAG_TONES.length] ||
                      'border-(--el-border) bg-(--el-surface) text-(--el-text-strong)'
                    }`}
                  >
                    {tag}
                    <button
                      type="button"
                      onClick={() => removeTag(i)}
                      aria-label={t('editRemoveTag', { tag })}
                      className="focus-visible:ring-(--focus-ring-color) inline-flex size-4 items-center justify-center rounded-full text-(--el-text-muted) hover:text-(--el-text) focus-visible:outline-none focus-visible:ring-2"
                    >
                      <X className="size-3" aria-hidden />
                    </button>
                  </span>
                ))}

                {addingTag ? (
                  <input
                    ref={newTagRef}
                    value={newTag}
                    maxLength={PUBLIC_TAG_MAX_LENGTH}
                    onChange={(e) => setNewTag(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        commitNewTag();
                      } else if (e.key === 'Escape') {
                        e.preventDefault();
                        setNewTag('');
                        setAddingTag(false);
                      }
                    }}
                    onBlur={() => {
                      setNewTag('');
                      setAddingTag(false);
                    }}
                    aria-label={t('editNewTagLabel')}
                    placeholder={t('editNewTagPlaceholder')}
                    className="focus-visible:ring-(--focus-ring-color) w-[150px] rounded-(--radius-input) border border-(--el-accent) bg-(--el-page-bg) px-(--spacing-input-x) py-(--spacing-input-y) text-xs text-(--el-text) focus-visible:outline-none focus-visible:ring-2"
                  />
                ) : tags.length < PUBLIC_TAGS_MAX_COUNT ? (
                  <button
                    type="button"
                    onClick={() => setAddingTag(true)}
                    className="focus-visible:ring-(--focus-ring-color) inline-flex items-center gap-1 rounded-(--radius-badge) border border-dashed border-(--el-border-strong) px-(--spacing-chip-x) py-(--spacing-chip-y) text-xs font-medium text-(--el-text-muted) hover:text-(--el-text) focus-visible:outline-none focus-visible:ring-2"
                  >
                    <Plus className="size-3" aria-hidden />
                    {t('editAddTag')}
                  </button>
                ) : null}

                {tags.length > 0 ? (
                  <span className="text-[11px] text-(--el-text-faint)">
                    {t('editTagCount', { count: tags.length, max: PUBLIC_TAGS_MAX_COUNT })}
                  </span>
                ) : !addingTag ? (
                  <span className="inline-flex items-center gap-1 text-[11px] text-(--el-text-faint)">
                    <Minus className="size-3" aria-hidden />
                    {t('editTagsEmpty')}
                  </span>
                ) : null}
              </div>
            </div>
          ) : savedTags.length > 0 ? (
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              {savedTags.map((tag, i) => (
                <Pill key={tag} tone="neutral" className={TAG_TONES[i % TAG_TONES.length]}>
                  {tag}
                </Pill>
              ))}
            </div>
          ) : null}
        </div>
      </div>

      {editing ? (
        <div className="mt-3.5">
          <span className="mb-1.5 block text-[11px] font-medium uppercase tracking-wide text-(--el-text-muted)">
            {t('editFieldTagline')}
          </span>
          <textarea
            value={tagline}
            maxLength={PUBLIC_TAGLINE_MAX_LENGTH}
            rows={2}
            onChange={(e) => setTagline(e.target.value)}
            placeholder={t('editTaglinePlaceholder')}
            aria-label={t('editFieldTagline')}
            className="focus-visible:ring-(--focus-ring-color) block w-full max-w-[40rem] resize-y rounded-(--radius-input) border border-(--el-border-strong) bg-(--el-page-bg) px-(--spacing-input-x) py-(--spacing-input-y) text-base leading-relaxed text-(--el-text) focus-visible:border-(--el-accent) focus-visible:outline-none focus-visible:ring-2"
          />
        </div>
      ) : (
        <p className="mt-3.5 max-w-[40rem] text-base leading-relaxed text-(--el-text-secondary)">
          {readTagline}
        </p>
      )}

      {!editing ? (
        <div className="mt-5 flex flex-wrap items-center gap-2.5">
          <Link href={roadmapHref} className={buttonVariants({ variant: 'primary', size: 'md' })}>
            <Route className="h-4 w-4" aria-hidden />
            {t('viewRoadmap')}
          </Link>
          {submitButton}
          {overview.links.repo ? (
            <a
              href={overview.links.repo}
              target="_blank"
              rel="noopener noreferrer"
              className={buttonVariants({ variant: 'ghost', size: 'md' })}
            >
              <Code2 className="h-4 w-4" aria-hidden />
              {t('github')}
            </a>
          ) : null}
        </div>
      ) : null}

      <dl className="mt-6 flex flex-wrap gap-x-7 gap-y-3 border-t border-(--el-border-soft) pt-5">
        {stats.map((s) => (
          <div key={s.l}>
            <dd className="font-serif text-[22px] font-bold text-(--el-text)">{compact(s.n)}</dd>
            <dt className="mt-0.5 text-xs text-(--el-text-muted)">{s.l}</dt>
          </div>
        ))}
      </dl>
    </div>
  );

  return (
    <div className="p-(--spacing-card-padding)">
      {/* Admin affordance row (read mode) / Editing notice (edit mode). */}
      {editing ? (
        <div className="mb-4 flex flex-wrap items-center gap-2.5 rounded-(--radius-card) border border-(--el-accent) bg-[color-mix(in_oklab,var(--el-accent)_9%,var(--el-page-bg))] px-(--spacing-card-padding) py-2.5 text-[12.5px] text-(--el-text-strong)">
          <span aria-hidden className="inline-flex items-center gap-1.5 font-medium">
            <span className="size-2 animate-pulse rounded-full bg-(--el-accent)" />
            {t('editingChip')}
          </span>
          <span>
            <b className="font-semibold">{t('editingBannerLead')}</b> {t('editingBannerBody')}
          </span>
        </div>
      ) : (
        <>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <span className="inline-flex items-center gap-2 text-sm text-(--el-text-secondary)">
              <span
                aria-hidden
                className="inline-flex size-6 items-center justify-center rounded-full bg-(--el-accent) text-xs font-bold text-(--el-accent-text)"
              >
                {adminName.trim().charAt(0).toUpperCase() || 'A'}
              </span>
              <span className="font-medium text-(--el-text)">{adminName}</span>
              <span aria-hidden className="text-(--el-text-faint)">
                ·
              </span>
              <span className="text-(--el-text-muted)">{t('adminRole')}</span>
            </span>
            <Button variant="secondary" size="md" onClick={enterEdit} leftIcon={<PencilLine />}>
              {t('editPage')}
            </Button>
          </div>
          <div className="mb-4 flex items-start gap-2 rounded-(--radius-card) bg-[color-mix(in_oklab,var(--el-accent)_7%,var(--el-page-bg))] px-(--spacing-card-padding) py-2.5">
            <PencilLine
              className="mt-0.5 size-4 shrink-0 text-(--el-accent-on-surface)"
              aria-hidden
            />
            <p className="text-xs leading-relaxed text-(--el-text-secondary)">
              {t('editAdminHint')}
            </p>
          </div>
        </>
      )}

      {hero}

      {editing ? (
        <>
          <div className="mt-[18px]">
            <span className="mb-1.5 block text-[11px] font-medium uppercase tracking-wide text-(--el-text-muted)">
              {t('editFieldOverview')}
            </span>
            <MarkdownEditor
              value={overviewMd}
              onChange={setOverviewMd}
              label={t('editOverviewEditorLabel')}
              size="full"
            />
          </div>

          {saveError ? (
            <div className="mt-4 flex items-start gap-2 rounded-(--radius-card) border border-(--el-danger) bg-(--el-tint-rose) px-(--spacing-card-padding) py-2.5">
              <TriangleAlert className="mt-0.5 size-4 shrink-0 text-(--el-danger)" aria-hidden />
              <p className="text-xs text-(--el-text-strong)">
                <b className="font-semibold">{t('editSaveErrorLead')}</b> {saveError}
              </p>
            </div>
          ) : null}

          {/* Sticky Save / Cancel bar. */}
          <div className="sticky bottom-0 z-10 mt-4 flex flex-wrap items-center gap-2.5 rounded-(--radius-card) border border-(--el-border) bg-(--el-page-bg) px-(--spacing-card-padding) py-3 shadow-(--shadow-elevated)">
            <span className="inline-flex items-center gap-1.5 text-xs font-medium">
              {dirty ? (
                <>
                  <span aria-hidden className="size-2 rounded-full bg-(--el-warning)" />
                  <span className="text-(--el-text-secondary)">{t('editUnsavedChanges')}</span>
                </>
              ) : (
                <>
                  <Check className="size-4 text-(--el-success)" aria-hidden />
                  <span className="text-(--el-success)">{t('editSaved')}</span>
                </>
              )}
            </span>
            <span className="flex-1" />
            <Button variant="ghost" size="md" onClick={requestCancel} disabled={saving}>
              {t('cancel')}
            </Button>
            <Button
              variant="primary"
              size="md"
              onClick={save}
              loading={saving}
              disabled={!dirty}
              leftIcon={saveError ? <RotateCw /> : <CheckCheck />}
            >
              {saving ? t('editSaving') : saveError ? t('editRetry') : t('editSaveChanges')}
            </Button>
          </div>
        </>
      ) : (
        <div className="mt-[18px] grid grid-cols-1 items-start gap-5 lg:grid-cols-[1fr_312px]">
          <div className="min-w-0">
            {savedOverviewMd.trim() ? (
              <MarkdownView value={savedOverviewMd} aria-label={t('tabOverview')} />
            ) : null}
            <div className="mt-6">{faq}</div>
          </div>
          {sidebar}
        </div>
      )}

      <Modal open={guardOpen} onOpenChange={setGuardOpen} title={t('editGuardTitle')} size="sm">
        <p className="text-sm text-(--el-text-secondary)">{t('editGuardBody')}</p>
        <div className="mt-5 flex justify-end gap-2.5">
          <Button variant="ghost" size="md" onClick={() => setGuardOpen(false)}>
            {t('editGuardKeepEditing')}
          </Button>
          <Button variant="danger" size="md" onClick={leaveEdit} leftIcon={<X />}>
            {t('editGuardDiscard')}
          </Button>
        </div>
      </Modal>
    </div>
  );
}
