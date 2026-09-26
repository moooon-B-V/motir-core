---
'@motir/design-system': minor
---

`Combobox` options gain an optional `description`: a one-line explanation drawn
UNDER the option's label in the menu row, and never in the trigger, which keeps
showing the label alone. The workspace role picker uses it to say what each role
does without squeezing that sentence into a narrow trigger, which is what the
inline `secondary` text would have done. The accessible name stays `label`, and
every current caller is unchanged: an option without a `description` renders
exactly as before (MOTIR-6465).
