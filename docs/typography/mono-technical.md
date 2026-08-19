# Type — Mono-Technical (`data-type="mono-technical"`)

> A new-typeface pairing registered in
> [`lib/theme/typography.ts`](../../lib/theme/typography.ts); its
> `[data-type='mono-technical']` block ships from
> [`packages/design-system/theme.css`](../../packages/design-system/theme.css),
> which [`app/globals.css`](../../app/globals.css) imports (MOTIR-1527). Its face
> is loaded via `next/font` in [`app/layout.tsx`](../../app/layout.tsx). One new
> face — **IBM Plex Mono** — and it takes every text role, so no second family
> renders while the pairing is selected.

**Tagline:** IBM Plex Mono throughout — a precise, developer-grade UI.
**Faces:** IBM Plex Mono headlines + body/UI + meta/code.

## Role mapping

| Role              | `--font-*` token | Mono-Technical face                                    |
| ----------------- | ---------------- | ------------------------------------------------------ |
| Headlines (xl+)   | `--font-serif`   | IBM Plex Mono (re-pointed off the editorial serif)     |
| Body / UI         | `--font-sans`    | IBM Plex Mono (re-pointed off Inter)                   |
| Meta / code / IDs | `--font-mono`    | IBM Plex Mono (re-pointed off the base JetBrains Mono) |

**All three roles, one face.** The `[data-type='mono-technical']` block re-points
`--font-serif`, `--font-sans` AND `--font-mono` at the IBM Plex Mono stack, so
the WHOLE app re-types — nav, header, buttons and body copy as much as headlines
and IDs (Yue, 2026-06-19: a type pairing re-types the whole UI, chrome included).
That is the table above, and it is the only mapping this document states.

No colour (`--el-*`/`--color-*`) or shape (`--radius-*`/`--spacing-*`) token is
touched — the disjointness guard in `tests/theme/typographyRegistry.test.ts`.
Picking it never changes a hue (the `data-palette` axis) or a radius (the
`data-style` axis); the three axes stay independent. See
[`../DESIGN.md`](../DESIGN.md) for the three-axis contract.

## Why it exists

A developer/terminal pairing for teams who want the product to read like the
tools they live in — the precise, code-native voice of developer brands
(getdesign.md: **Resend / Ollama / Warp / OpenCode**). **IBM Plex Mono** is the
canonical technical/engineering monospace: license-clear (OFL, Google Fonts) and
visually distinct from the coding-optimized **JetBrains Mono** that `motir-mono`
already wears.

What makes Mono-Technical a real pairing change — not a `motir-mono` re-skin — is
how far it reaches: `motir-mono` re-points the headline and body/UI roles at the
base JetBrains stack and keeps JetBrains Mono for meta, while Mono-Technical
puts ONE technical face on all three roles, so eyebrows, headings, body copy,
buttons, IDs and inline code speak the same voice.

## Payload

One new face: **IBM Plex Mono** (weights 400/500/600/700, self-hosted via
`next/font`, `display: swap`). Plex Mono is the only added webfont — no sans
payload is added, because the body role is re-pointed at Plex Mono rather than
given a second family. Inter stays loaded for the base pairing and remains the
fallback if the Plex face fails to load.
