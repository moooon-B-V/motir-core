---
'@motir/design-system': minor
---

`ComboboxOption` gains `disabled?: boolean`: the option stays in the list, focusable and announced as unavailable (`aria-disabled`), reads in `--el-text-secondary`, and a click or Enter on it commits nothing. Built for the status picker's held moves (MOTIR-5528).
