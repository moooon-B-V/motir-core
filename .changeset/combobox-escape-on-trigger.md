---
'@motir/design-system': patch
---

`Combobox` closes on Escape while focus is still on its trigger. The open menu takes focus from a `setTimeout(0)`, and Escape was handled only by the menu, so an Escape pressed before that timer fired was ignored: the menu stayed open, and the next click on the trigger toggled it shut. The trigger now closes an open menu on Escape and keeps focus where it is (MOTIR-7345).
