---
'@motir/design-system': patch
---

`TokensSpecimen` no longer re-themes the page it is dropped into (MOTIR-7725). It used to wrap itself in `ThemeProvider`, whose effects write `data-theme`, `data-style`, `data-palette` and `data-type` onto `<html>` from the visitor's stored choice or the app defaults, and rewrite `data-theme` whenever the OS colour scheme changes. Nothing inside the specimen reads the theme context, so the provider is gone: the specimen now renders under whatever appearance its host applied. A consumer that relied on the specimen to set up appearance wraps it in its own `ThemeProvider`.
