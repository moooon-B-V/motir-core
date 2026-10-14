---
'@motir/design-system': minor
---

An overlay no longer follows full screen into itself (MOTIR-8560). `Modal`, `Popover`, `Tooltip`, and the `Combobox` and `MultiSelectPicker` menus still portal into `document.fullscreenElement` while there is one, except when that element is inside the overlay: a `<video>` in a dialog going full screen used to pull the dialog into the video, which unmounted the video, dropped the browser out of full screen and reset playback. The overlay now stays where it was until full screen ends. The package exports `usePortalContainer(ref)`, the hook behind this; `useFullscreenElement()` is unchanged.
