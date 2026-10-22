'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { usePrefersReducedMotion } from '@/lib/hooks/usePrefersReducedMotion';
import { WAVE_BAND_PATH, WAVE_BAND_VIEW_BOX } from './waveBand';
import {
  FLOW_ENERGY,
  easedEnergy,
  waveBandFlowFrame,
  type WaveBandFlowFrame,
} from './waveBandFlow';

// THE MOTIR MARK AT WORK — the colour wave flow (MOTIR-9213; design
// `design/ai-chat/design-notes.md` § _The Motir mark at work_, MOTIR-9212).
//
// The inverted mark (`BrandMark variant="mark" tone="inverted"`, for an accent
// fill), able to flow. At rest it renders that glyph's markup exactly. While
// `flowing`, a `requestAnimationFrame` loop rewrites the path's `d` and fills it
// with a cycling gradient over `--el-mark-wave-1..3`; the energy eases in and
// out, so the first and last frames are the shipped glyph. No library: the
// frames are `waveBandFlow.ts`, written straight onto the DOM, so React renders
// only when the gradient appears or goes.
//
// The motion is OPT-IN: it runs only under `prefers-reduced-motion:
// no-preference` (a reader with no `matchMedia` gets the still glyph), and the
// loop pauses while the tab is hidden or the mark is off screen. Decorative: the
// glyph is `aria-hidden`, and nothing here adds a role, a name or a live region.

/** One flow at a time, its energy, clock and frame loop — kept off React state. */
class FlowEngine {
  private e = 0;
  private from = 0;
  private to = 0;
  private easeAt = 0;
  private flowAt = 0;
  private raf = 0;
  private allowed = false;
  visible = true;
  onScreen = true;

  constructor(private readonly paint: (frame: WaveBandFlowFrame | null) => void) {}

  /** Motion permitted (no reduce, a `matchMedia` to ask). Off ⇒ the still glyph, now. */
  setAllowed(allowed: boolean) {
    this.allowed = allowed;
    if (allowed) return;
    this.stop();
    this.e = this.from = this.to = 0;
    this.paint(null);
  }

  /** Ease toward flowing or toward rest from wherever the energy is now. */
  target(flowing: boolean, now: number) {
    const to = flowing && this.allowed ? FLOW_ENERGY : 0;
    if (to === this.to) return;
    if (to > 0 && this.e <= 0) this.flowAt = now;
    this.from = this.e;
    this.to = to;
    this.easeAt = now;
    this.kick();
  }

  kick() {
    if (this.raf || !this.allowed || !this.visible || !this.onScreen) return;
    if (this.e <= 0 && this.to <= 0) return;
    this.raf = requestAnimationFrame(this.frame);
  }

  stop() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  private frame = (now: number) => {
    this.raf = 0;
    // A frame's timestamp is when the frame began, which can be a moment BEFORE
    // the `target()` that queued it: never read that as time running backwards.
    this.e = easedEnergy(this.from, this.to, Math.max(0, now - this.easeAt));
    // Rest only once easing TO rest; a flow starting from zero is not over.
    if (this.e <= 0 && this.to <= 0) {
      this.e = 0;
      this.paint(null);
      return;
    }
    this.paint(waveBandFlowFrame((now - this.flowAt) / 1000, this.e));
    this.kick();
  };
}

export interface BrandMarkFlowProps {
  /** Flow while true; ease back to the still glyph when it turns false. */
  flowing: boolean;
  /** The glyph box in px. */
  size: number;
}

export function BrandMarkFlow({ flowing, size }: BrandMarkFlowProps) {
  const reduced = usePrefersReducedMotion();
  const gradientId = `mark-flow-${useId().replace(/[^A-Za-z0-9_-]/g, '')}`;
  const [live, setLive] = useState(false);
  const svgRef = useRef<SVGSVGElement>(null);
  const pathRef = useRef<SVGPathElement>(null);
  const gradientRef = useRef<SVGLinearGradientElement>(null);
  const engineRef = useRef<FlowEngine | null>(null);

  // The engine is made in the mount effect (a ref is not read during render), and
  // effects run in order, so the flow effect below always finds it.
  useEffect(() => {
    const engine = new FlowEngine((frame) => {
      const path = pathRef.current;
      if (!frame) {
        setLive(false);
        path?.setAttribute('d', WAVE_BAND_PATH);
        return;
      }
      setLive(true);
      path?.setAttribute('d', frame.d);
      const gradient = gradientRef.current;
      if (!gradient) return;
      for (const [name, value] of Object.entries(frame.axis)) {
        gradient.setAttribute(name, String(value));
      }
      gradient.querySelectorAll('stop').forEach((stop, i) => {
        stop.style.stopColor = frame.stops[i] ?? '';
      });
    });
    engineRef.current = engine;
    const sync = () => {
      engine.visible = !document.hidden;
      if (engine.visible) engine.kick();
      else engine.stop();
    };
    document.addEventListener('visibilitychange', sync);
    sync();
    let observer: IntersectionObserver | null = null;
    if (svgRef.current && typeof IntersectionObserver === 'function') {
      observer = new IntersectionObserver((entries) => {
        engine.onScreen = entries.some((entry) => entry.isIntersecting);
        if (engine.onScreen) engine.kick();
        else engine.stop();
      });
      observer.observe(svgRef.current);
    }
    return () => {
      document.removeEventListener('visibilitychange', sync);
      observer?.disconnect();
      engine.stop();
      engineRef.current = null;
    };
  }, []);

  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    engine.setAllowed(!reduced && typeof window.matchMedia === 'function');
    engine.target(flowing, performance.now());
  }, [flowing, reduced]);

  // The rest markup is `BrandMark variant="mark" tone="inverted"`'s, node for
  // node; the gradient is appended AFTER the path, so the path is never remounted.
  return (
    <span className="brand-inv">
      <svg
        ref={svgRef}
        viewBox={WAVE_BAND_VIEW_BOX}
        width={size}
        height={size}
        className="brand-glyph"
        aria-hidden="true"
        focusable="false"
      >
        <path
          ref={pathRef}
          d={WAVE_BAND_PATH}
          fill={live ? `url(#${gradientId})` : 'currentColor'}
        />
        {live ? (
          <defs>
            <linearGradient
              ref={gradientRef}
              id={gradientId}
              gradientUnits="userSpaceOnUse"
              x1={0}
              y1={12}
              x2={24}
              y2={12}
            >
              {/* The ink on the circle until the first frame lands: the flow
                  starts at zero energy, which IS the ink. */}
              <stop offset={0} style={{ stopColor: 'var(--el-accent-text)' }} />
              <stop offset={1} style={{ stopColor: 'var(--el-accent-text)' }} />
            </linearGradient>
          </defs>
        ) : null}
      </svg>
    </span>
  );
}
