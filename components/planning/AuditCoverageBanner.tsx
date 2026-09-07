'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { FolderGit2 } from 'lucide-react';
import type { AuditCoverageDTO } from '@/lib/dto/codeHealth';

// The audit-coverage BANNER in the planning workspace (MOTIR-2250 ·
// design/audit-coverage). It rode the `/planning` ROUTE until MOTIR-4732; the
// workspace is an OVERLAY now (MOTIR-4725) and the banner is in the same seam of
// it, between the top bar and the panes.
//
// ⚠️ ONE LINE, FULL-BLEED, NO DISMISS — all three are the design, not styling.
//
// · It is the shipped `SettingsBanner` box (`role="status"`, `--el-callout-bg` /
//   `--el-callout-text`, `py-3`, `text-sm`) with ONE deliberate deviation: no
//   `--radius-card`, because it spans the workspace edge to edge and a rounded
//   corner only reads as a corner when there is margin outside it. The
//   `--el-border-soft` bottom rule is the same rule the workspace top bar draws,
//   so this reads as a band of chrome rather than an object on the plan.
// · Its non-blockingness is SIZE, not dismissibility (~41 px, one text line), so
//   ANY growth in its height is a regression against the decision: no heading,
//   no card, no repo list, no ×.
// · It renders on EVERY visit while a connected repo has no audit. A dismiss on
//   a self-clearing signal only ever hides a true statement, and a persisted one
//   would silence a DIFFERENT repo set later. The remedy IS the dismissal.
//
// It never TRIGGERS a derivation — it links to /code-health, where the per-repo
// and bulk triggers live (MOTIR-2249), so a run is started in exactly one place
// and watched by exactly one state machine.

const COVERAGE_URL = '/api/ai/coding-convention/audit-coverage';

export function AuditCoverageBanner() {
  const t = useTranslations('auditCoverage');
  const [count, setCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    // The workspace's first paint never waits on this: the banner fetches its
    // own state after mount (the shipped `/api/ready/nudge` shape), so N per-repo
    // boundary reads can never delay the canvas.
    void (async () => {
      try {
        const res = await fetch(COVERAGE_URL);
        if (!res.ok) return; // 403 for a non-admin, 404/502 otherwise — say nothing.
        const body = (await res.json()) as AuditCoverageDTO;
        if (!cancelled) setCount(body?.notAuditedCount ?? 0);
      } catch {
        // A banner is not a place to surface its own error: a planning workspace
        // must not gain an error strip because a background read timed out.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (count <= 0) return null;

  return (
    <div
      role="status"
      className="flex items-center gap-2 border-b border-(--el-border-soft) bg-(--el-callout-bg) px-(--spacing-card-padding) py-3 text-sm text-(--el-callout-text)"
    >
      {/* The same glyph `/code-health`'s not-audited ROW uses, so the signal and
          its destination read as one thing. */}
      <FolderGit2 className="size-4 shrink-0" aria-hidden />
      <span className="min-w-0">
        <span className="font-semibold">{t('count', { count })}</span> {t('consequence')}
      </span>
      <span className="flex-1" />
      <Link
        href="/code-health"
        className="shrink-0 font-semibold text-(--el-callout-text) underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color)"
      >
        {t('action')}
      </Link>
    </div>
  );
}
