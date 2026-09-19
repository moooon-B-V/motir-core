---
'@motir/design-system': patch
---

An ON `Switch`'s outer edge now clears WCAG 1.4.11's 3:1 against the page in every palette and theme. The ON track was bordered in its own fill, which fell to 1.80 / 1.47 / 1.57:1 on `--el-page-bg` in amber, citrine and candy light; the border now takes a new `--el-switch-on-border` (`--color-primary`, the palette's primary ink), lowest 4.67:1 across all twenty palette × theme pairs. The fill and the ON knob pairing are unchanged (MOTIR-5715).
