# Type — Mono-Technical (`data-type="mono-technical"`)

> A new-typeface pairing registered in
> [`lib/theme/typography.ts`](../../lib/theme/typography.ts); its
> `[data-type='mono-technical']` block lives in
> [`app/globals.css`](../../app/globals.css) and its face is loaded via
> `next/font` in [`app/layout.tsx`](../../app/layout.tsx). One new face —
> **IBM Plex Mono**; the body reuses the already-loaded **Inter**.

**Tagline:** IBM Plex Mono headlines and meta over a neutral sans body — precise, developer-grade.
**Faces:** IBM Plex Mono headlines + meta/code · Inter body.

## Role mapping

| Role              | `--font-*` token | Mono-Technical face                                    |
| ----------------- | ---------------- | ------------------------------------------------------ |
| Headlines (xl+)   | `--font-serif`   | IBM Plex Mono (re-pointed off the editorial serif)     |
| Body / UI         | `--font-sans`    | Inter (the neutral base body — unchanged)              |
| Meta / code / IDs | `--font-mono`    | IBM Plex Mono (re-pointed off the base JetBrains Mono) |

## Why it exists

A developer/terminal pairing for teams who want the product to read like the
tools they live in — the precise, code-native voice of developer brands
(getdesign.md: **Resend / Ollama / Warp / OpenCode**). **IBM Plex Mono** is the
canonical technical/engineering monospace: license-clear (OFL, Google Fonts) and
visually distinct from the coding-optimized **JetBrains Mono** that `motir-mono`
already wears.

What makes Mono-Technical a real pairing change — not a `motir-mono` re-skin — is
that it dresses **both** the headline role (`--font-serif`) **and** the meta/code
role (`--font-mono`) in IBM Plex Mono, so eyebrows, headings, IDs, and inline
code all speak one cohesive technical voice over a neutral Inter body.
`motir-mono` re-points only the headline role and keeps JetBrains Mono for meta.

The `[data-type='mono-technical']` block re-points ONLY `--font-serif` and
`--font-mono` (the headline + mono roles) at the IBM Plex Mono stack — no colour
(`--el-*`/`--color-*`) or shape (`--radius-*`/`--spacing-*`) token is touched
(the disjointness guard in `tests/theme/typographyRegistry.test.ts`). Picking it
never changes a hue (the `data-palette` axis) or a radius (the `data-style`
axis); the three axes stay independent. See [`../DESIGN.md`](../DESIGN.md) for
the three-axis contract.

## Payload

One new face: **IBM Plex Mono** (weights 400/500/600/700, self-hosted via
`next/font`, `display: swap`). The body reuses the already-loaded Inter, so no
sans payload is added. Plex Mono is the only added webfont.
