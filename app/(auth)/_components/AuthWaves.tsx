'use client';

import { useEffect, useRef } from 'react';

/*
 * The signed-out frame's background: the wave lines from motir.co's hero,
 * ported from `motir-marketing`'s `app/_components/landing/HeroWaves.tsx` so the
 * sign-in page reads as the same product the visitor just came from.
 *
 * The wave from the Motir mark, repeated as engraved lines across the full
 * width. The lines bunch towards the auth card and spread out to the edges, and
 * they MOVE: each one drifts along its own wave and breathes a little, while a
 * band of the palette's wave hues (`--el-showcase-wave-1..3` — primary, teal,
 * accent) slides across the field. Two lines pick up the decision and highlight
 * touches where they pass the card, and a few small squares ride the lines.
 *
 * Every ink is a design-system token read from the live theme, so the field
 * follows the reader's theme and palette and re-reads them when either changes.
 * Under `prefers-reduced-motion` it is drawn once and stays still; it stops
 * drawing while off screen or while the tab is hidden.
 *
 * Decorative only: `aria-hidden`, no pointer events, nothing to tab to. It is
 * absolutely positioned, so it adds nothing to the page's height — the
 * `/device` fold budget in `app/(auth)/layout.tsx` is untouched.
 */

const LINES = 46;
/** How far each line drifts along its wave, in wave periods per second. */
const DRIFT = 0.012;
/** How fast the colour band slides across the field, in bands per second. */
const BAND_SPEED = 0.035;
/** The glow under the lines: its stroke width and blur, in CSS pixels. */
const GLOW_WIDTH = 6;
const GLOW_BLUR = 4;
/** How strongly the decision and highlight lines show beside the focus. */
const TOUCH_ALPHA = 0.35;
/** Frames are drawn at most this often; the motion is slow enough for it. */
const FRAME_MS = 1000 / 30;

/**
 * The mark's top edge, one period per screen width: the deep dip, then the
 * high crest, the way the Motir wave reads left to right (`WAVE_BAND_PATH`).
 * The second harmonic skews it like the logo — the dip comes early and the
 * crest late — and keeps it periodic, so the drift never shows a seam.
 */
function wave(t: number): number {
  // Canvas y grows DOWN, so positive is the dip: down first, then up.
  return Math.sin(t * Math.PI * 2) * 0.8 + Math.sin(t * Math.PI * 4 - 0.5) * 0.22;
}

/** A small seeded generator, so the squares land in the same places every draw. */
function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * The same colour at alpha `a`, whatever CSS colour syntax the token resolved
 * to (`#hex`, `rgb()`, or the `color(srgb …)` a `color-mix()` token computes
 * to): the canvas normalises it, and the channels are read back from that.
 */
function withAlpha(ctx: CanvasRenderingContext2D, colour: string, a: number): string {
  ctx.fillStyle = '#000';
  ctx.fillStyle = colour;
  const n = String(ctx.fillStyle);
  if (n.startsWith('#') && n.length === 7) {
    const v = parseInt(n.slice(1), 16);
    return `rgba(${(v >> 16) & 255}, ${(v >> 8) & 255}, ${v & 255}, ${a})`;
  }
  const rgb = /rgba?\(([^)]+)\)/.exec(n);
  if (rgb) {
    const [r, g, b] = (rgb[1] ?? '').split(',').map((x) => parseFloat(x));
    return `rgba(${r}, ${g}, ${b}, ${a})`;
  }
  const srgb = /color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)/.exec(n);
  if (srgb) {
    const [r, g, b] = srgb.slice(1, 4).map((x) => Math.round(parseFloat(x) * 255));
    return `rgba(${r}, ${g}, ${b}, ${a})`;
  }
  return colour;
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** `focusId` names the element the lines gather around — the auth card. */
export function AuthWaves({ focusId = 'auth-card' }: Readonly<{ focusId?: string }>) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const hero = canvas?.parentElement;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !hero || !ctx) return;
    const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

    const boxOf = (el: Element | null): Box | null => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const h = hero.getBoundingClientRect();
      return { x: r.left - h.left, y: r.top - h.top, w: r.width, h: r.height };
    };
    const near = (x: number, y: number, b: Box, pad: number) =>
      x > b.x - pad && x < b.x + b.w + pad && y > b.y - pad && y < b.y + b.h + pad;

    // ── What changes only on resize / theme change: size, inks, layout. ──
    interface Line {
      u: number;
      base: number;
      amp: number;
      phase: number;
    }
    let scene: {
      W: number;
      H: number;
      focus: Box;
      lines: Line[];
      hues: string[];
      dark: boolean;
      decision: string;
      highlight: string;
      ground: string;
      squares: Array<{ line: number; x: number; kind: number }>;
    } | null = null;

    const yAt = (l: Line, x: number, W: number, t: number) =>
      l.base + l.amp * (1 + 0.08 * Math.sin(t * 0.4 + l.u * 3)) * wave(x / W + l.phase + t * DRIFT);

    const measure = () => {
      const styles = getComputedStyle(hero);
      const token = (name: string) => styles.getPropertyValue(name).trim();
      const hues = [
        token('--el-showcase-wave-1'),
        token('--el-showcase-wave-2'),
        token('--el-showcase-wave-3'),
      ];
      // A token the loaded design system does not declare reads as ''. The
      // field draws only what resolves; it never throws over a missing ink.
      if (hues.some((h) => !h)) {
        scene = null;
        return;
      }
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const W = hero.clientWidth;
      const H = hero.clientHeight;
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const focus = boxOf(document.getElementById(focusId));
      if (!focus || W === 0) {
        scene = null;
        return;
      }
      const fy = focus.y + focus.h / 2;
      const lines = Array.from({ length: LINES + 1 }, (_, k) => {
        const u = (k / LINES) * 2 - 1;
        return {
          u,
          base: fy + Math.sign(u) * Math.pow(Math.abs(u), 1.7) * H * 0.95,
          amp: 70 + 110 * (1 - Math.abs(u)),
          phase: u * 0.18,
        };
      });
      // The squares are placed once, on the resting field, clear of the words;
      // after that they ride their lines.
      const keepClear = [
        // The language control sits in the page's top-right corner.
        boxOf(hero.querySelector('header')),
        focus,
      ].filter((b): b is Box => b !== null);
      const rand = seeded(7);
      const squares: Array<{ line: number; x: number; kind: number }> = [];
      for (let tries = 0; squares.length < 7 && tries < 400; tries++) {
        const line = 2 + Math.floor(rand() * (LINES - 4));
        const x = 40 + rand() * (W - 80);
        const l = lines[line];
        if (!l || keepClear.some((b) => near(x, yAt(l, x, W, 0), b, 90))) continue;
        squares.push({ line, x, kind: squares.length % 3 });
      }
      scene = {
        W,
        H,
        focus,
        lines,
        hues,
        dark: document.documentElement.getAttribute('data-theme') === 'dark',
        decision: token('--el-showcase-decision'),
        highlight: token('--el-showcase-highlight'),
        ground: token('--el-showcase-ground'),
        squares,
      };
    };

    // ── One frame at time t (seconds). ──
    const frame = (t: number) => {
      if (!scene) return;
      const { W, H, focus, lines, hues, dark } = scene;
      ctx.clearRect(0, 0, W, H);

      // The colour band: the three hues repeating across the field, sliding.
      const period = W * 1.4;
      const x0 = -period * ((t * BAND_SPEED) % 1);
      const band = ctx.createLinearGradient(x0, 0, x0 + period * 2, 0);
      const cycle = [...hues, ...hues, hues[0] ?? ''];
      cycle.forEach((hue, i) => band.addColorStop(i / (cycle.length - 1), hue));

      // THE GLOW: every line once more as one wide, blurred stroke in the same
      // band, under the thin lines — a soft light around them rather than a
      // second set of lines. `ctx.filter` is skipped where unsupported, and
      // the wide low-alpha stroke alone still reads as a halo.
      const glow = new Path2D();
      for (const l of lines) {
        for (let x = -10; x <= W + 10; x += 6) {
          const y = yAt(l, x, W, t);
          if (x === -10) glow.moveTo(x, y);
          else glow.lineTo(x, y);
        }
      }
      ctx.save();
      ctx.strokeStyle = band;
      ctx.lineWidth = GLOW_WIDTH;
      ctx.globalAlpha = dark ? 0.06 : 0.035;
      if ('filter' in ctx) ctx.filter = `blur(${GLOW_BLUR}px)`;
      ctx.stroke(glow);
      ctx.restore();

      ctx.lineWidth = 1;
      ctx.strokeStyle = band;
      for (const l of lines) {
        ctx.beginPath();
        for (let x = -10; x <= W + 10; x += 6) {
          const y = yAt(l, x, W, t);
          if (x === -10) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        const nearness = 1 - Math.abs(l.u);
        ctx.globalAlpha = dark
          ? 0.06 + 0.13 * nearness * nearness
          : 0.03 + 0.1 * nearness * nearness;
        ctx.stroke();
      }

      // Two lines pick up the decision and highlight touches by the card.
      const touches: Array<[number, string]> = [
        [Math.floor(LINES / 2) - 2, scene.decision],
        [Math.floor(LINES / 2) + 3, scene.highlight],
      ];
      for (const [index, colour] of touches) {
        if (!colour) continue;
        const l = lines[index];
        if (!l) continue;
        const from = focus.x - 240;
        const to = focus.x + focus.w + 240;
        const g = ctx.createLinearGradient(from, 0, to, 0);
        g.addColorStop(0, withAlpha(ctx, colour, 0));
        g.addColorStop(0.25, colour);
        g.addColorStop(0.75, colour);
        g.addColorStop(1, withAlpha(ctx, colour, 0));
        ctx.beginPath();
        for (let x = from; x <= to; x += 4) {
          const y = yAt(l, x, W, t);
          if (x === from) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.globalAlpha = TOUCH_ALPHA;
        ctx.lineWidth = 2.2;
        ctx.strokeStyle = g;
        ctx.stroke();
        ctx.lineWidth = 1;
      }

      // The decisions ride their lines.
      const { decision, highlight, ground } = scene;
      if (decision && highlight && ground) {
        ctx.globalAlpha = 1;
        for (const sq of scene.squares) {
          const l = lines[sq.line];
          if (!l) continue;
          const y = yAt(l, sq.x, W, t);
          if (sq.kind === 0) {
            ctx.fillStyle = decision;
            ctx.fillRect(sq.x - 5, y - 5, 10, 10);
          } else {
            ctx.fillStyle = ground;
            ctx.fillRect(sq.x - 6, y - 6, 12, 12);
            ctx.fillStyle = highlight;
            ctx.fillRect(sq.x - 3, y - 3, 6, 6);
          }
        }
      }
      ctx.globalAlpha = 1;
    };

    // ── The loop: throttled, and only while the hero can be seen. ──
    let raf = 0;
    let last = 0;
    let visible = true;
    const start = performance.now();
    const tick = (now: number) => {
      raf = 0;
      if (!visible || document.hidden) return;
      if (now - last >= FRAME_MS) {
        last = now;
        frame((now - start) / 1000);
      }
      raf = requestAnimationFrame(tick);
    };
    const play = () => {
      if (still) frame(0);
      else if (!raf) raf = requestAnimationFrame(tick);
    };
    const refresh = () => {
      measure();
      if (still || !raf) frame(still ? 0 : (performance.now() - start) / 1000);
      play();
    };

    let pending = 0;
    const later = () => {
      window.clearTimeout(pending);
      pending = window.setTimeout(refresh, 120);
    };
    const resize = new ResizeObserver(later);
    resize.observe(hero);
    const themed = new MutationObserver(refresh);
    themed.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'data-palette'],
    });
    const seen = new IntersectionObserver(([entry]) => {
      visible = entry?.isIntersecting ?? true;
      if (visible) play();
    });
    seen.observe(hero);
    const onVisibility = () => {
      if (!document.hidden) play();
    };
    document.addEventListener('visibilitychange', onVisibility);
    void document.fonts?.ready.then(refresh);
    refresh();

    return () => {
      window.clearTimeout(pending);
      if (raf) cancelAnimationFrame(raf);
      resize.disconnect();
      themed.disconnect();
      seen.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [focusId]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 -z-10 block size-full"
    />
  );
}
