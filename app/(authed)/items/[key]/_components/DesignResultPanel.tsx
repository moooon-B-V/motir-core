'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  ExternalLink,
  FileImage,
  FileText,
  FileWarning,
  GitCommitHorizontal,
  ImageOff,
  PanelsTopLeft,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Pill } from '@/components/ui/Pill';
import { useReportPortRenderStatus } from '@/components/approvals/portRenderStatus';
import type { DesignAssetDTO, DesignEvidenceDTO } from '@/lib/dto/designEvidence';

// The Design result panel (Story MOTIR-2664 · Subtask MOTIR-2670), built to
// design/work-items/design-result.png. Rendered inside a ContentSectionCard on a
// leaf's detail page. Colour via --el-*, shape via element-semantic tokens;
// primitives are Button / Pill and the shipped AttachmentPreview lightbox.
//
// ⚠️ THREE states, not five. docs/decisions/design-result.md §2 decided the
// feature has NO entitlement axis, so unlike the acceptance panel beside it
// there is no upsell and no toggle to render.
//
// ⚠️ THIS PANEL IS THE APPROVAL FRAME'S PORT — it is no longer the section.
// `LateSections` mounts `DesignResultSection`, which renders the frame
// (`components/approvals/ApprovalGateControl.tsx`) with THIS component as band 2
// (Story MOTIR-4778 · Subtask MOTIR-4792; `docs/decisions/approval-gates.md` §7,
// and `design/work-items/design-notes.md` § The UNIVERSAL APPROVAL FRAME, whose
// placement table says the frame IS the Design result section). What lives here
// is still exactly what it was — the note, the sandboxed mock, the screenshots,
// the provenance — and the verbs that decide it live one level up, BELOW the
// port, because you decide after you look.
//
// ⚠️ SINCE AMENDMENT 4 IT SHOWS ONLY WHAT TO REVIEW (Story MOTIR-5488 · MOTIR-5498,
// built to `design/work-items/design-result--what-to-review.mock.html`): the
// mock frame(s) first, the note as ONE LINK under them, no inline Markdown and
// no screenshot strip. An earlier-format result's note and screenshots are
// listed as file links. And on a card whose open linked pull requests carry the
// decision, it is the Development block's slot (`placement="development"`), not
// a section (Q8).
//
// This component itself still writes nothing and still advances no status; the
// sentence that used to stand here said that of the SECTION, which is no longer
// true, and a careful present-tense comment asserting a boundary is exactly the
// kind that outranks the code in the next reader's mind.

/**
 * The height the design measured for a PUBLISHED ARTIFACT in this panel
 * (design-notes.md § Design result panel — "32rem (512px) tall, scrolling
 * inside itself in BOTH axes… an unbounded frame would swallow a page that
 * already has eight sections").
 *
 * The mock frame carries it. (The rendered note carried it too until AMENDMENT 4
 * made the note a link — MOTIR-5498.)
 */
const FRAME_HEIGHT = 'h-[32rem]';

/**
 * How long the reachability probe may say nothing before the frame is treated as
 * failed (MOTIR-5032).
 *
 * It exists because `fetch` has two outcomes and the port has three: a probe
 * that never settles is neither ready nor failed, and before the approval frame
 * gated its verbs on the port that third case merely showed a permanent
 * "loading" strip. Sized generously — this is a HEAD-shaped request to an
 * object-store redirect, not a page load, so anything past a few seconds is a
 * host that is not going to answer rather than a slow one.
 */
const PROBE_TIMEOUT_MS = 10_000;

export interface DesignResultPanelProps {
  evidence: DesignEvidenceDTO | null;
  /** Shown in the empty state so a reader knows where a result comes from. */
  isDesignCard: boolean;
  /**
   * WHERE the result renders (`design-result.md` AMENDMENT 4 Q8; design
   * `design-result--what-to-review.mock.html` states 7–8).
   *
   * - `section` — its own Design result section: frames, note row, provenance
   *   chips. Every card without an open linked pull request.
   * - `development` — the SLOT inside the Development block of a card whose pull
   *   requests carry the decision: an `h4` heading with a one-line provenance, then
   *   the same frames and note row, and no chips. The block draws How to test and
   *   the rows below it.
   */
  placement?: 'section' | 'development';
}

/** The last path segment of a repo path — the display name for an artifact. */
function basenameOf(sourcePath: string): string {
  return sourcePath.slice(sourcePath.lastIndexOf('/') + 1);
}

function Provenance({ evidence }: { evidence: DesignEvidenceDTO }) {
  const t = useTranslations('designResult');
  const chip =
    'inline-flex items-center gap-1 rounded-(--radius-badge) bg-(--el-muted) px-(--spacing-chip-x) py-(--spacing-chip-y) text-(--el-text-secondary)';

  return (
    <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-(--el-border-soft) pt-3.5 text-xs text-(--el-text-secondary)">
      {evidence.commitSha ? (
        <span className={chip}>
          <GitCommitHorizontal className="h-3.5 w-3.5" aria-hidden />
          <span className="font-mono">{evidence.commitSha.slice(0, 7)}</span>
        </span>
      ) : null}
      {evidence.ciRunUrl ? (
        <a className={chip} href={evidence.ciRunUrl} target="_blank" rel="noopener noreferrer">
          {t('ciRun')}
          <ExternalLink className="h-3 w-3" aria-hidden />
        </a>
      ) : null}
      {evidence.producedByKey ? (
        <span className={chip}>
          {t('publishedBy')} <span className="font-mono">{evidence.producedByKey}</span>
        </span>
      ) : null}
    </div>
  );
}

/**
 * The sandboxed mock frame. Its `src` is the AUTHENTICATED content route, which
 * 302s to a presigned URL on the object-store host — so the document is
 * cross-origin to the app before the sandbox is applied at all.
 *
 * ⚠️ `sandbox=""` grants NOTHING: neither `allow-scripts` nor
 * `allow-same-origin`, never the two together. The shipped assets tolerate it
 * because they are self-contained inline CSS with no `<script>`; a mock that
 * needs JavaScript renders inert, which is the recorded trade (§5c).
 */
function MockFrame({ asset }: { asset: DesignAssetDTO }) {
  const t = useTranslations('designResult');
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [attempt, setAttempt] = useState(0);
  const url = asset.url;

  // ⚠️ WHY A PROBE RATHER THAN `onError` ON THE IFRAME.
  // An iframe does NOT fire `error` for an HTTP error response — the browser
  // simply renders the error body inside the frame — so an `onError` handler
  // would leave the failure state unreachable and the reader staring at a box
  // containing someone else's 404 page. The content route is SAME-ORIGIN
  // (`/api/attachments/<id>/content`), so a `fetch` can read its status; only
  // the 302's destination is cross-origin, which is what keeps the rendered
  // document isolated. `redirect: 'manual'` stops the fetch following that hop:
  // an opaque redirect response is exactly the success signal we want, and it
  // avoids spending the single-use signed URL before the frame asks for it.
  useEffect(() => {
    if (!url) return;
    let cancelled = false;
    // No `setState('loading')` here: the initial state IS 'loading', and the
    // retry handler resets it before bumping `attempt` — so the effect only ever
    // reports an OUTCOME, which is what keeps it out of the set-state-in-effect
    // rule the act environment enforces.
    //
    // ⚠️ THE TIMEOUT IS THE THIRD OUTCOME, AND IT IS THE ONE A PROMISE CANNOT
    // GIVE YOU (MOTIR-5032). `fetch` settles or rejects; it does not report
    // "still nothing". A probe against a wedged object-store host therefore left
    // this frame at `'loading'` FOR EVER — harmless while the panel was
    // read-only, and not harmless once the approval frame gates its verbs on
    // this state: a port stuck rendering is a decision nobody can ever make and
    // a reader with no explanation. Whichever of the three lands first wins;
    // `cancelled` makes the losers no-ops.
    const timer = setTimeout(() => {
      if (!cancelled) setState('failed');
    }, PROBE_TIMEOUT_MS);
    // ⚠️ DISARMED THE MOMENT THE PROBE SETTLES, IN BOTH ARMS — clearing it only
    // in the effect's cleanup is not enough, and the difference is a real
    // defect rather than tidiness. A successful probe does not re-run the
    // effect, so a timer cleared only on cleanup stays armed over a frame that
    // has already loaded and fires `'failed'` ten seconds later — retracting a
    // rendered port and, now that the verbs are gated on it, taking a live
    // decision away from a reader looking straight at its subject. Caught by
    // `design-result-port-report.test.ts`'s "does NOT fire the timeout once the
    // probe has settled".
    fetch(url, { method: 'GET', redirect: 'manual' })
      .then((res) => {
        clearTimeout(timer);
        if (cancelled) return;
        // `type: 'opaqueredirect'` (the 302 we expect) reports `ok: false` and
        // `status: 0`, so treat any non-error settlement as reachable and let
        // an explicit 4xx/5xx be the failure.
        setState(res.type === 'opaqueredirect' || res.ok ? 'ready' : 'failed');
      })
      .catch(() => {
        clearTimeout(timer);
        if (!cancelled) setState('failed');
      });
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [url, attempt]);

  // ⚠️ REPORTED TO THE APPROVAL FRAME ABOVE (MOTIR-5032) — the probe's own three
  // outcomes, and nothing else.
  //
  // The `!url` case is NOT reported here, and that is a reachability fact rather
  // than an oversight: the only call site filters on it
  // (`assets.filter((a) => a.kind === 'mock' && a.url)`), so a url-less mock
  // never reaches this component and an arm for it would be dead branch. The
  // asset whose blob HAS been reclaimed is a real case and is answered one level
  // up, in the panel's own `hasSubject` report, which is where the filter leaves
  // it. The `return null` below stays as the defensive floor it already was.
  useReportPortRenderStatus(
    state === 'ready' ? 'rendered' : state === 'failed' ? 'failed' : 'rendering',
  );

  if (!url) return null;

  return (
    <>
      <div className="flex items-center gap-2 rounded-t-(--radius-input) border border-b-0 border-(--el-border) bg-(--el-surface-soft) px-2.5 py-1.5 text-xs text-(--el-text-secondary)">
        <PanelsTopLeft className="h-3.5 w-3.5" aria-hidden />
        <span className="truncate font-mono">{asset.sourcePath}</span>
        <a
          className="ml-auto inline-flex items-center gap-1 text-(--el-text) hover:underline"
          href={url}
          target="_blank"
          rel="noopener noreferrer"
        >
          {t('openInNewTab')}
          <ExternalLink className="h-3 w-3" aria-hidden />
        </a>
      </div>

      {state === 'failed' ? (
        <div className="flex gap-3.5 rounded-b-(--radius-input) bg-(--el-tint-peach) p-4">
          <span className="flex h-9 w-9 flex-none items-center justify-center rounded-(--radius-control) bg-(--el-page-bg)">
            <FileWarning className="h-[18px] w-[18px] text-(--el-text-strong)" aria-hidden />
          </span>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-(--el-text-strong)">{t('frameFailed')}</h3>
            <p className="mt-0.5 mb-3 text-[13px] leading-snug text-(--el-text-strong)">
              {t('frameFailedBody')}
            </p>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setState('loading');
                setAttempt((n) => n + 1);
              }}
            >
              {t('retry')}
            </Button>
          </div>
        </div>
      ) : state === 'loading' ? (
        <div
          className={`${FRAME_HEIGHT} flex w-full items-center justify-center rounded-b-(--radius-input) border border-(--el-border) bg-(--el-muted) text-[13px] text-(--el-text-secondary)`}
          role="status"
        >
          {t('frameLoading')}
        </div>
      ) : (
        <iframe
          // Remounts on retry so the browser requests a fresh signed URL.
          key={attempt}
          src={url}
          title={t('frameTitle', { path: basenameOf(asset.sourcePath) })}
          sandbox=""
          className={`${FRAME_HEIGHT} w-full rounded-b-(--radius-input) border border-(--el-border) bg-(--el-page-bg)`}
        />
      )}
    </>
  );
}

/**
 * ONE file as a link row — the note, or (on an earlier-format result) a
 * screenshot. On the page ground, not `--el-surface-soft`: `--el-link` is AA on
 * the page and under it on the soft surface. A reclaimed file (`url` null) keeps
 * its row and names what it was; its link becomes plain text, never a link that
 * 404s.
 */
function FileRow({
  asset,
  icon: Icon,
  label,
  linkLabel,
}: {
  asset: DesignAssetDTO;
  icon: typeof FileText;
  label: string;
  linkLabel: string;
}) {
  const t = useTranslations('designResult');
  return (
    <div
      className="flex min-w-0 items-center gap-2 rounded-(--radius-input) border border-(--el-border) bg-(--el-page-bg) px-(--spacing-control-x) py-(--spacing-control-y) text-[13px] text-(--el-text-secondary)"
      data-testid="design-result-file-row"
    >
      <Icon className="h-3.5 w-3.5 flex-none" aria-hidden />
      <span className="flex-none font-medium text-(--el-text)">{label}</span>
      <span className="min-w-0 truncate font-mono">{asset.sourcePath}</span>
      {asset.url ? (
        <a
          className="ml-auto inline-flex flex-none items-center gap-1 whitespace-nowrap text-(--el-link) hover:underline"
          href={asset.url}
          target="_blank"
          rel="noopener noreferrer"
        >
          {linkLabel}
          <ExternalLink className="h-3 w-3" aria-hidden />
        </a>
      ) : (
        <span className="ml-auto flex-none whitespace-nowrap">{t('noteGone')}</span>
      )}
    </div>
  );
}

export function DesignResultPanel({
  evidence,
  isDesignCard,
  placement = 'section',
}: DesignResultPanelProps) {
  const t = useTranslations('designResult');

  const mocks = evidence ? evidence.assets.filter((a) => a.kind === 'mock' && a.url) : [];
  const images = evidence ? evidence.assets.filter((a) => a.kind === 'image') : [];
  // The note is read WITHOUT the `url` filter: a GC-reclaimed blob still knows
  // which repo file it came from, and the row keeps naming it.
  const noteFile = evidence?.assets.find((a) => a.kind === 'note_file') ?? null;

  // ⚠️ THE PANEL'S OWN REPORT TO THE APPROVAL FRAME — the "resolver returned the
  // subject as unavailable" arm of state `X` (MOTIR-5032). The `MockFrame`
  // report above answers for a subject that FAILED TO LOAD; this answers for one
  // that is not there to load.
  //
  // What there is to REVIEW is the mock (AMENDMENT 4 Q1). So a mock with a URL is
  // a subject; and an EARLIER-FORMAT result that carries no mock at all still has
  // one when any of its screenshots or its note file is reachable — otherwise a
  // decided gate on an old result would be reported as a failed port. The inline
  // `noteMd` no longer counts: it is not rendered, so it is nothing to look at.
  // Reported unconditionally and before the early return below, per the rules of
  // hooks; outside a frame there is no listener and this is inert.
  const hasMockSubject = evidence?.assets.some((a) => a.kind === 'mock' && a.url) ?? false;
  const hasOlderSubject =
    evidence !== null &&
    !evidence.assets.some((a) => a.kind === 'mock') &&
    evidence.assets.some((a) => (a.kind === 'image' || a.kind === 'note_file') && a.url);
  useReportPortRenderStatus(hasMockSubject || hasOlderSubject ? 'rendered' : 'failed');

  // ── Nothing published yet ──────────────────────────────────────────────────
  // Since AMENDMENT 4 a result is published only when other work waits on the
  // design, so an empty panel is often CORRECT; the design-card copy says so.
  if (!evidence) {
    return (
      <div className="flex gap-3.5 rounded-(--radius-input) border border-(--el-border-soft) bg-(--el-surface-soft) p-4">
        <span className="flex h-9 w-9 flex-none items-center justify-center rounded-(--radius-control) bg-(--el-page-bg)">
          <ImageOff className="h-[18px] w-[18px] text-(--el-text-muted)" aria-hidden />
        </span>
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-(--el-text)">{t('empty.title')}</h3>
          <p className="mt-0.5 text-[13px] leading-snug text-(--el-text-secondary)">
            {isDesignCard ? t('empty.bodyDesign') : t('empty.body')}
          </p>
        </div>
      </div>
    );
  }

  // An EARLIER FORMAT result — published before AMENDMENT 4, with an inline note
  // or screenshots. Nothing is migrated and nothing re-renders inline: its files
  // are listed as links under the mock (design panel 4).
  const earlierFormat = Boolean(evidence.noteMd) || images.length > 0;

  const noteRow = noteFile ? (
    <FileRow asset={noteFile} icon={FileText} label={t('note')} linkLabel={t('openNote')} />
  ) : null;

  const body = (
    <>
      {earlierFormat ? (
        <div className="mb-3 flex flex-wrap items-center gap-2.5 text-[13px] text-(--el-text-secondary)">
          {/* The design's `--el-tint-yellow` + `--el-text-strong` chip, over the NEUTRAL
              tone rather than `awaiting`: the same fill, but `awaiting` means a
              decision is waiting, and this renders inside that frame's port. */}
          <Pill
            tone="neutral"
            className="border-transparent bg-(--el-tint-yellow) text-(--el-text-strong)"
          >
            {t('earlierFormat')}
          </Pill>
          <span>{t('earlierFormatBody')}</span>
        </div>
      ) : null}

      {/* The count line — only with SEVERAL mocks, so a reviewer does not stop
          after the first frame. Nothing else sits above the first frame. */}
      {mocks.length > 1 ? (
        <p className="text-xs text-(--el-text-secondary)">
          {t('mockCount', { count: mocks.length })}
        </p>
      ) : null}

      {mocks.map((asset, index) => (
        <div key={asset.id} className={index === 0 && mocks.length === 1 ? '' : 'mt-5'}>
          <MockFrame asset={asset} />
        </div>
      ))}

      {/* THE NOTE IS ONE LINK AWAY, AND IT SITS AT THE BOTTOM (revised on review,
          2026-09-14): the mock is what the approval is about; the note is written
          for the agents that build to it. */}
      {earlierFormat ? (
        <div className={mocks.length > 0 ? 'mt-4' : ''}>
          <p className="mb-2 text-xs font-semibold tracking-wide text-(--el-text-secondary) uppercase">
            {t('files')}
          </p>
          <div className="flex flex-col gap-2">
            {noteRow}
            {images.map((asset) => (
              <FileRow
                key={asset.id}
                asset={asset}
                icon={FileImage}
                label={t('screenshot')}
                linkLabel={t('openFile')}
              />
            ))}
          </div>
        </div>
      ) : noteRow ? (
        <div className={mocks.length > 0 ? 'mt-4' : ''}>{noteRow}</div>
      ) : null}
    </>
  );

  if (placement === 'development') {
    // THE SLOT inside the Development block (Q8, design states 7–8): FIRST in the
    // block, under its own `h4` — the How to test part's heading grammar — with
    // the provenance collapsed to one line. The block owns what follows it.
    return (
      <div
        role="group"
        aria-label={t('title')}
        data-testid="development-design-result"
        className="mt-1 flex min-w-0 flex-col gap-2.5"
      >
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <h4 className="text-[13px] font-semibold text-(--el-text)">{t('title')}</h4>
          {evidence.producedByKey || evidence.commitSha ? (
            <span className="text-xs text-(--el-text-secondary)">
              {evidence.producedByKey
                ? t.rich('slotProvenance', {
                    key: evidence.producedByKey,
                    b: (chunks) => <b className="font-medium text-(--el-text)">{chunks}</b>,
                  })
                : null}
              {evidence.producedByKey && evidence.commitSha ? ' · ' : null}
              {evidence.commitSha ? (
                <span className="font-mono text-(--el-text-identifier)">
                  {evidence.commitSha.slice(0, 7)}
                </span>
              ) : null}
            </span>
          ) : null}
        </div>
        <div className="min-w-0">{body}</div>
      </div>
    );
  }

  return (
    <div>
      {body}
      <Provenance evidence={evidence} />
    </div>
  );
}
