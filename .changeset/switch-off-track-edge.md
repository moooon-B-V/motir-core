---
'@motir/design-system': patch
---

An OFF `Switch`'s outer edge now clears WCAG 1.4.11's 3:1 against the page in every palette and theme. The OFF track was bordered in `--el-border-strong`, 1.52–2.41:1 on `--el-page-bg` in all twenty palette × theme pairs; the border now takes a new `--el-switch-off-border` (`--color-muted-foreground`, the OFF knob's own ink), lowest 4.54:1. `--el-border-strong`, and the input and secondary-button borders that share it, keep their mappings; the OFF fill and the OFF knob pairing are unchanged (MOTIR-5725).
