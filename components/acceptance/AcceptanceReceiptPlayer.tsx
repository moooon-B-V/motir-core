'use client';

import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ExternalLink, GitCommitHorizontal } from 'lucide-react';
import type { AcceptanceEvidenceDTO } from '@/lib/dto/acceptanceEvidence';

// THE ACCEPTANCE RECEIPT — the recording and where it came from (Story MOTIR-4949 ·
// Subtask MOTIR-4950). Moved out of the story page's `AcceptancePanel` unchanged so
// the `acceptance_result` gate's PORT in the approval overlay renders the same
// player, chapters and provenance a reader sees on the story: one receipt markup,
// two surfaces. Built to `design/work-items/acceptance-panel.png`; colour via
// `--el-*`, shape via the element-semantic tokens.

const PLAYBACK_SPEEDS = [0.5, 0.75, 1, 1.5, 2] as const;

/**
 * How the video is sized (Bug MOTIR-6042).
 *
 * `width` — the full width of whatever holds it, 16:9. Right on the item page, where
 * the receipt sits in a column and the PAGE scrolls: the height it takes is ordinary
 * page content.
 *
 * `viewport` — the approval OVERLAY. There the port is the height left between band 1
 * and the verbs, with its own scroll, and the overlay is the whole screen wide, so a
 * width-sized video was ~9/16 of the SCREEN'S WIDTH tall and pushed its own controls
 * below the fold at every common desktop size. Here the video is as wide as the port
 * allows AND short enough that it, and the speed row under it, fit the viewport:
 * `17rem` is the overlay's chrome (the exit row, band 1, band 3, the port's padding and
 * the speed row), measured, with a little headroom for a story run's slot heading.
 */
export type AcceptanceReceiptFit = 'width' | 'viewport';

/** The chaptered player: the video, the speed row, and a jump per chapter. */
export function AcceptanceReceiptPlayer({
  evidence,
  fit = 'width',
}: {
  evidence: AcceptanceEvidenceDTO;
  fit?: AcceptanceReceiptFit;
}) {
  const t = useTranslations('acceptance');
  const videoRef = useRef<HTMLVideoElement>(null);
  const [playbackRate, setPlaybackRate] = useState(1);
  return (
    <div className="overflow-hidden rounded-(--radius-input) border border-(--el-border)">
      {evidence.videoUrl ? (
        fit === 'viewport' ? (
          // The black band stays full width, so a height-capped video reads as a
          // letterboxed player rather than a thumbnail floating in the port.
          <div className="bg-black">
            <video
              ref={videoRef}
              src={evidence.videoUrl}
              controls
              className="mx-auto block aspect-video w-[min(100%,calc((100dvh-17rem)*16/9))] object-contain"
            />
          </div>
        ) : (
          <video
            ref={videoRef}
            src={evidence.videoUrl}
            controls
            className="aspect-video w-full bg-black"
          />
        )
      ) : null}
      <div className="flex items-center gap-1.5 px-3.5 pt-3">
        <span className="mr-0.5 text-[11px] leading-none text-(--el-text-secondary)">
          {t('player.speed')}
        </span>
        {PLAYBACK_SPEEDS.map((rate) => (
          <button
            key={rate}
            type="button"
            onClick={() => {
              if (videoRef.current) videoRef.current.playbackRate = rate;
              setPlaybackRate(rate);
            }}
            aria-pressed={playbackRate === rate}
            aria-label={`${rate}×`}
            className={`rounded-(--radius-control) px-1.5 py-0.5 text-[11px] font-semibold leading-tight transition-colors ${playbackRate === rate ? 'bg-(--el-accent) text-(--el-accent-text)' : 'text-(--el-text-secondary) hover:bg-(--el-surface) hover:text-(--el-text)'}`}
          >
            {rate}×
          </button>
        ))}
      </div>
      {evidence.chapters.length > 0 ? (
        <ul className="flex flex-col gap-0.5 p-3.5 pt-3">
          {evidence.chapters.map((c, i) => (
            <li key={`${c.tSeconds}-${i}`}>
              <button
                type="button"
                onClick={() => {
                  if (videoRef.current) videoRef.current.currentTime = c.tSeconds;
                }}
                className="flex w-full items-center gap-2.5 rounded-(--radius-control) px-2 py-1.5 text-left text-[13px] text-(--el-text) hover:bg-(--el-surface)"
              >
                <span className="flex h-[18px] w-[18px] flex-none items-center justify-center rounded-full bg-(--el-tint-lavender) text-[10px] font-bold text-(--el-text-strong)">
                  {i + 1}
                </span>
                {c.label}
                <span className="ml-auto font-mono text-xs text-(--el-text-secondary)">
                  {formatTime(c.tSeconds)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** Where the recording came from — its commit, the CI run, the trace, and the card
 *  whose run recorded it. */
export function AcceptanceReceiptProvenance({
  evidence,
  className,
}: {
  evidence: AcceptanceEvidenceDTO;
  className?: string;
}) {
  const t = useTranslations('acceptance');
  return (
    <div className={`flex flex-wrap gap-2 ${className ?? ''}`}>
      {evidence.commitSha ? (
        <span className="inline-flex items-center gap-1.5 rounded-(--radius-control) border border-(--el-border-soft) bg-(--el-surface) px-2 py-0.5 font-mono text-[11px] text-(--el-text-secondary)">
          <GitCommitHorizontal className="h-3 w-3 text-(--el-text-faint)" aria-hidden />
          {evidence.commitSha.slice(0, 7)}
        </span>
      ) : null}
      {evidence.ciRunUrl ? (
        <a
          href={evidence.ciRunUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1.5 rounded-(--radius-control) border border-(--el-border-soft) bg-(--el-surface) px-2 py-0.5 font-mono text-[11px] text-(--el-link)"
        >
          <ExternalLink className="h-3 w-3" aria-hidden />
          {t('provenance.ciRun')}
        </a>
      ) : null}
      {evidence.traceUrl ? (
        <a
          href={evidence.traceUrl}
          className="inline-flex items-center gap-1.5 rounded-(--radius-control) border border-(--el-border-soft) bg-(--el-surface) px-2 py-0.5 font-mono text-[11px] text-(--el-link)"
        >
          <ExternalLink className="h-3 w-3" aria-hidden />
          {t('provenance.trace')}
        </a>
      ) : null}
      {evidence.producedByKey ? (
        <span className="inline-flex items-center rounded-(--radius-control) border border-(--el-border-soft) bg-(--el-surface) px-2 py-0.5 font-mono text-[11px] text-(--el-text-secondary)">
          {evidence.producedByKey}
        </span>
      ) : null}
    </div>
  );
}

function formatTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
