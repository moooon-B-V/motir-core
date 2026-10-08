---
'@motir/design-system': minor
---

`Combobox` gains four optional props for the signed-out language control (MOTIR-7758). An option's `lang` is rendered as the `lang` attribute on its row, and on the trigger's label while it is selected, so a list that names each language in its own script is announced in that language. `triggerIcon` draws a decorative leading glyph on the trigger only, never in the rows. `busy` marks the trigger `aria-busy` and puts a spinner in the chevron's slot without disabling it. `align="end"` lines the menu's right edge up with the trigger's, so a menu opened from a right-hand corner grows leftwards instead of running past the viewport. Existing callers are unchanged.
