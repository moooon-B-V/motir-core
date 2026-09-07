'use client';

import { useCallback, useState, type CSSProperties } from 'react';
import { useTranslations } from 'next-intl';
import { Popover } from '@/components/ui/Popover';
import { cn } from '@/lib/utils/cn';
import { AI_CALLOUT_NAME_KEY } from '@/lib/planning/aiCallout';
import type { PlanningLaunchContext } from '@/lib/planning/launcher';
import { AiCalloutMenu } from './AiCalloutMenu';
import { BrandMark } from '@/components/brand/BrandMark';
import { useDraggableOrb } from '@/lib/hooks/useDraggableOrb';

/**
 * PlanWithAIFab — the floating Motir orb, the universal AI callout's TRIGGER
 * (MOTIR-1299 / Story 7.20; MOTIR-1812 / Story 7.24. Design @
 * `design/ai-chat/ai-callout-menu.mock.html`). A glowing orb afloat
 * bottom-right on every screen — the second of the two entrances the design
 * ships (alongside the header pill, `PlanWithAILauncher`).
 *
 * It used to navigate STRAIGHT to the planning workspace; as its own note
 * promised, it has now "grown a menu in place". The orb is a `<button>` inside
 * `Popover.Trigger`, and *Plan with AI* is the first ROW of the callout
 * (`AiCalloutMenu`) — so the orb's accessible name is the callout's, "Motir
 * AI", and "Plan with AI" names the row inside. Every shipped visual is
 * unchanged: the same fill, glow, pulse, position, z-index and transitions.
 *
 * The one-click path is NOT lost — the TopNav hero pill and ⌘K still go
 * straight to the workspace from every screen — as an OVERLAY on the page they
 * are on since MOTIR-4725 — and the rows are real links, so
 * ⌘/middle-click survives one level in.
 *
 * Wears the Motir mark (MOTIR-3185) at the 26px glyph box the design
 * specifies for the 56px circle — composed from `BrandMark`, never inlined.
 * Palette-derived throughout (the orb fill + glow are `color-mix()` over
 * `--el-*`, never raw hex); the orb is genuinely circular (`rounded-full`).
 * Sits at `z-40` — below toasts / modals / the command palette (`z-50`), which
 * may transiently cover it.
 *
 * Gating is the MOUNT's job (rendered only where AI planning is configured +
 * there's a project to plan into), like the header pill.
 *
 * ── DRAGGABLE, AND THROWABLE (MOTIR-3214) ───────────────────────────────────
 * The orb can be dragged anywhere on screen, and a hard flick throws it: it
 * carries its release velocity, bounces off the viewport edges and settles. The
 * physics is `lib/planning/orbPhysics.ts` (pure) and the wiring is
 * `lib/hooks/useDraggableOrb.ts`; this component only supplies the element.
 *
 * Three behaviours worth knowing before editing:
 *   * A press that does not MOVE still opens the callout — the drag threshold is
 *     4 px, and past it the click that the browser fires on release is swallowed
 *     in the capture phase so a throw does not also open the panel.
 *   * The position is NOT persisted. A new tab puts the orb back in its default
 *     corner; it survives client-side navigation only because this component is
 *     mounted by the layout and never unmounts.
 *   * `prefers-reduced-motion` skips the THROW, not the drag: the orb still goes
 *     wherever it is put, it just does not fly there.
 *   * A MOVING orb CLOSES the callout (MOTIR-3226). The panel is a popover
 *     anchored to this button, so an open one rode the drag across the page and
 *     then stranded ~818px away mid-throw — Radix's `PopperContent` re-anchors on
 *     scroll/resize and an IntersectionObserver, none of which a per-frame
 *     `translate` fires. Hiding it is what was asked for, and it is also the only
 *     answer that does not put a menu on a flying orb. It does NOT re-open at
 *     rest: the release click is swallowed, so the user asked for nothing.
 *
 * ⚠️ AND ONE RULE ABOUT THIS ELEMENT'S CLASSES (MOTIR-3214). The hook writes the
 * orb's position into the `translate` property every animation frame. So:
 *   * NOTHING here may transition `translate` — `transition-transform` in Tailwind
 *     v4 is `transition-property: transform, translate, scale, rotate`, and with it
 *     on, a 150ms ease fought the frame loop for the whole flight and the orb
 *     reversed ~350px short of the wall it was meant to bounce off. The scale is
 *     eased on its own instead.
 *   * NOTHING here may write `translate` or `transform` as a utility — the hover
 *     and press scales are safe only because `scale` composes independently of
 *     `translate`; a `translate-x-*` utility would silently fight the drag.
 */
export interface PlanWithAIFabProps {
  /** The originating context — defaults to the global project entrance. */
  context?: PlanningLaunchContext;
  className?: string;
}

// The orb fill (a lit sphere — lighter top-left, accent body, a violet-leaning
// edge) + the pink+violet aura. All palette-derived.
//
// The FIRST stop is the gradient's lightest point by construction, it sits at
// 33%/27% — well inside the centred glyph box — and the glyph is white
// (`--el-accent-text`), so that stop is where the mark is closest to
// disappearing. How much of the glyph's own colour is mixed into the fill there
// is therefore a CONTRAST knob, not a decoration: it lives once, as
// `--orb-lit-mix` in the design system's recipe-knob block, where the number is
// documented with the twenty palette x theme measurements that chose it
// (MOTIR-3207). Do not inline a percentage back into this string — the mock in
// `design/ai-chat/ai-callout-menu.mock.html` reproduces this recipe and reads
// the same token, and `tests/theme/orb-glyph-contrast.test.ts` fails if either
// side grows its own copy.
//
// ⚠️ AND IT READS FROM `--plan-orb-fill`, with the recipe below as the FALLBACK
// (MOTIR-4743, the same seam shape the `box-shadow` below already uses). An
// inline `background-image` beats every stylesheet rule, so until this variable
// existed no [data-style] block could give the orb its own material — the
// per-style treatment `design/ai-chat/design-notes.md` § *The STYLE MATRIX*
// draws was unreachable. A style that sets nothing falls through to this
// literal, byte-identical to before.
//
// ⚠️ A STYLE COMPOSES OVER THIS RECIPE, IT NEVER REPLACES IT, and the added
// layer is CROWN-CONFINED (`background-size: 100% 20–26%`, above the centred
// 26/56 glyph box). Measured across the whole circle, glassmorphism's sheen and
// retrofuturism's crown put the glyph box at 3.17:1 / 2.67:1 and 3.34:1 /
// 2.78:1 — under the 3:1 floor `tests/theme/orb-glyph-contrast.test.ts`
// enforces. Confined, both measure the shipped 3.78:1 / 3.10:1.
const ORB_STYLE: CSSProperties = {
  backgroundImage:
    'var(--plan-orb-fill, radial-gradient(circle at 33% 27%, color-mix(in srgb, var(--el-accent-text) var(--orb-lit-mix), var(--el-accent)), var(--el-accent) 56%, color-mix(in srgb, var(--el-accent) 68%, var(--el-highlight))))',
  // ⚠️ Read from a variable, with the literal as its FALLBACK — an inline
  // `box-shadow` beats every stylesheet rule, so this is the only seam a
  // [data-style] block has onto the orb's depth (MOTIR-3522, same treatment as
  // PlanWithAILauncher's HERO_STYLE). `--plan-orb-shadow` is set in the
  // `[data-style='3d-immersive']` block of packages/design-system/theme.css.
  boxShadow: [
    'var(--plan-orb-shadow,',
    'inset 0 1px 0 color-mix(in srgb, var(--el-accent-text) 40%, transparent),',
    '0 8px 24px -6px color-mix(in srgb, var(--el-accent) 80%, transparent),',
    '0 0 28px -2px color-mix(in srgb, var(--el-highlight) 55%, transparent))',
  ].join(' '),
};

export function PlanWithAIFab({ context = { kind: 'project' }, className }: PlanWithAIFabProps) {
  const t = useTranslations('shell');
  const [open, setOpen] = useState(false);
  const label = t(AI_CALLOUT_NAME_KEY);
  // A moving orb cannot carry the callout with it (MOTIR-3226), so the gesture
  // closes it. This is a CALLBACK rather than a `useEffect` watching `moving`
  // because both `react-hooks/set-state-in-effect` and `set-state-in-render` are
  // errors here — and because it is the better shape anyway: it fires inside the
  // same `pointermove` that paints the orb, so the panel is gone in the frame the
  // orb first moves rather than a commit later.
  const closeOnMove = useCallback(() => setOpen(false), []);
  // Drag + throw (MOTIR-3208). The hook owns pointer capture and the frame loop;
  // `lib/planning/orbPhysics.ts` owns every decision about where the orb goes.
  const { attach, onPointerDown, onClickCapture, dragging } = useDraggableOrb({
    onMoveStart: closeOnMove,
  });

  return (
    // Non-modal, like the user menu: the page behind stays scrollable and
    // readable while the callout is open.
    <Popover open={open} onOpenChange={setOpen} modal={false}>
      <Popover.Trigger asChild>
        <button
          ref={attach}
          type="button"
          aria-label={label}
          title={label}
          // A key, not a chip (MOTIR-3522): `rounded-full` is also worn by two
          // Switch tracks, a colour swatch, an avatar and a tag remove-×, so the
          // radius cannot carry the role and the orb declares it.
          data-depth="key"
          // The MATERIAL hook (MOTIR-4743). `data-surface` carries the per-style
          // rules the two hero controls SHARE (border, glow, type, ink);
          // `data-ai-cta` says which of the two this is, because they do not
          // share a fill recipe — see ORB_STYLE's header.
          data-surface="ai-cta"
          data-ai-cta="orb"
          style={ORB_STYLE}
          onPointerDown={onPointerDown}
          onClickCapture={onClickCapture}
          className={cn(
            'fixed right-5 bottom-5 z-40 inline-flex h-14 w-14 items-center justify-center rounded-full',
            'text-(--el-accent-text) select-none',
            // `touch-none` so a drag on a touch screen moves the orb instead of
            // scrolling the page under it — without it the gesture is stolen by
            // the scroller before `pointermove` ever fires.
            'touch-none',
            // ⚠️ `transition-[scale]`, NOT `transition-transform`: the orb's position
            // is written to `translate` every frame, and `transition-transform`
            // covers translate too (Tailwind v4), so it would ease every one of them
            // — see the header. Easing the scale ALONE is what was actually wanted.
            'transition-[scale]',
            dragging ? 'cursor-grabbing' : 'cursor-grab hover:scale-105 active:scale-95',
            'focus-visible:ring-(--focus-ring-color) focus-visible:ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2',
            className,
          )}
        >
          {/* The gently-pulsing aura ring (gated behind prefers-reduced-motion in
              globals.css) so the orb reads as "glowing" — inert for motion-sensitive
              users. While the callout is open the pulse STOPS (globals.css, keyed
              off the `data-state` Radix sets here) so the panel never sits inside a
              breathing halo. */}
          <span
            aria-hidden
            className="plan-with-ai-fab-pulse pointer-events-none absolute inset-0 rounded-full"
            style={{
              boxShadow: '0 0 0 0 color-mix(in srgb, var(--el-highlight) 60%, transparent)',
            }}
          />
          {/* The Motir mark, at the 26px glyph box `design/ai-chat/design-notes.md`
              § B specifies for the 56px circle (a 0.464 ratio, the same one the
              28px assistant avatar uses). `tone="inverted"` is what puts
              `--el-accent-text` on it — the glyph carries its own ink otherwise
              and would render accent-on-accent. Composed, never inlined: the path
              lives in `components/brand/waveBand.ts` alone. */}
          <span aria-hidden className="relative flex">
            <BrandMark variant="mark" tone="inverted" size={26} />
          </span>
        </button>
      </Popover.Trigger>
      <AiCalloutMenu context={context} onSelect={() => setOpen(false)} />
    </Popover>
  );
}
