---
'@motir/design-system': minor
---

Overlays now open inside an element in native full screen (MOTIR-7658). `Modal`, `Popover`, `Tooltip`, and the `Combobox` and `MultiSelectPicker` menus portal into `document.fullscreenElement` while there is one, and into `document.body` otherwise, as before. The browser paints nothing outside a full-screen element, so before this a dialog opened there was invisible while it still held focus and scroll lock. `Modal` takes a new optional `container` prop to choose the element itself (`null` forces `document.body`), and the package exports `useFullscreenElement()`, the hook behind the default.
