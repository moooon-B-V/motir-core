import type { ReactNode } from 'react';
import { BookOpen, Search, SlidersHorizontal } from 'lucide-react';
import { cn } from '../../utils/cn';
import { buttonVariants } from '../ui/Button';
import { Card } from '../ui/Card';
import { Pill } from '../ui/Pill';
import type { StyleId } from '../../theme/styles';
import type { PaletteId } from '../../theme/palettes';
import type { TypeId } from '../../theme/typography';

/**
 * StyleVignette — the LIVE preview specimen that makes a design axis's FEEL
 * legible (Subtask 7.3.37 / MOTIR-1050).
 *
 * The fix for "I only see typography change": instead of a token-swatch table,
 * this is a composed, realistic MINI-SURFACE — a nav rail, a work-item card, a
 * search input, a button row, and a floating modal — rendered LIVE under a
 * style's shape/feel tokens + component overrides (and, independently, a palette
 * and a type pairing). Switching any axis re-shapes / re-skins / re-types the
 * whole vignette, so the user sees the product's feel, not a colour chip.
 *
 * ── Two modes ────────────────────────────────────────────────────────────
 *   • LIVE (no axis props) — the wrapper sets NO `data-*` axis attribute, so it
 *     INHERITS the active theme from `<html>` (driven by `theme-context`). Use
 *     this for the appearance-settings preview and the design-step showcase: the
 *     vignette re-renders automatically as the global selection changes.
 *   • SCOPED (any of `styleId` / `palette` / `type`) — the wrapper carries that
 *     axis attribute, so the globals.css axis block recomputes the tokens for
 *     this subtree ONLY. Use this for the onboarding Style gallery (one vignette
 *     per style) and the Palette step (one style re-rendered under each palette).
 *
 * Built on the `app/tokens/page.tsx` specimen pattern: real `--el-*` colour
 * tokens + element-semantic shape tokens + the `data-surface` material hooks, so
 * surface-material styles (glassmorphism's frosted glass, cybercore's glow grid)
 * apply exactly as they do in the shipped app. NEVER a Tier-0 `--color-*` or a
 * raw `rounded-*`/`p-*`/`h-*` (the colour + shape token rules in CLAUDE.md).
 *
 * Nesting caveat: a SCOPED base entry (`warm-editorial` / `motir` palette /
 * `motir` type) has no globals.css override block, so when it is nested under a
 * NON-base `<html>` it inherits that ancestor's axis rather than resetting to
 * the base. In the real consumers this never bites — onboarding runs against the
 * default `<html>`, and the appearance preview uses LIVE mode (inherits the
 * active selection it is meant to show). Full nested-base isolation (a reset
 * block or an iframe) is a noted follow-up if a future consumer needs it.
 */

export interface StyleVignetteProps {
  /** Scope the vignette to a specific style; omit to inherit the active style. */
  styleId?: StyleId;
  /** Scope the vignette to a specific palette; omit to inherit the active palette. */
  palette?: PaletteId;
  /** Scope the vignette to a specific type pairing; omit to inherit the active type. */
  type?: TypeId;
  /**
   * Accessible name for the preview region. The vignette is decorative chrome,
   * so it is announced as a single labelled image rather than a pile of
   * read-out controls.
   */
  label?: string;
  className?: string;
}

/** A muted progress bar; `accent` tints it with the active accent. */
function Bar({ accent, widthPct }: { accent?: boolean; widthPct: number }) {
  return (
    <div className="h-[6px] w-full overflow-hidden rounded-(--radius-badge) bg-(--el-muted)">
      <div
        className={cn(
          'h-full rounded-(--radius-badge)',
          accent ? 'bg-(--el-accent)' : 'bg-(--el-border-strong)',
        )}
        style={{ width: `${widthPct}%` }}
      />
    </div>
  );
}

/** One row of the work-item card's mini list — a status dot + label + chip. */
function ListRow({ dotVar, label, chip }: { dotVar: string; label: string; chip: string }) {
  return (
    <div className="flex items-center gap-2 text-[11px] text-(--el-text-secondary)">
      <span
        className="size-2 shrink-0 rounded-full"
        style={{ background: `var(${dotVar})` }}
        aria-hidden
      />
      <span className="truncate">{label}</span>
      <span className="ml-auto shrink-0 rounded-(--radius-badge) bg-(--el-surface) px-(--spacing-chip-x) py-(--spacing-chip-y) text-[9px] font-medium text-(--el-text-secondary)">
        {chip}
      </span>
    </div>
  );
}

export function StyleVignette({ styleId, palette, type, label, className }: StyleVignetteProps) {
  // Only emit an axis attribute when the caller pins it; an omitted axis stays
  // inherited (LIVE mode), which is how the appearance preview follows the
  // global selection without re-implementing the theme context.
  const axisAttrs: Record<string, string> = {};
  if (styleId) axisAttrs['data-style'] = styleId;
  if (palette) axisAttrs['data-palette'] = palette;
  if (type) axisAttrs['data-type'] = type;

  return (
    <div
      {...axisAttrs}
      role="img"
      aria-label={label ?? 'Design style preview'}
      className={cn(
        'style-vignette relative isolate overflow-hidden',
        'rounded-(--radius-card) border border-(--el-border) bg-(--el-surface)',
        'shadow-(--shadow-subtle)',
        className,
      )}
    >
      {/* Material canvas: transparent for flat styles; the glassmorphism gradient
          / cybercore grid is painted here via the descendant rules in
          globals.css (a preview can't lean on the body-scoped canvas). */}
      <span className="sv-canvas pointer-events-none absolute inset-0 -z-10" aria-hidden />

      <div className="flex flex-col gap-3 p-3">
        {/* NAV — a compact rail; data-surface lets a material style frost it. */}
        <div
          data-surface="sidebar"
          className="flex items-center gap-2 rounded-(--radius-control) bg-(--el-sidebar-bg) px-3 py-2"
        >
          <span className="size-2.5 rounded-full bg-(--el-accent)" aria-hidden />
          <span className="font-serif text-[12px] font-semibold text-(--el-text)">Acme</span>
          <span className="ml-2 rounded-(--radius-control) bg-(--el-accent) px-2 py-[3px] text-[10px] font-medium text-(--el-accent-text)">
            Board
          </span>
          <span className="text-[10px] text-(--el-text-muted)">Backlog</span>
          <span className="text-[10px] text-(--el-text-muted)">Reports</span>
          <span className="ml-auto size-5 rounded-full bg-(--el-muted)" aria-hidden />
        </div>

        <div className="grid grid-cols-[1.4fr_1fr] gap-3">
          {/* WORK-ITEM CARD — the centrepiece: type hue + serif title + status. */}
          <Card className="flex flex-col gap-2 !p-3">
            <div className="flex items-center gap-2">
              {/* A decorative story-type icon in its `--el-type-story` hue. The
                  package can't depend on motir-core's domain `IssueTypeIcon`
                  (which maps work-item kinds → glyphs), so the vignette inlines
                  the same glyph + hue directly — pixel-identical, boundary-clean. */}
              <BookOpen className="size-4 text-(--el-type-story)" aria-hidden />
              <span className="truncate font-serif text-[13px] font-semibold text-(--el-text)">
                Ship the billing flow
              </span>
              <Pill status="in-progress" className="ml-auto !text-[9px]">
                In progress
              </Pill>
            </div>
            <div className="flex flex-col gap-1.5">
              <ListRow dotVar="--el-success" label="Invoice schema" chip="Done" />
              <ListRow dotVar="--el-warning" label="Dunning emails" chip="Review" />
              <ListRow dotVar="--el-info" label="Stripe webhook" chip="To do" />
            </div>
            <div className="mt-0.5 flex flex-col gap-1.5">
              <Bar accent widthPct={66} />
              <Bar widthPct={38} />
            </div>
          </Card>

          {/* MODAL — a floating dialog panel; modal radius + elevation + scrim. */}
          <div className="relative">
            <span
              className="pointer-events-none absolute -inset-1 rounded-(--radius-card) bg-black/10"
              aria-hidden
            />
            <div
              data-surface="modal"
              className="relative flex flex-col gap-2 rounded-(--radius-modal) border border-(--el-border) bg-(--el-page-bg) p-3 shadow-(--shadow-modal)"
            >
              <span className="font-serif text-[12px] font-semibold text-(--el-text)">
                New invoice
              </span>
              <Bar widthPct={100} />
              <Bar widthPct={72} />
              <div className="mt-1 flex gap-2">
                <span
                  className={cn(
                    buttonVariants({ variant: 'primary', size: 'sm' }),
                    '!h-7 !px-3 !text-[10px]',
                  )}
                >
                  Create
                </span>
                <span
                  className={cn(
                    buttonVariants({ variant: 'ghost', size: 'sm' }),
                    '!h-7 !px-3 !text-[10px]',
                  )}
                >
                  Cancel
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* INPUT — a search field; data-surface lets a material style fill it. */}
        <div
          data-surface="input"
          className="flex h-(--height-input) items-center gap-2 rounded-(--radius-input) border border-(--el-border-strong) bg-(--el-page-bg) px-(--spacing-input-x) text-[11px] text-(--el-text-muted)"
        >
          <Search className="size-3.5" aria-hidden />
          <span>Search work items…</span>
        </div>

        {/* BUTTON ROW — primary + ghost, exact Button silhouettes (non-interactive). */}
        <div className="flex gap-2">
          <span className={cn(buttonVariants({ variant: 'primary', size: 'sm' }), '!text-[11px]')}>
            New work item
          </span>
          <span className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), '!text-[11px]')}>
            <SlidersHorizontal className="size-3.5" aria-hidden />
            Filter
          </span>
        </div>
      </div>
    </div>
  );
}

export default StyleVignette as (props: StyleVignetteProps) => ReactNode;
