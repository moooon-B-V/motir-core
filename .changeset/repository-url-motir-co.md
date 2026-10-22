---
'@motir/brand': patch
'@motir/cli': patch
'@motir/design-system': patch
---

`repository.url` (and `@motir/cli`'s `bugs.url`) now name `motir-co/motir-core`, the repository's home since the org move. npm refuses a provenance-signed publish whose `repository.url` names a different repository than the one in the provenance, so every CI publish since the move failed with E422 (MOTIR-9320). No code changes.
