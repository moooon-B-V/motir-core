# Design inspiration sources

These are reference DESIGN.md files fetched from
[getdesign.md](https://getdesign.md) via `npx getdesign@latest add <name>`.
They are NOT Motir's design system — they are the **source material**
that informed it.

| File | What we borrowed |
| --- | --- |
| [`notion.md`](./notion.md) | Color palette (purple primary, charcoal text scale, pastel feature tints, hairline borders), spacing rhythm |
| [`figma.md`](./figma.md) | Shape language for the `soft` display style (pill buttons, larger radii, mono caption type) |

The actual Motir design system lives in
[`../DESIGN.md`](../DESIGN.md) — read that to understand how to build UI.
This folder is a historical record of where the choices came from.

You can refresh these files at any time:

```bash
npx getdesign@latest add notion  # writes DESIGN.md to repo root
npx getdesign@latest add figma   # overwrites if previous still present
```

Then move them back here under `notion.md` / `figma.md` and update
`DESIGN.md` if any inspiration evolved.
