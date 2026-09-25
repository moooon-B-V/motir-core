---
'@motir/design-system': minor
---

`Textarea` gains OPT-IN auto-grow. Pass `autoGrow` and `rows` becomes the
MINIMUM height: the field grows with its content, line by line, up to `maxRows`,
then stops and scrolls inside itself. A chat composer passes `rows={1}`. The
height follows the value whoever changes it — typing, a paste, a controlled value
set by the parent — and the field's own width, since wrapping changes with width;
the measurement runs at layout-effect timing, so a field mounted with a
pre-filled value paints at its final height instead of flashing one line. Line
height, padding and border are read from the computed style rather than assumed,
so the clamp stays exact under every palette, type scale and density. With
`autoGrow` the manual resize handle is dropped (`resize-none`), because a
hand-dragged height is overwritten by the next keystroke's measurement.

Every current caller is unchanged: without `autoGrow` the field renders exactly
as before, fixed at `rows` with `resize-y`. The forwarded ref still reaches the
`<textarea>`, and a caller's own `onInput` is called through rather than replaced
(MOTIR-6237).
