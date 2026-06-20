/**
 * The SVG roughen filter for the Hand-Drawn / Indie style (Subtask 7.3.41).
 *
 * A hand-drawn aesthetic needs genuinely ROUGH, wavy edges — an asymmetric
 * border-radius alone only bends the corners; the lines between them stay
 * machine-straight. This `feTurbulence` + `feDisplacementMap` filter warps an
 * edge into an ink-like wobble (the Excalidraw / rough.js look).
 *
 * globals.css references it as `filter: url(#hd-rough)` on a CONTENT-SAFE
 * `::after` pseudo-border (only the outline is displaced, never the text), and
 * ONLY under `[data-style='hand-drawn-indie']` — so the filter def is inert for
 * every other style. It lives here, mounted once in the root layout next to
 * `<ImmersiveTilt />` (the same per-style-mechanism pattern), so `url(#hd-rough)`
 * resolves on every page / route the style can be active on. A CSS-only
 * data-URI filter is unreliable across browsers (notably Safari), so the def is
 * an in-document `<svg>` — hidden, zero layout cost, and unreferenced (free)
 * until the style is selected.
 */
export function HandDrawnFilter() {
  return (
    <svg
      aria-hidden
      focusable="false"
      width="0"
      height="0"
      style={{ position: 'absolute', width: 0, height: 0, pointerEvents: 'none' }}
    >
      <defs>
        <filter id="hd-rough" x="-5%" y="-5%" width="110%" height="110%">
          <feTurbulence
            type="fractalNoise"
            baseFrequency="0.014 0.016"
            numOctaves="2"
            seed="7"
            result="noise"
          />
          <feDisplacementMap
            in="SourceGraphic"
            in2="noise"
            scale="3.5"
            xChannelSelector="R"
            yChannelSelector="G"
          />
        </filter>
      </defs>
    </svg>
  );
}
