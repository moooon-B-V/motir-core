'use client';

import { useEffect } from 'react';
import { tiltFromPointer } from '@/lib/theme/tilt';

/**
 * ImmersiveTilt — the pointer-parallax engine for the 3D / Immersive style
 * (`data-style="3d-immersive"`, Subtask 7.3.39).
 *
 * This is the one style that ships a behaviour, not just CSS tokens: the
 * standard "3D card" effect (vanilla-tilt.js / react-parallax-tilt / Atropos) is
 * intrinsically interactive — a tile tips toward the cursor — which a CSS
 * `[data-style]` token block cannot express. The engine is a single delegated
 * `pointermove` listener on the document (cheap; no per-tile listeners): when
 * the active style is 3D / Immersive and the user has NOT requested reduced
 * motion, it finds the `[data-tilt]` tile under the cursor, maps the pointer to
 * a rotation via `tiltFromPointer`, and writes per-tile `--tilt-rx` / `--tilt-ry`
 * CSS vars + a `data-tilt-active` flag. The CSS in globals.css
 * (`[data-style='3d-immersive'] [data-tilt]`, also reduced-motion-gated) turns
 * those vars into `rotateX/rotateY` over a perspective. On leave the vars zero
 * and the tile eases back flat.
 *
 * Gating (the card's "accessibility-heavy; gate carefully" caveat):
 *   - Inert unless `<html data-style>` is `3d-immersive` (observed live via a
 *     MutationObserver, so toggling the style in the Appearance picker
 *     enables/disables it instantly with no reload).
 *   - Inert under `prefers-reduced-motion: reduce` (observed live too); the
 *     static deep-shadow depth carries the style with zero motion.
 *
 * Perf: reads are coalesced into a single rAF per frame and only one
 * `getBoundingClientRect` per frame for the hovered tile; the listener is
 * passive. Returns null — it renders nothing.
 */

const STYLE_ID = '3d-immersive';
const MAX_TILT_DEG = 7;
const TILT_HOOK = '[data-tilt]';

export function ImmersiveTilt() {
  useEffect(() => {
    const html = document.documentElement;
    const reduceMq = window.matchMedia('(prefers-reduced-motion: reduce)');

    let enabled = false;
    let current: HTMLElement | null = null;
    let frame = 0;
    let pending: { el: HTMLElement; x: number; y: number } | null = null;

    function reset(el: HTMLElement) {
      el.style.removeProperty('--tilt-rx');
      el.style.removeProperty('--tilt-ry');
      el.removeAttribute('data-tilt-active');
    }

    function clearCurrent() {
      if (current) {
        reset(current);
        current = null;
      }
    }

    function apply() {
      frame = 0;
      if (!pending) return;
      const { el, x, y } = pending;
      pending = null;
      const rect = el.getBoundingClientRect();
      const { rx, ry } = tiltFromPointer(rect, x, y, MAX_TILT_DEG);
      el.style.setProperty('--tilt-rx', `${rx.toFixed(2)}deg`);
      el.style.setProperty('--tilt-ry', `${ry.toFixed(2)}deg`);
      el.setAttribute('data-tilt-active', '1');
    }

    function onPointerMove(e: PointerEvent) {
      if (!enabled) return;
      const target = e.target as HTMLElement | null;
      const tile = target?.closest<HTMLElement>(TILT_HOOK) ?? null;
      if (!tile) {
        clearCurrent();
        return;
      }
      if (current && current !== tile) reset(current);
      current = tile;
      pending = { el: tile, x: e.clientX, y: e.clientY };
      if (!frame) frame = requestAnimationFrame(apply);
    }

    function onScrollOrLeave() {
      clearCurrent();
    }

    function syncEnabled() {
      enabled = html.dataset.style === STYLE_ID && !reduceMq.matches;
      if (!enabled) {
        if (frame) {
          cancelAnimationFrame(frame);
          frame = 0;
        }
        pending = null;
        clearCurrent();
      }
    }

    syncEnabled();
    document.addEventListener('pointermove', onPointerMove, { passive: true });
    document.addEventListener('pointerleave', onScrollOrLeave);
    window.addEventListener('scroll', onScrollOrLeave, { passive: true, capture: true });
    reduceMq.addEventListener('change', syncEnabled);
    const observer = new MutationObserver(syncEnabled);
    observer.observe(html, { attributes: true, attributeFilter: ['data-style'] });

    return () => {
      document.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('pointerleave', onScrollOrLeave);
      window.removeEventListener('scroll', onScrollOrLeave, {
        capture: true,
      } as EventListenerOptions);
      reduceMq.removeEventListener('change', syncEnabled);
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
      clearCurrent();
    };
  }, []);

  return null;
}
