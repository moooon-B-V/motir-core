# @motir/design-system

## 0.4.3

### Patch Changes

- db891d3: An OFF `Switch`'s outer edge now clears WCAG 1.4.11's 3:1 against the page in every palette and theme. The OFF track was bordered in `--el-border-strong`, 1.52–2.41:1 on `--el-page-bg` in all twenty palette × theme pairs; the border now takes a new `--el-switch-off-border` (`--color-muted-foreground`, the OFF knob's own ink), lowest 4.54:1. `--el-border-strong`, and the input and secondary-button borders that share it, keep their mappings; the OFF fill and the OFF knob pairing are unchanged (MOTIR-5725).

## 0.4.2

### Patch Changes

- 0be8c0e: An ON `Switch`'s outer edge now clears WCAG 1.4.11's 3:1 against the page in every palette and theme. The ON track was bordered in its own fill, which fell to 1.80 / 1.47 / 1.57:1 on `--el-page-bg` in amber, citrine and candy light; the border now takes a new `--el-switch-on-border` (`--color-primary`, the palette's primary ink), lowest 4.67:1 across all twenty palette × theme pairs. The fill and the ON knob pairing are unchanged (MOTIR-5715).

## 0.4.1

### Patch Changes

- b466c07: `Switch` knobs now clear WCAG 1.4.11's 3:1 against their own track in every palette and theme. The OFF knob takes a new `--el-switch-knob-off` (`--color-muted-foreground`) instead of sharing the surface-coloured knob that was 1.01:1 / 1.00:1 on `--el-muted`; the ON knob `--el-switch-knob` now writes the primary fill's own ink (`--color-primary-foreground`), which lifts amber, citrine, candy and sienna light and garnet dark over the bar (MOTIR-5711).

## 0.4.0

### Minor Changes

- 686a872: `Combobox` gains `footer?: ReactNode`: a non-interactive note pinned below the listbox inside the open menu, outside the option indices, so keyboard navigation is unaffected. Built for the Monitoring room's minimum-level control, which says at the action that causes it that lowering also re-checks earlier issues (MOTIR-5582).

## 0.3.0

### Minor Changes

- 570ecd1: `ComboboxOption` gains `disabled?: boolean`: the option stays in the list, focusable and announced as unavailable (`aria-disabled`), reads in `--el-text-secondary`, and a click or Enter on it commits nothing. Built for the status picker's held moves (MOTIR-5528).

## 0.2.0

### Minor Changes

- 1491e94: The renamed workbench landing surface with its five tab slots and every state, the
  hero AI control taking each style's material, and the 3D / Immersive shell chrome
  reaching every signed-in surface rather than only its own canvas. The collapsed
  rail derives from `--height-control`, the avatar ramp is re-warranted on its real
  consumer, and the inert `tailwindcss-animate` classes are deleted at all four sites.
