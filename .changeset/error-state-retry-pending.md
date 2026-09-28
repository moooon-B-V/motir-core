---
'@motir/design-system': minor
---

`ErrorState` gains an optional `retryPending` (and `retryPendingLabel`): while true, its retry button takes `Button`'s `loading` state — Spinner, `disabled`, `aria-busy` — and shows the pending label. Additive; every existing call site renders unchanged.
