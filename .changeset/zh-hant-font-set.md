---
'@motir/design-system': minor
---

A `zh-Hant` font set for Traditional Chinese (MOTIR-9239). The registry gains `zh-tw`, served by Noto Sans TC, Noto Serif TC and LXGW WenKai TC, and `resolveFontSet` now tries the full language tag before its primary subtag, so `zh-TW` resolves to the Traditional set instead of falling back to the Simplified one. `theme.css` adds `[lang]:lang(zh-TW)` blocks that select the Traditional faces. No existing set or token changes.
