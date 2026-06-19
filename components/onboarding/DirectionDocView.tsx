'use client';

import type { CSSProperties } from 'react';
import { MessageSquare, HelpCircle, ArrowRight } from 'lucide-react';
import { renderMarkdown } from '@/lib/markdown/render';
import { FeatureCatalogView } from './FeatureCatalogView';
import {
  type DirectionDocView as DirectionDocModel,
  type DirectionDocKind,
  type FeatureCatalogView as FeatureCatalogModel,
  TIER_META,
  DIRECTION_DOC_ORDER,
  splitOpenQuestions,
  stripLeadingTitle,
} from '@/lib/onboarding/directionDoc';
import './direction-doc.css';

// DirectionDocView (subtask 7.3.6 / MOTIR-834) — the READ-ONLY editorial render
// of one onboarding direction doc. It is purely how a doc is DISPLAYED; the gate
// FLOW (chat, Continue/Skip, cascade-back, the Back/Save bar) is 7.3.5 / MOTIR-833
// and wraps this. The gate (7.3.5) EMBEDS it to show the current tier; the
// planning canvas (MOTIR-1008) + the summary screen REUSE it to re-read a done
// tier. Grounded in the revised onboarding design (7.3.68 / MOTIR-1100):
// READ-ONLY everywhere (no inline edit — the user reacts only in the chat),
// editorial + tier-colour-coded, open questions surfaced, cross-links between
// docs, and the feature catalog folded INTO the vision view.
//
// The body is a single Markdown string (`contentMd`) rendered through the shared
// `renderMarkdown` pipeline with the editorial styles in `direction-doc.css`.
// The tier supplies its own chrome (plain-language label, kicker, colour) — the
// doc's internal `# Title (Tier N)` heading is stripped so the jargon title
// isn't shown twice.

export interface DirectionDocViewProps {
  /** The produced tier doc (kind + Markdown body). */
  doc: DirectionDocModel;
  /**
   * The structured feature catalog — rendered FOLDED INTO the vision tier only;
   * ignored for the other tiers. Null/undefined renders no catalog.
   */
  catalog?: FeatureCatalogModel | null;
  /**
   * The other produced tiers, for the cross-link footer ("jump discovery ↔
   * vision ↔ …"). The current doc's own kind is filtered out. Order is
   * normalized to the journey order regardless of input order.
   */
  availableDocs?: DirectionDocKind[];
  /**
   * Invoked when a cross-link is activated. When omitted the cross-links render
   * as non-interactive labels (the consumer owns navigation; this component is
   * presentational).
   */
  onNavigate?: (kind: DirectionDocKind) => void;
  className?: string;
}

export function DirectionDocView({
  doc,
  catalog,
  availableDocs,
  onNavigate,
  className,
}: DirectionDocViewProps) {
  const meta = TIER_META[doc.kind];
  const stripped = stripLeadingTitle(doc.contentMd);
  const { body, openQuestionsMd } = splitOpenQuestions(stripped);

  const crossLinks = (availableDocs ?? [])
    .filter((k) => k !== doc.kind)
    .filter((k, i, arr) => arr.indexOf(k) === i)
    .sort((a, b) => DIRECTION_DOC_ORDER.indexOf(a) - DIRECTION_DOC_ORDER.indexOf(b));

  return (
    <article
      className={['dd-doc', className].filter(Boolean).join(' ')}
      style={{ '--dd-accent': `var(${meta.accentVar})` } as CSSProperties}
      aria-label={meta.label}
    >
      <div className="dd-meta">
        <span className="dd-dot" aria-hidden="true" />
        <span>{meta.kicker}</span>
        {meta.optional && <span className="dd-opt">optional</span>}
      </div>

      <h1 className="dd-title">{meta.label}</h1>

      <div className="dd-readhint">
        <MessageSquare className="ic" width={15} height={15} aria-hidden="true" />
        <span>
          <b>Read-only.</b> Anything off? Just tell Motir in the chat — it rewrites the write-up for
          you. Nothing&apos;s locked yet.
        </span>
      </div>

      <div className="dd-prose wmde-markdown">{renderMarkdown(body)}</div>

      {doc.kind === 'vision' && catalog && <FeatureCatalogView catalog={catalog} />}

      {openQuestionsMd && (
        <aside className="dd-openq" aria-label="Open questions">
          <span className="dd-openq-icon" aria-hidden="true">
            <HelpCircle width={18} height={18} />
          </span>
          <div>
            <div className="dd-openq-title">Open questions</div>
            <div className="dd-prose wmde-markdown">{renderMarkdown(openQuestionsMd)}</div>
          </div>
        </aside>
      )}

      {crossLinks.length > 0 && (
        <nav className="dd-xlinks" aria-label="Other parts of your direction">
          <div className="dd-xlinks-label">Related</div>
          <div className="dd-xlinks-row">
            {crossLinks.map((kind) => {
              const m = TIER_META[kind];
              const dot = (
                <span
                  className="dd-xlink-dot"
                  style={{ background: `var(${m.accentVar})` }}
                  aria-hidden="true"
                />
              );
              return onNavigate ? (
                <button
                  key={kind}
                  type="button"
                  className="dd-xlink"
                  onClick={() => onNavigate(kind)}
                >
                  {dot}
                  {m.label}
                  <ArrowRight width={13} height={13} aria-hidden="true" />
                </button>
              ) : (
                <span key={kind} className="dd-xlink">
                  {dot}
                  {m.label}
                </span>
              );
            })}
          </div>
        </nav>
      )}
    </article>
  );
}
