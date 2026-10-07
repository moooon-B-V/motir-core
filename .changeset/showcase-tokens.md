---
'@motir/design-system': minor
---

New `--el-showcase-*` element tokens for motir.co's illustrations — the flat picture fields on the "Vibe the project" landing and "How Motir works". They are named for what they paint (`field`, `ground`, `highlight`, `decision`, `record`, `wash`, `wash-warm`, `paper`, …), each field with a `*-text` token that reads on it, and every one maps to a palette colour, so a palette re-skins them. The ground stays dark in dark mode; the Motir palette makes the highlight its Sunglow yellow, and every other palette uses its own accent.

Also `--el-logo-mark` / `--el-logo-tile` for the wave mark on its rounded tile: the mark is the palette's identity hue (its primary fill; the cool-blue primary in Motir, whose fill is the ink CTA), the tile a pale wash of it — or a dark tile for the palettes whose hue is bright (Amber, Sienna, Citrine, Candy).

And `--el-product-*`, one mark colour per product in motir.co's Products menu (`ai-planner`, `project-management`, `project-manager`, `ai-debugging`, `mcp`, `cli`, `claude-code-connector`, `claude-code-plugin`, `agent-fleet`, `agent-hosting`, `sandbox`), each a palette hue or a mix of two.
