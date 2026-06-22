'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import {
  Bug,
  CheckCheck,
  ChevronUp,
  Route,
  Send,
  SquareCheckBig,
  TriangleAlert,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button, buttonVariants } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Textarea } from '@/components/ui/Textarea';
import { Segmented } from '@/components/ui/Segmented';
import { Pill } from '@/components/ui/Pill';
import type { PublicRequestMatchDto } from '@/lib/dto/publicProjects';

// The SIGNED-IN public "Submit a request" composer + duplicate detection (Story
// 6.12 · Subtask 6.12.11 · design Panel 4), wiring the shipped 6.12.5 backend
// (POST …/requests + GET …/requests/duplicates) and the 6.12.6 upvote
// (POST /api/public-requests/[id]/upvote — the "upvote this instead" target).
// Rendered only for a signed-in viewer (the parent gates on `signedIn`); the
// unauthenticated public portal form is dropped (Yue, 2026-06-14).
//
// Flow: a kind toggle (Feature → `task` | Bug → `bug`) + title + description.
// As the title is typed (debounced) it calls the dedupe endpoint and surfaces
// matching existing requests with "Upvote this" (joins the existing request,
// creates NO new item) + a "submit as new" escape. Submit posts the request into
// the project's triage queue; a 429 surfaces the rate-limited banner; success
// shows the confirmation. Colour via `--el-*`, shape via element-semantic tokens.

const KIND_ICON = {
  task: <SquareCheckBig className="h-3.5 w-3.5" />,
  bug: <Bug className="h-3.5 w-3.5" />,
} as const;

type RequestKind = 'task' | 'bug';
type View = 'form' | 'submitted' | 'upvoted';

const DEBOUNCE_MS = 300;
const MIN_TITLE_FOR_DEDUPE = 3;

function humanizeStatus(key: string): string {
  return key
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

export function PublicSubmitRequestForm({
  projectId,
  roadmapHref,
  submitterName,
  submitterOrg,
  onClose,
}: {
  projectId: string;
  roadmapHref: string;
  submitterName: string | null;
  submitterOrg: string | null;
  onClose: () => void;
}) {
  const t = useTranslations('publicProjects');

  const [view, setView] = useState<View>('form');
  const [kind, setKind] = useState<RequestKind>('task');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');

  const [candidates, setCandidates] = useState<PublicRequestMatchDto[]>([]);
  const [dedupeDismissed, setDedupeDismissed] = useState(false);
  const [upvotingId, setUpvotingId] = useState<string | null>(null);

  const [submitting, setSubmitting] = useState(false);
  const [rateLimited, setRateLimited] = useState(false);
  const [error, setError] = useState(false);

  const dedupeSeq = useRef(0);

  // Duplicate detection — fires as the title is typed (debounced, seq-guarded so
  // a stale response can't clobber the latest), BEFORE create. Skipped once the
  // submitter has dismissed it ("submit as new") so it doesn't keep re-surfacing.
  useEffect(() => {
    const trimmed = title.trim();
    // Too short / dismissed → don't fetch; the `showDedupe` render guard hides
    // any stale candidates, so there's no synchronous setState in the effect.
    if (dedupeDismissed || trimmed.length < MIN_TITLE_FOR_DEDUPE) return;
    const seq = ++dedupeSeq.current;
    const timer = setTimeout(() => {
      void fetch(
        `/api/public/projects/${encodeURIComponent(projectId)}/requests/duplicates?title=${encodeURIComponent(
          trimmed,
        )}`,
      )
        .then((res) => (res.ok ? res.json() : { candidates: [] }))
        .then((body: { candidates?: PublicRequestMatchDto[] }) => {
          if (seq !== dedupeSeq.current) return;
          setCandidates(body.candidates ?? []);
        })
        .catch(() => {
          if (seq === dedupeSeq.current) setCandidates([]);
        });
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [title, dedupeDismissed, projectId]);

  const upvoteExisting = useCallback(
    async (id: string) => {
      if (upvotingId) return;
      setUpvotingId(id);
      setError(false);
      try {
        const res = await fetch(`/api/public-requests/${encodeURIComponent(id)}/upvote`, {
          method: 'POST',
        });
        if (!res.ok) throw new Error(`upvote ${res.status}`);
        setView('upvoted');
      } catch {
        setError(true);
      } finally {
        setUpvotingId(null);
      }
    },
    [upvotingId],
  );

  const submit = useCallback(async () => {
    if (submitting || title.trim().length === 0) return;
    setSubmitting(true);
    setError(false);
    setRateLimited(false);
    try {
      const res = await fetch(`/api/public/projects/${encodeURIComponent(projectId)}/requests`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          kind,
          title: title.trim(),
          descriptionMd: description.trim() || null,
        }),
      });
      if (res.status === 429) {
        setRateLimited(true);
        return;
      }
      if (!res.ok) throw new Error(`submit ${res.status}`);
      setView('submitted');
    } catch {
      setError(true);
    } finally {
      setSubmitting(false);
    }
  }, [submitting, title, description, kind, projectId]);

  const resetForm = useCallback(() => {
    setView('form');
    setKind('task');
    setTitle('');
    setDescription('');
    setCandidates([]);
    setDedupeDismissed(false);
    setRateLimited(false);
    setError(false);
  }, []);

  // ── Confirmation (after "submit as new" OR "upvote this instead") ──────────
  if (view !== 'form') {
    const submitted = view === 'submitted';
    return (
      <div className="flex flex-col items-center px-4 py-8 text-center">
        <span className="mb-4 inline-flex h-12 w-12 items-center justify-center rounded-full bg-(--el-tint-mint) text-(--el-text-strong)">
          <CheckCheck className="h-6 w-6" aria-hidden />
        </span>
        <h4 className="text-base font-semibold text-(--el-text)">
          {submitted ? t('confirmTitle') : t('upvotedTitle')}
        </h4>
        <p className="mt-1.5 max-w-sm text-[13px] leading-relaxed text-(--el-text-muted)">
          {submitted ? t('confirmBody') : t('upvotedBody')}
        </p>
        <div className="mt-5 flex items-center gap-2">
          <Link href={roadmapHref} className={buttonVariants({ variant: 'secondary', size: 'sm' })}>
            <Route className="h-4 w-4" aria-hidden />
            {t('viewRoadmap')}
          </Link>
          {submitted ? (
            <Button variant="ghost" size="sm" onClick={resetForm}>
              {t('submitAnother')}
            </Button>
          ) : (
            <Button variant="ghost" size="sm" onClick={onClose}>
              {t('done')}
            </Button>
          )}
        </div>
      </div>
    );
  }

  const showDedupe =
    !dedupeDismissed && title.trim().length >= MIN_TITLE_FOR_DEDUPE && candidates.length > 0;
  const submitterLabel = submitterName
    ? submitterOrg
      ? t('submittedAs', { name: submitterName, org: submitterOrg })
      : t('submittedAsNoOrg', { name: submitterName })
    : null;

  return (
    <div className="flex flex-col gap-4">
      <p className="text-[13px] text-(--el-text-muted)">{t('submitFormSubtitle')}</p>

      {/* Type toggle — Feature (task) default | Bug */}
      <div className="flex flex-col gap-1.5">
        <span className="text-[13px] font-medium text-(--el-text-secondary)">{t('typeLabel')}</span>
        <Segmented<RequestKind>
          label={t('typeLabel')}
          value={kind}
          onChange={setKind}
          options={[
            { value: 'task', label: t('kindFeature'), icon: KIND_ICON.task },
            { value: 'bug', label: t('kindBug'), icon: KIND_ICON.bug },
          ]}
        />
      </div>

      <Input
        label={t('titleLabel')}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        maxLength={200}
        autoFocus
      />

      {/* Duplicate detection — surfaced BEFORE create */}
      {showDedupe ? (
        <div className="flex flex-col gap-2 rounded-(--radius-card) border border-(--el-border) bg-(--el-surface-soft) p-3">
          <div className="flex items-center gap-1.5 text-[12.5px] font-medium text-(--el-text-secondary)">
            <ChevronUp className="h-3.5 w-3.5 text-(--el-accent-on-surface)" aria-hidden />
            {t('dedupeHeader', { count: candidates.length })}
          </div>
          <ul className="flex flex-col gap-1.5">
            {candidates.map((c) => (
              <li
                key={c.id}
                className="flex items-center gap-2.5 rounded-(--radius-control) border border-(--el-border) bg-(--el-page-bg) p-2"
              >
                <span
                  className="flex w-[42px] flex-none flex-col items-center justify-center gap-px rounded-(--radius-control) border border-(--el-border) py-1 text-(--el-text-secondary)"
                  role="img"
                  aria-label={t('upvoteAria', { count: c.voteCount })}
                >
                  <ChevronUp className="h-[15px] w-[15px]" aria-hidden />
                  <span className="text-[13px] font-bold text-(--el-text-strong)">
                    {c.voteCount}
                  </span>
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-semibold text-(--el-text)">
                    {c.title}
                  </div>
                  <Pill
                    tone="neutral"
                    className="mt-1 border-(--el-border) bg-(--el-surface) text-(--el-text-secondary)"
                  >
                    {humanizeStatus(c.status)}
                  </Pill>
                </div>
                <Button
                  variant="secondary"
                  size="sm"
                  loading={upvotingId === c.id}
                  disabled={upvotingId !== null}
                  leftIcon={<ChevronUp className="h-4 w-4" />}
                  onClick={() => void upvoteExisting(c.id)}
                >
                  {t('upvoteThis')}
                </Button>
              </li>
            ))}
          </ul>
          <button
            type="button"
            onClick={() => setDedupeDismissed(true)}
            className="self-start text-[12.5px] font-medium text-(--el-link) hover:text-(--el-link-pressed)"
          >
            {t('continueAsNew')}
          </button>
        </div>
      ) : null}

      <div className="flex flex-col gap-1.5">
        <Textarea
          label={t('descriptionLabel')}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={4}
          maxLength={10_000}
          placeholder={t('descriptionPlaceholder')}
        />
        {submitterLabel ? (
          <p className="text-[12px] text-(--el-text-muted)">{submitterLabel}</p>
        ) : null}
      </div>

      {rateLimited ? (
        <div
          role="status"
          className="flex items-start gap-2 rounded-(--radius-card) border border-(--el-warning) bg-(--el-warning-surface) p-3 text-(--el-warning-text)"
        >
          <TriangleAlert className="mt-0.5 h-4 w-4 flex-none" aria-hidden />
          <div className="text-[12.5px] leading-relaxed">
            <p className="font-semibold">{t('rateLimitedTitle')}</p>
            <p>{t('rateLimitedBody')}</p>
          </div>
        </div>
      ) : null}

      {error ? (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-(--radius-card) border border-(--el-danger) bg-(--el-danger-surface) p-3 text-(--el-danger-surface-text)"
        >
          <TriangleAlert className="mt-0.5 h-4 w-4 flex-none" aria-hidden />
          <div className="text-[12.5px] leading-relaxed">
            <p className="font-semibold">{t('submitErrorTitle')}</p>
            <p>{t('submitErrorBody')}</p>
          </div>
        </div>
      ) : null}

      <div className="flex items-center justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onClose}>
          {t('cancel')}
        </Button>
        <Button
          variant="primary"
          size="md"
          loading={submitting}
          disabled={title.trim().length === 0 || submitting}
          leftIcon={<Send className="h-4 w-4" />}
          onClick={() => void submit()}
        >
          {t('submitButton')}
        </Button>
      </div>
    </div>
  );
}
