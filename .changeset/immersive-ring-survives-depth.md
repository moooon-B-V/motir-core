---
'@motir/design-system': patch
---

In the 3D / Immersive style, a Tailwind `ring-*` now shows on every surface the style gives depth to. The style's `box-shadow` rules are unlayered, so they used to replace the ring (itself a `box-shadow` in `@layer utilities`) instead of stacking with it. That erased the ring on card-radius panels, modals, tilted tiles, `shadow-(--shadow-elevated)` overlays, raised and flat controls, and recessed text fields: canvas search matches, selections and every control's `focus-visible:ring` went blank. Each rule now composes `--tw-inset-ring-shadow`, `--tw-ring-offset-shadow` and `--tw-ring-shadow` before its depth. The resting depth is unchanged (MOTIR-6440).
