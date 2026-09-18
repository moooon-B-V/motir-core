---
'@motir/design-system': patch
---

`Switch` knobs now clear WCAG 1.4.11's 3:1 against their own track in every palette and theme. The OFF knob takes a new `--el-switch-knob-off` (`--color-muted-foreground`) instead of sharing the surface-coloured knob that was 1.01:1 / 1.00:1 on `--el-muted`; the ON knob `--el-switch-knob` now writes the primary fill's own ink (`--color-primary-foreground`), which lifts amber, citrine, candy and sienna light and garnet dark over the bar (MOTIR-5711).
